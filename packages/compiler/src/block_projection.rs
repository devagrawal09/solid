//! Typecheck projection for the direct property syntax inside `$` blocks.
//!
//! Stock TypeScript types `yield* e` from the *value type* of `e`: for
//! `yield* store.user.name` that is `string` (iterated as characters, result
//! `void`), for `yield* props.count` a TS2488 error. The source spelling is
//! therefore only checkable through a pre-typecheck projection: this pass
//! rewrites each supported member-chain operand to the operation the
//! compiler lowers it to —
//!
//! ```text
//! yield* store.items[i].name   →   yield* __solid_readPath(store, ["items", i, "name"], store.items[i].name)
//! yield* props.count           →   yield* __solid_readProp(props, ["count"], props.count)
//! ```
//!
//! — and adds the corresponding import. `readPath` / `readProp` are typed
//! `StoreRead<Root, Path>` / `PropRead<Root, Path>` with the selected value
//! inferred by `PathValue`, so the checker sees a valid operation and the
//! block's Reads record root plus static path. The third argument is the
//! authored operand itself, kept verbatim as a *witness*: TypeScript checks
//! it as ordinary code, so a wrong key is the usual TS2339 at its authored
//! column (the runtime signature ignores it, and the compiler's lowering
//! never emits it). Nothing else changes: the output is the authored text
//! with two insertions around each operand (`__solid_readPath(root, [keys], `
//! before it and `)` after it), so every authored character — including the
//! witness — keeps a position, and the `edits` map generated offsets back to
//! source offsets (both in UTF-16 code units, TypeScript's unit) for
//! diagnostics.
//!
//! The supported chains are exactly the ones the compiler lowers
//! (`generators.rs`), so what typechecks is what runs lowered; unsupported
//! operands (optional chains, calls, computed keys other than a literal or a
//! bare identifier) are left as written and surface as ordinary TypeScript
//! errors at that `yield*` — a conservative refusal, never a partial
//! rewrite. Roots are recorded as written: an alias (`const u = store.user`)
//! is its own root of its own type. Component props are recognized
//! conservatively (the first parameter of a capitalized function); the two
//! forms differ only in the read type's brand.

use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, CallExpression, Expression, Function, Program, Statement};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;
use crate::generators::{
    RuntimeSymbols, collect_runtime_symbols, is_component_props, member_chain_keys,
    member_chain_root,
};

const READ_PATH_LOCAL: &str = "__solid_readPath";
const READ_PROP_LOCAL: &str = "__solid_readProp";

/// One splice of the projection: the authored span `[source_start,
/// source_end)` became `[generated_start, generated_end)`. Offsets are UTF-16
/// code units.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockProjectionEdit {
    pub source_start: u32,
    pub source_end: u32,
    pub generated_start: u32,
    pub generated_end: u32,
}

/// The projected module and its edit map.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockTypecheckProjection {
    pub code: String,
    pub edits: Vec<BlockProjectionEdit>,
    /// Number of `yield*` operands rewritten (0 = the code is the input).
    pub rewrites: u32,
}

struct Rewrite {
    span: Span,
    text: String,
}

