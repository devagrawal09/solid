//! Per-module facts about COMPILED output, for the capability linker's
//! feature slicing (documentation/plans/core-runtime-slicing.md, "What the
//! linker must prove, per switch", and migration step 5).
//!
//! `summarize_capabilities` reads the authored source, where a module that
//! names a block API may still have every body lowered to plain calls.
//! `summarize_compiled` reads what the bundler will actually include — the
//! module after every transform — and reports, as JSON:
//!
//! - `uses`: per import source, the imported names the output references
//!   (an import left unreferenced by lowering is not a use; a referenced
//!   namespace import, or `export *`, is `"*"`; re-exports count);
//! - `creates`: the creation kinds the output calls (`signal`, `memo`,
//!   `store`, `projection`, `optimistic`, `optimisticStore`, `effect`) —
//!   the runtime face of the v2 `CreateOp` kinds;
//! - `storeReads`: calls of the store / path readers (`readStore`,
//!   `readPath*`, `readHandle*`, `readBorrowed`, `readProp`);
//! - `residualGenerators`: generator functions left in the output (bodies the
//!   compiler could not lower, and hand-written generators), with the number
//!   of `yield*` delegations each contains, and `delegations` (their total):
//!   a `yield*` may iterate an accessor, the one runtime use of the
//!   accessor iterator (`ITERABLE`);
//! - `seams`: the compiled seams the output requests from the core
//!   (`COMPILED_SEAMS`): `statusFree` (noThrow + sync), `isEqual` (memo
//!   fusion's effect cut-off), a `noThrow` option key, or effect options that
//!   carry — or may carry — `equals`.
//!
//! Every fact is syntactic over the output and conservative in the direction
//! that keeps a feature on.
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, Function, ImportDeclarationSpecifier, ImportOrExportKind,
    ObjectPropertyKind, PropertyKey, Statement, YieldExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::scope::ScopeFlags;

use crate::capabilities::JsonWriter;
use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;

/// Modules whose named exports are the reactive runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

fn create_kind(name: &str) -> Option<&'static str> {
    Some(match name {
        "createSignal" | "$signal" => "signal",
        "createMemo" | "$memo" | "generatorMemo" => "memo",
        "createStore" | "createPlainStore" | "$store" | "createStoreHandle" | "storeHandle" => {
            "store"
        }
        "createDerivedStore" | "createProjection" => "projection",
        "createOptimistic" => "optimistic",
        "createOptimisticStore" => "optimisticStore",
        "createEffect"
        | "createRenderEffect"
        | "createTrackedEffect"
        | "$effect"
        | "effectBlock"
        | "effectBlockCompiled"
        | "generatorEffect" => "effect",
        _ => return None,
    })
}

fn is_store_reader(name: &str) -> bool {
    name == "readStore"
        || name == "readBorrowed"
        || name == "readProp"
        || name == "readHandleChild"
        || name.starts_with("readPath")
        || name.starts_with("readHandle")
}

fn is_effect_host(name: &str) -> bool {
    matches!(name, "createEffect" | "createRenderEffect")
}

