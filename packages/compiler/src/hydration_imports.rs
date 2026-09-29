//! Hydrating builds: primitives and block constructors imported straight from
//! `@solidjs/signals` are re-sourced to `solid-js`.
//!
//! `solid-js` re-exports these names with hydration-aware implementations
//! (they claim server-rendered state and serialized values); the
//! `@solidjs/signals` originals are the plain core. A hydrating app that
//! imports one from the low-level package would silently skip hydration for
//! everything it creates — and the v2 lowering imports the primitives it
//! fuses to from the module the constructor came from, which would carry the
//! wrong source into compiled output. Every other `@solidjs/signals` import
//! is left alone.
use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Program, Statement};
use oxc_span::Span;

use crate::shared::ast_builder::AstBuilder;

fn ast(allocator: &Allocator) -> AstBuilder<'_> {
    AstBuilder::new(allocator)
}

const SIGNALS: &str = "@solidjs/signals";
const SOLID: &str = "solid-js";

/// Names `solid-js` overrides with hydration-aware implementations.
const HYDRATION_AWARE: &[&str] = &[
    "$effect",
    "$memo",
    "$settled",
    "$signal",
    "$store",
    "createDerivedStore",
    "createEffect",
    "createErrorBoundary",
    "createLoadingBoundary",
    "createMemo",
    "createOptimistic",
    "createOptimisticStore",
    "createProjection",
    "createRenderEffect",
    "createRevealOrder",
    "createSignal",
    "createStore",
    "effectBlock",
    "effectBlockCompiled",
    "settledBlock",
];

fn moves(specifier: &ImportDeclarationSpecifier<'_>) -> bool {
    let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
        return false;
    };
    if specifier.import_kind == ImportOrExportKind::Type {
        return false;
    }
    let name = match &specifier.imported {
        ModuleExportName::IdentifierName(name) => name.name.as_str(),
        ModuleExportName::IdentifierReference(name) => name.name.as_str(),
        ModuleExportName::StringLiteral(name) => name.value.as_str(),
    };
    HYDRATION_AWARE.contains(&name)
}

/// Re-source hydration-aware imports from `@solidjs/signals` to `solid-js`.
/// Returns whether anything moved.
pub(crate) fn resource_hydration_imports<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> bool {
    let ast = ast(allocator);
    let mut changed = false;
    let mut index = 0;
    while index < program.body.len() {
        let Statement::ImportDeclaration(import) = &mut program.body[index] else {
            index += 1;
            continue;
        };
        if import.source.value.as_str() != SIGNALS || import.import_kind == ImportOrExportKind::Type {
            index += 1;
            continue;
        }
        let Some(specifiers) = import.specifiers.as_mut() else {
            index += 1;
            continue;
        };
        if !specifiers.iter().any(moves) {
            index += 1;
            continue;
        }
        changed = true;
        if specifiers.iter().all(moves) {
            // The whole declaration moves: keep it, change its source.
            import.source = ast.string_literal(import.source.span, ast.str(SOLID), None);
            index += 1;
            continue;
        }
        let taken = std::mem::replace(specifiers, ast.vec());
        let mut moved = ast.vec();
        for specifier in taken {
            if moves(&specifier) {
                moved.push(specifier);
            } else {
                specifiers.push(specifier);
            }
        }
        let span = Span::new(0, 0);
        let statement = Statement::ImportDeclaration(ast.alloc_import_declaration(
            span,
            Some(moved),
            ast.string_literal(span, ast.str(SOLID), None),
            None,
            None,
            ImportOrExportKind::Value,
        ));
        program.body.insert(index + 1, statement);
        index += 2;
    }
    changed
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn out(source: &str, hydratable: bool) -> String {
        compile(
            source,
            &CompileOptions {
                generate: Generate::Dom,
                hydratable,
                ..CompileOptions::default()
            },
        )
        .unwrap()
        .code
    }

    #[test]
    fn hydrating_builds_import_hydration_aware_names_from_solid_js() {
        let source = r#"import { createMemo, $memo, flush, type Accessor } from "@solidjs/signals";
export const m = createMemo(() => 1);
export const f = () => flush();
"#;
        let hydrated = out(source, true);
        assert!(hydrated.contains(r#"import { flush, type Accessor } from "@solidjs/signals";"#) || hydrated.contains(r#"import { flush } from "@solidjs/signals";"#), "{hydrated}");
        assert!(hydrated.contains(r#"import { createMemo, $memo } from "solid-js";"#), "{hydrated}");
        // Client-only builds keep the low-level import.
        let client = out(source, false);
        assert!(!client.contains("solid-js"), "{client}");
    }

    #[test]
    fn a_declaration_of_only_hydration_aware_names_changes_source() {
        let hydrated = out(
            r#"import { $signal, $component } from "@solidjs/signals";
import { $signal as s } from "@solidjs/signals";
export const x = s;
"#,
            true,
        );
        // `$component` is not overridden: that declaration splits.
        assert!(hydrated.contains(r#"import { $component } from "@solidjs/signals";"#), "{hydrated}");
        assert!(hydrated.contains(r#"import { $signal as s } from "solid-js";"#), "{hydrated}");
    }
}