/// Project `source` for typechecking. Files without a `$` import are
/// returned unchanged.
pub fn project_blocks_for_typecheck(
    source: &str,
    filename: Option<&str>,
) -> Result<BlockTypecheckProjection, CompileError> {
    let unchanged = || BlockTypecheckProjection {
        code: source.to_string(),
        edits: Vec::new(),
        rewrites: 0,
    };
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = semantic.scoping();
    let symbols = collect_runtime_symbols(&program);
    if symbols.adapter.is_empty() {
        return Ok(unchanged());
    }

    struct Collector<'s> {
        scoping: &'s oxc_semantic::Scoping,
        nodes: &'s oxc_semantic::AstNodes<'s>,
        symbols: &'s RuntimeSymbols,
        source: &'s str,
        rewrites: Vec<Rewrite>,
    }
    impl<'b> Visit<'b> for Collector<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if self.is_adapter_call(call)
                && call.arguments.len() == 1
                && let Argument::FunctionExpression(function) = &call.arguments[0]
                && function.generator
                && !function.r#async
                && let Some(body) = function.body.as_ref()
            {
                let mut yields = Yields {
                    scoping: self.scoping,
                    nodes: self.nodes,
                    source: self.source,
                    rewrites: &mut self.rewrites,
                };
                yields.visit_function_body(body);
            }
            walk::walk_call_expression(self, call);
        }
    }
    impl Collector<'_> {
        fn is_adapter_call(&self, call: &CallExpression<'_>) -> bool {
            let Expression::Identifier(callee) = &call.callee else {
                return false;
            };
            callee
                .reference_id
                .get()
                .and_then(|id| self.scoping.get_reference(id).symbol_id())
                .is_some_and(|symbol| self.symbols.adapter.contains(&symbol))
        }
    }
    /// Walks one block body; nested functions own their yields.
    struct Yields<'s> {
        scoping: &'s oxc_semantic::Scoping,
        nodes: &'s oxc_semantic::AstNodes<'s>,
        source: &'s str,
        rewrites: &'s mut Vec<Rewrite>,
    }
    impl<'b> Visit<'b> for Yields<'_> {
        fn visit_function(&mut self, _it: &Function<'b>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _it: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
        }
        fn visit_yield_expression(&mut self, it: &oxc_ast::ast::YieldExpression<'b>) {
            if it.delegate
                && let Some(operand) = it.argument.as_ref()
                && let Some(root) = member_chain_root(operand)
            {
                let prop = is_component_props(self.scoping, self.nodes, root);
                let keys = member_chain_keys(operand, self.source).join(", ");
                let span = operand.span();
                // Two insertions around the operand; the operand itself stays
                // in place as the witness argument.
                self.rewrites.push(Rewrite {
                    span: Span::new(span.start, span.start),
                    text: format!(
                        "{}({}, [{}], ",
                        if prop {
                            READ_PROP_LOCAL
                        } else {
                            READ_PATH_LOCAL
                        },
                        root.name,
                        keys
                    ),
                });
                self.rewrites.push(Rewrite {
                    span: Span::new(span.end, span.end),
                    text: ")".to_string(),
                });
            }
            walk::walk_yield_expression(self, it);
        }
    }

    let mut collector = Collector {
        scoping,
        nodes: semantic.nodes(),
        symbols: &symbols,
        source,
        rewrites: Vec::new(),
    };
    collector.visit_program(&program);
    let mut rewrites = collector.rewrites;
    if rewrites.is_empty() {
        return Ok(unchanged());
    }
    // Two insertions per rewritten operand.
    let rewrite_count = (rewrites.len() / 2) as u32;

    // The import lands right after the runtime import that provided `$`.
    if let Some((import_end, import_source)) = runtime_import_end(&program, &symbols) {
        rewrites.push(Rewrite {
            span: Span::new(import_end, import_end),
            text: format!(
                "\nimport {{ readPath as {READ_PATH_LOCAL}, readProp as {READ_PROP_LOCAL} }} from \"{import_source}\";"
            ),
        });
    }
    rewrites.sort_by_key(|rewrite| rewrite.span.start);

    // Splice, tracking UTF-16 offsets on both sides.
    let mut code = String::with_capacity(source.len() + rewrites.len() * 32);
    let mut edits = Vec::with_capacity(rewrites.len());
    let mut cursor = 0usize;
    let mut source_utf16 = 0u32;
    let mut generated_utf16 = 0u32;
    for rewrite in &rewrites {
        let start = rewrite.span.start as usize;
        let end = rewrite.span.end as usize;
        let untouched = &source[cursor..start];
        code.push_str(untouched);
        let untouched_len = utf16_len(untouched);
        source_utf16 += untouched_len;
        generated_utf16 += untouched_len;
        let replaced = &source[start..end];
        let source_start = source_utf16;
        let generated_start = generated_utf16;
        code.push_str(&rewrite.text);
        source_utf16 += utf16_len(replaced);
        generated_utf16 += utf16_len(&rewrite.text);
        edits.push(BlockProjectionEdit {
            source_start,
            source_end: source_utf16,
            generated_start,
            generated_end: generated_utf16,
        });
        cursor = end;
    }
    code.push_str(&source[cursor..]);
    Ok(BlockTypecheckProjection {
        code,
        edits,
        rewrites: rewrite_count,
    })
}