pub fn summarize_compiled(source: &str, filename: Option<&str>) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    // Compiled output is plain ES (JSX and types are gone); parse it as the
    // module's own dialect first, then as a plain module.
    let program = match source_type_for_filename(filename)
        .and_then(|source_type| parse_program(&allocator, source, source_type))
    {
        Ok(program) => program,
        Err(_) => parse_program(&allocator, source, SourceType::mjs())?,
    };
    let semantic = SemanticBuilder::new().build(&program).semantic;
    let scoping = semantic.scoping();

    // (local symbol, source, imported name)
    let mut imports: Vec<(SymbolId, String, String)> = Vec::new();
    // (source, name) uses, in first-seen order.
    let mut uses: Vec<(String, Vec<String>)> = Vec::new();
    let mut use_name = |source: &str, name: &str| {
        let entry = match uses.iter_mut().position(|(s, _)| s == source) {
            Some(i) => &mut uses[i],
            None => {
                uses.push((source.to_string(), Vec::new()));
                uses.last_mut().unwrap()
            }
        };
        if !entry.1.iter().any(|n| n == name) {
            entry.1.push(name.to_string());
        }
    };
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                let source = import.source.value.as_str();
                let Some(specifiers) = &import.specifiers else {
                    continue;
                };
                for specifier in specifiers {
                    let (imported, local) = match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(s) => {
                            if s.import_kind == ImportOrExportKind::Type {
                                continue;
                            }
                            (s.imported.name().to_string(), &s.local)
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                            ("default".into(), &s.local)
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                            ("*".into(), &s.local)
                        }
                    };
                    let Some(symbol) = local.symbol_id.get() else {
                        continue;
                    };
                    if scoping
                        .get_resolved_reference_ids(symbol)
                        .iter()
                        .next()
                        .is_some()
                    {
                        use_name(source, &imported);
                    }
                    imports.push((symbol, source.to_string(), imported));
                }
            }
            Statement::ExportFromDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                let source = export.source.value.as_str();
                for specifier in &export.specifiers {
                    if specifier.export_kind != ImportOrExportKind::Type {
                        use_name(source, &specifier.local.name().to_string());
                    }
                }
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind != ImportOrExportKind::Type {
                    use_name(export.source.value.as_str(), "*");
                }
            }
            _ => {}
        }
    }

    let mut facts = Facts {
        scoping,
        source,
        imports: &imports,
        creates: Vec::new(),
        store_reads: 0,
        generators: Vec::new(),
        open_generators: Vec::new(),
        delegations: 0,
        seams: Vec::new(),
    };
    facts.visit_program(&program);
    for (_, source, imported) in &imports {
        if RUNTIME_SOURCES.contains(&source.as_str())
            && (imported == "statusFree" || imported == "isEqual")
            && uses
                .iter()
                .any(|(s, names)| s == source && names.iter().any(|n| n == imported))
        {
            facts.seam(imported);
        }
    }

    let mut json = JsonWriter::default();
    json.begin_object();
    json.key("schema");
    json.number(1);
    json.key("uses");
    json.begin_array();
    for (source, names) in &uses {
        json.begin_object();
        json.key("source");
        json.string(source);
        json.key("names");
        json.begin_array();
        for name in names {
            json.string(name);
        }
        json.end_array();
        json.end_object();
    }
    json.end_array();
    json.key("creates");
    json.begin_object();
    for (kind, count) in &facts.creates {
        json.key(kind);
        json.number(*count);
    }
    json.end_object();
    json.key("storeReads");
    json.number(facts.store_reads);
    json.key("residualGenerators");
    json.begin_array();
    for (line, delegations) in &facts.generators {
        json.begin_object();
        json.key("line");
        json.number(*line as u64);
        json.key("delegations");
        json.number(*delegations);
        json.end_object();
    }
    json.end_array();
    json.key("delegations");
    json.number(facts.delegations);
    json.key("seams");
    json.begin_array();
    for seam in &facts.seams {
        json.string(seam);
    }
    json.end_array();
    json.end_object();
    Ok(json.out)
}

struct Facts<'s, 'i> {
    scoping: &'s Scoping,
    source: &'s str,
    imports: &'i [(SymbolId, String, String)],
    creates: Vec<(&'static str, u64)>,
    store_reads: u64,
    /// (line, delegations) per residual generator function.
    generators: Vec<(usize, u64)>,
    /// Indices into `generators` of the generator functions being visited.
    open_generators: Vec<usize>,
    delegations: u64,
    seams: Vec<String>,
}

impl Facts<'_, '_> {
    fn runtime_name(&self, callee: &Expression<'_>) -> Option<&str> {
        let Expression::Identifier(identifier) = callee else {
            return None;
        };
        let symbol = identifier
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())?;
        self.imports
            .iter()
            .find(|(s, source, _)| *s == symbol && RUNTIME_SOURCES.contains(&source.as_str()))
            .map(|(_, _, imported)| imported.as_str())
    }

    fn seam(&mut self, name: &str) {
        if !self.seams.iter().any(|s| s == name) {
            self.seams.push(name.to_string());
        }
    }

    fn line(&self, start: u32) -> usize {
        self.source[..(start as usize).min(self.source.len())]
            .matches('\n')
            .count()
            + 1
    }
}

