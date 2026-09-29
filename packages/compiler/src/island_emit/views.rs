//! View reads bound to a local → reads at their sites, a source pre-pass.
//!
//! A view generator often names a read once before its `return`:
//!
//! ```text
//! return function* () {
//!   const item = yield* story;
//!   return <h1>{item.title}</h1>;
//! };
//! ```
//!
//! The island compiler addresses every read by its site, so such a
//! statement is rewritten to the read at each place the local is used
//! (`<h1>{(yield* story).title}</h1>`), the way the view would be written
//! without it. In one render both forms read the same value; the rewritten
//! one only subscribes each hole on its own. The statement qualifies when:
//!
//! - it is `const x = yield* e;` with one plain identifier `x`, in a
//!   generator that is returned by a generator (a view), before its final
//!   `return`;
//! - `e` is an identifier or a chain of static member accesses on one (a
//!   memo, a prop, a cell getter: no call, nothing that runs code);
//! - nothing inside the view declares a name `e` uses (so `e` means the same
//!   thing at every site), and no use of `x` is a shorthand property.
//!
//! Anything else is left as written (a view statement the analysis handles
//! or refuses with its reason).
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{BindingPattern, Expression, Function, Statement, VariableDeclarationKind};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{ScopeFlags, SemanticBuilder};
use oxc_span::{GetSpan, Span};

use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// The rewritten source, or `None` when nothing was rewritten.
pub(crate) fn inline_view_reads(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("function*") || !source.contains("= yield*") {
        return None;
    }
    let mut src = source.to_string();
    let mut changed = false;
    // One statement per pass (a later statement may read an earlier local).
    for _ in 0..256 {
        match inline_one(&src, filename) {
            Some(next) => {
                src = next;
                changed = true;
            }
            None => break,
        }
    }
    changed.then_some(src)
}

/// An identifier or a static member chain on one; its identifier names.
fn plain_read<'b>(e: &'b Expression<'_>, names: &mut Vec<&'b str>) -> bool {
    match e.without_parentheses() {
        Expression::Identifier(id) => {
            names.push(id.name.as_str());
            true
        }
        Expression::StaticMemberExpression(s) => !s.optional && plain_read(&s.object, names),
        _ => false,
    }
}

fn inline_one(source: &str, filename: Option<&str>) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    // Views: generator functions returned by a generator function.
    struct V<'a> {
        views: Vec<&'a Function<'a>>,
        gens: Vec<bool>,
    }
    impl<'a> Visit<'a> for V<'a> {
        fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
            self.gens.push(f.generator);
            walk::walk_function(self, f, flags);
            self.gens.pop();
        }
        fn visit_return_statement(&mut self, r: &oxc_ast::ast::ReturnStatement<'a>) {
            if self.gens.last() == Some(&true)
                && let Some(Expression::FunctionExpression(f)) =
                    r.argument.as_ref().map(|a| a.without_parentheses())
                && f.generator
            {
                let f: &'a Function<'a> = unsafe { &*(&**f as *const Function<'a>) };
                self.views.push(f);
            }
            walk::walk_return_statement(self, r);
        }
        fn visit_arrow_function_expression(
            &mut self,
            a: &oxc_ast::ast::ArrowFunctionExpression<'a>,
        ) {
            self.gens.push(false);
            walk::walk_arrow_function_expression(self, a);
            self.gens.pop();
        }
    }
    let mut v = V {
        views: Vec::new(),
        gens: Vec::new(),
    };
    v.visit_program(&program);
    for f in v.views {
        let Some(body) = f.body.as_ref() else {
            continue;
        };
        let stmts = &body.statements;
        if !matches!(stmts.last(), Some(Statement::ReturnStatement(_))) {
            continue;
        }
        let fspan = f.span;
        for s in &stmts[..stmts.len() - 1] {
            let Statement::VariableDeclaration(d) = s else {
                continue;
            };
            if d.kind != VariableDeclarationKind::Const || d.declarations.len() != 1 {
                continue;
            }
            let decl = &d.declarations[0];
            let BindingPattern::BindingIdentifier(id) = &decl.id else {
                continue;
            };
            let Some(sym) = id.symbol_id.get() else {
                continue;
            };
            let Some(Expression::YieldExpression(y)) =
                decl.init.as_ref().map(|e| e.without_parentheses())
            else {
                continue;
            };
            let Some(arg) = y.argument.as_ref() else {
                continue;
            };
            let mut names = Vec::new();
            if !y.delegate || !plain_read(arg, &mut names) {
                continue;
            }
            // `e` means the same thing everywhere in the view.
            let shadowed = scoping.symbol_ids().any(|x| {
                let sp = scoping.symbol_span(x);
                fspan.start <= sp.start
                    && sp.end <= fspan.end
                    && names.contains(&scoping.symbol_name(x))
            });
            if shadowed {
                continue;
            }
            let read = format!(
                "(yield* {})",
                &source[arg.span().start as usize..arg.span().end as usize]
            );
            let mut edits: Vec<(Span, String)> = Vec::new();
            let mut ok = true;
            for r in scoping.get_resolved_references(sym) {
                let node = r.node_id();
                let sp = nodes.get_node(node).kind().span();
                if r.is_write() || !(fspan.start <= sp.start && sp.end <= fspan.end) {
                    ok = false;
                    break;
                }
                if let AstKind::ObjectProperty(p) = nodes.get_node(nodes.parent_id(node)).kind()
                    && p.shorthand
                {
                    ok = false;
                    break;
                }
                edits.push((sp, read.clone()));
            }
            if !ok {
                continue;
            }
            // Drop the statement with its line.
            let mut start = s.span().start as usize;
            let mut end = s.span().end as usize;
            let bytes = source.as_bytes();
            while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
                start -= 1;
            }
            if end < bytes.len() && bytes[end] == b'\n' {
                end += 1;
            }
            edits.push((Span::new(start as u32, end as u32), String::new()));
            return Some(splice(source, Span::new(0, source.len() as u32), edits));
        }
    }
    None
}