fn runtime_import_end(program: &Program<'_>, symbols: &RuntimeSymbols) -> Option<(u32, String)> {
    let span = symbols.import_span?;
    program.body.iter().find_map(|statement| match statement {
        Statement::ImportDeclaration(import) if import.span == span => {
            Some((import.span.end, import.source.value.to_string()))
        }
        _ => None,
    })
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_paths_and_maps_offsets() {
        let source = r#"import { $, createMemo } from "solid-js";
function Counter(props: { count: number }) {
  const total = createMemo($(function* () {
    const i = yield* index;
    return (yield* store.items[i].name) + (yield* props.count);
  }));
  return $(function* () { return <p>{yield* store.user.name}</p>; });
}
const optional = $(function* () { return yield* store.user?.name; });
"#;
        let output = project_blocks_for_typecheck(source, Some("counter.tsx")).unwrap();
        assert_eq!(output.rewrites, 3);
        assert!(output.code.contains(
            r#"import { $, createMemo } from "solid-js";
import { readPath as __solid_readPath, readProp as __solid_readProp } from "solid-js";"#
        ));
        assert!(output.code.contains(
            r#"(yield* __solid_readPath(store, ["items", i, "name"], store.items[i].name))"#
        ));
        assert!(
            output
                .code
                .contains(r#"(yield* __solid_readProp(props, ["count"], props.count))"#)
        );
        assert!(output.code.contains(
            r#"<p>{yield* __solid_readPath(store, ["user", "name"], store.user.name)}</p>"#
        ));
        // Refused: left as written.
        assert!(output.code.contains("yield* store.user?.name"));
        // Every edit is an insertion (empty authored span): the import, then a
        // prefix and a `)` per operand, so the witness keeps its position.
        assert_eq!(output.edits.len(), 1 + 2 * 3);
        let generated_utf16 = output.code.encode_utf16().collect::<Vec<_>>();
        for (index, edit) in output.edits.iter().enumerate() {
            assert_eq!(edit.source_start, edit.source_end);
            let generated = String::from_utf16(
                &generated_utf16[edit.generated_start as usize..edit.generated_end as usize],
            )
            .unwrap();
            match index {
                0 => assert!(generated.starts_with("\nimport {"), "{generated}"),
                i if i % 2 == 1 => assert!(generated.starts_with("__solid_read"), "{generated}"),
                _ => assert_eq!(generated, ")"),
            }
        }
        // The witness is the authored operand at a shifted position: the text
        // between a prefix and its `)` is the authored text.
        let source_utf16 = source.encode_utf16().collect::<Vec<_>>();
        let (prefix, close) = (&output.edits[1], &output.edits[2]);
        assert_eq!(
            generated_utf16[prefix.generated_end as usize..close.generated_start as usize],
            source_utf16[prefix.source_start as usize..close.source_start as usize]
        );
        assert_eq!(
            String::from_utf16(
                &source_utf16[prefix.source_start as usize..close.source_start as usize]
            )
            .unwrap(),
            "store.items[i].name"
        );
    }

    #[test]
    fn leaves_files_without_blocks_alone() {
        let source = "const a = 1;\nexport {};\n";
        let output = project_blocks_for_typecheck(source, Some("a.ts")).unwrap();
        assert_eq!(output.code, source);
        assert!(output.edits.is_empty());
    }
}