impl<'a> Visit<'a> for Facts<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(name) = self.runtime_name(&call.callee) {
            let name = name.to_string();
            if let Some(kind) = create_kind(&name) {
                match self.creates.iter_mut().find(|(k, _)| *k == kind) {
                    Some((_, count)) => *count += 1,
                    None => self.creates.push((kind, 1)),
                }
            }
            if is_store_reader(&name) {
                self.store_reads += 1;
            }
            // Effect options that carry — or may carry — `equals` (the
            // effect cut-off is a compiled seam; a memo's `equals` is not).
            if is_effect_host(&name) {
                match call.arguments.get(2) {
                    None => {}
                    Some(Argument::ObjectExpression(object)) => {
                        let equals = object.properties.iter().any(|property| match property {
                            ObjectPropertyKind::ObjectProperty(p) => {
                                p.key.static_name().is_none_or(|n| n == "equals")
                            }
                            ObjectPropertyKind::SpreadProperty(_) => true,
                        });
                        if equals {
                            self.seam("effectEquals");
                        }
                    }
                    Some(_) => self.seam("effectEquals"),
                }
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_property_key(&mut self, key: &PropertyKey<'a>) {
        if key.static_name().is_some_and(|n| n == "noThrow") {
            self.seam("noThrow");
        }
        walk::walk_property_key(self, key);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if function.generator {
            let line = self.line(function.span().start);
            self.generators.push((line, 0));
            self.open_generators.push(self.generators.len() - 1);
            walk::walk_function(self, function, flags);
            self.open_generators.pop();
        } else {
            // A nested plain function's `yield*` cannot exist; keep the
            // enclosing generator's count exact by hiding it.
            let saved = std::mem::take(&mut self.open_generators);
            walk::walk_function(self, function, flags);
            self.open_generators = saved;
        }
    }

    fn visit_yield_expression(&mut self, expression: &YieldExpression<'a>) {
        if expression.delegate {
            self.delegations += 1;
            if let Some(&index) = self.open_generators.last() {
                self.generators[index].1 += 1;
            }
        }
        walk::walk_yield_expression(self, expression);
    }
}

#[cfg(test)]
mod tests {
    use super::summarize_compiled;

    fn facts(code: &str) -> String {
        summarize_compiled(code, Some("module.js")).unwrap()
    }

    #[test]
    fn reports_referenced_runtime_uses_and_creations() {
        let out = facts(
            r#"
import { createSignal, createStore, $store, perform as _$perform } from "solid-js";
import { insert } from "@solidjs/web";
const [a] = createSignal(0);
const [s] = _$perform($store({}));
insert(document.body, a);
export { mapArray } from "solid-js";
"#,
        );
        assert!(
            out.contains(
                r#"{"source":"solid-js","names":["createSignal","$store","perform","mapArray"]}"#
            ),
            "{out}"
        );
        assert!(
            out.contains(r#"{"source":"@solidjs/web","names":["insert"]}"#),
            "{out}"
        );
        assert!(out.contains(r#""creates":{"signal":1,"store":1}"#), "{out}");
        assert!(out.contains(r#""residualGenerators":[]"#), "{out}");
        assert!(out.contains(r#""delegations":0"#), "{out}");
    }

    #[test]
    fn counts_residual_generators_and_their_delegations() {
        let out = facts(
            r#"
import { $event, $ as _$$, attempt, createMemo } from "solid-js";
function* helper() { const v = yield* Ctx; return v; }
const save = action(function* () { yield fetch("/x"); });
const click = $event(_$$(function* () { yield* attempt(() => go()); yield* count; }));
const m = createMemo(() => 1);
"#,
        );
        assert!(
            out.contains(r#""residualGenerators":[{"line":3,"delegations":1},{"line":4,"delegations":0},{"line":5,"delegations":2}]"#),
            "{out}"
        );
        assert!(out.contains(r#""delegations":3"#), "{out}");
        assert!(out.contains(r#""creates":{"memo":1}"#), "{out}");
    }

    #[test]
    fn reports_compiled_seams() {
        let plain = facts(
            r#"
import { createMemo, createEffect } from "solid-js";
const m = createMemo(() => 1, { equals: false });
createEffect(() => m(), v => log(v));
"#,
        );
        assert!(plain.contains(r#""seams":[]"#), "{plain}");
        let fused = facts(
            r#"
import { createEffect, isEqual as _$isEqual, statusFree as _$statusFree, createMemo } from "solid-js";
const m = createMemo(() => 1, _$statusFree);
createEffect(() => m(), v => log(v), { equals: _$isEqual });
"#,
        );
        assert!(
            fused.contains(r#""seams":["effectEquals","isEqual","statusFree"]"#),
            "{fused}"
        );
        let hand = facts(
            r#"
import { createMemo, createRenderEffect } from "@solidjs/signals";
const m = createMemo(() => 1, { sync: true, noThrow: true });
createRenderEffect(() => m(), v => log(v), options);
"#,
        );
        assert!(
            hand.contains(r#""seams":["noThrow","effectEquals"]"#),
            "{hand}"
        );
    }

    #[test]
    fn unreferenced_imports_are_not_uses() {
        let out = facts(
            r#"
import { $store, createStore, readPath1 as _$readPath1 } from "solid-js";
export const title = props => _$readPath1(props, "title");
"#,
        );
        assert!(
            out.contains(r#"{"source":"solid-js","names":["readPath1"]}"#),
            "{out}"
        );
        assert!(out.contains(r#""storeReads":1"#), "{out}");
        assert!(out.contains(r#""creates":{}"#), "{out}");
    }
}
