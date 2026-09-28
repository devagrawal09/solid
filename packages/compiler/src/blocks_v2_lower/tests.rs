use crate::{CompileOptions, Generate, compile};

fn compile_with(source: &str, options: CompileOptions) -> String {
    match compile(source, &options) {
        Ok(output) => output.code,
        Err(error) => panic!("{error}"),
    }
}

fn dom(source: &str) -> String {
    compile_with(source, CompileOptions::default())
}

fn flat(code: &str) -> String {
    code.split_whitespace().collect::<Vec<_>>().join(" ")
}

const APP: &str = r#"import { $component, $signal, $store, $memo, $effect, $event, $cleanup, $flush } from "solid-js";
export const App = $component(function* (props) {
  const [count, setCount] = yield* $signal(0);
  const [state, setState] = yield* $store({ items: [] });
  const doubled = yield* $memo(function* () { return (yield* count) * 2; });
  yield* $effect(function* () {
    const c = yield* count;
    document.title = "n " + c;
    yield* $cleanup(() => { document.title = ""; });
  });
  yield* $cleanup(() => log("bye"));
  const inc = $event(function* () {
    yield* setCount((yield* count) + 1);
    setState(s => { s.items.push(1); });
    yield* $flush();
  });
  return function* () { return <button onClick={inc}>{yield* doubled}{yield* props.label}</button>; };
});
"#;

#[test]
fn a_fully_lowered_component_is_plain_solid() {
    let out = dom(APP);
    let flat = flat(&out);
    // The setup is erased: a plain function under `$componentCompiled`,
    // with PROPS_COMPILED (props only reach lowered path reads).
    assert!(
        flat.contains("const App = _$$componentCompiled(function(props) {"),
        "{out}"
    );
    assert!(flat.contains("}, 1); }, 1);"), "{out}");
    // Creations are direct primitive calls (non-escaping setters).
    assert!(
        flat.contains("const [count, setCount] = _$createSignal(0);"),
        "{out}"
    );
    assert!(
        flat.contains("const [state, setState] = _$plainStore({ items: [] });"),
        "{out}"
    );
    assert!(
        flat.contains("const doubled = _$createMemo(function() {"),
        "{out}"
    );
    // The effect half is fused: its `$cleanup` is its returned cleanup.
    assert!(
        flat.contains(
            "_$createEffect(function() { return [count()]; }, function(_$v) { const c = _$v[0];"
        ),
        "{out}"
    );
    assert!(
        flat.contains(
            "const _$cleanup0 = () => { document.title = \"\"; }; return _$cleanup0; });"
        ),
        "{out}"
    );
    // A setup `$cleanup` registers directly.
    assert!(
        flat.contains("_$blockCleanup(() => log(\"bye\"));"),
        "{out}"
    );
    // The event is erased: reads are direct, writes plain calls, `$flush` is `flush`.
    assert!(
        flat.contains(
            "const inc = _$$eventCompiled(function() { setCount(count() + 1); setState((s) => { s.items.push(1); }); _$flush(); });"
        ),
        "{out}"
    );
    // Every remaining block is lowered and SYNC: no driver.
    assert!(flat.contains("syncBlock as _$$"), "{out}");
    assert!(!flat.contains(" $ as _$$"), "{out}");
    assert!(!out.contains("_$perform"), "{out}");
    assert!(!out.contains("_$withReceipts"), "{out}");
    for imported in [
        "createSignal as _$createSignal",
        "createPlainStore as _$plainStore",
        "createMemo as _$createMemo",
        "createEffect as _$createEffect",
        "blockCleanup as _$blockCleanup",
        "flush as _$flush",
        "$componentCompiled as _$$componentCompiled",
        "$eventCompiled as _$$eventCompiled",
    ] {
        assert!(out.contains(imported), "{imported}: {out}");
    }
    // The primitives come from the module the constructors came from.
    let signals = dom(&APP.replace("\"solid-js\"", "\"@solidjs/signals\""));
    assert!(
        signals.contains("createSignal as _$createSignal")
            && !signals.contains("from \"solid-js\""),
        "{signals}"
    );
}

#[test]
fn escaping_setters_keep_their_receipts() {
    let out = dom(r#"import { $component, $signal, $event, raise } from "solid-js";
export const C = $component(function* () {
  const [a, setA] = yield* $signal(0);
  const [b, setB] = yield* $signal(0);
  const [c, setC] = yield* $signal(0);
  const [d, setD] = yield* $signal(0);
  const read = $event(function* () { const next = yield* setA(1); log(next); });
  const receipts = $event(function* (e) {
    log(yield* setB(2));
    yield* setB(3);
    if (e.fail) yield* raise(new Error("no"));
  });
  const concise = () => setB(1);
  const forward = { set: setC };
  const statement = () => { setD(1); };
  return function* () { return <i onClick={read}>{yield* a}{yield* b}{yield* c}{yield* d}</i>; };
});
"#);
    let flat = flat(&out);
    // `yield* setA(1)`'s value is read: the plain setter returns the value
    // the receipt carries, so the perform is dropped.
    assert!(
        flat.contains("const [a, setA] = _$createSignal(0);"),
        "{out}"
    );
    assert!(flat.contains("const next = setA(1);"), "{out}");
    // A concise arrow returns the receipt; a forwarded setter may be `yield*`ed.
    assert!(
        flat.contains("const [b, setB] = _$withReceipts(_$createSignal(0));"),
        "{out}"
    );
    assert!(
        flat.contains("const [c, setC] = _$withReceipts(_$createSignal(0));"),
        "{out}"
    );
    // A statement call discards the result.
    assert!(
        flat.contains("const [d, setD] = _$createSignal(0);"),
        "{out}"
    );
    // A receipt's value is read directly (`perform` returns it before any
    // host check), and a raised error in statement position is a `throw`:
    // the event has no operation left and is erased.
    assert!(
        flat.contains(
            "const receipts = _$$eventCompiled(function(e) { log(setB(2).value); setB(3); if (e.fail) throw new Error(\"no\"); });"
        ),
        "{out}"
    );
}

#[test]
fn unproven_operations_keep_their_blocks() {
    let out = dom(
        r#"import { $component, $signal, $effect, $event, $cleanup, attempt } from "solid-js";
import { Theme } from "./theme";
export const C = $component(function* () {
  const theme = yield* Theme;
  const [n, setN] = yield* $signal(0);
  yield* $effect(function* () {
    const v = yield* n;
    if (v > 1) yield* $cleanup(() => log(v));
  });
  yield* $effect(function* () {
    const v = yield* n;
    yield* $cleanup(() => log(1));
    yield* $cleanup(() => log(2));
  });
  const save = $event(function* () { const r = yield* attempt(() => fetch("/x")); setN(r); });
  return function* () { return <i onClick={save}>{theme}{yield* n}</i>; };
});
"#,
    );
    let flat = flat(&out);
    // A context read stays with `perform`, so the setup keeps its block (its
    // creations are still direct).
    assert!(
        flat.contains(
            "export const C = _$$componentCompiled(_$$(function() { const theme = _$perform(Theme);"
        ),
        "{out}"
    );
    assert!(
        flat.contains("const [n, setN] = _$createSignal(0);"),
        "{out}"
    );
    // A conditional `$cleanup` keeps the half a block (compiled entry).
    assert!(
        flat.contains(
            "_$effectBlockCompiled(_$$(function(_$v) { const v = _$v[0]; if (v > 1) _$blockCleanup(() => log(v)); }, 1), function() { return [n()]; });"
        ),
        "{out}"
    );
    // Two top-level cleanups: returned as one function running both.
    assert!(
        flat.contains(
            "const _$cleanup0 = () => log(1); const _$cleanup1 = () => log(2); return () => { _$cleanup0(); _$cleanup1(); }; });"
        ),
        "{out}"
    );
    // An async event stays with the driver: the module keeps `$`.
    assert!(
        flat.contains("const save = _$$eventCompiled(_$$(function* () {"),
        "{out}"
    );
    assert!(flat.contains("$ as _$$"), "{out}");
    assert!(!flat.contains("syncBlock"), "{out}");
}

#[test]
fn opting_out_and_server_output_keep_the_lowering() {
    let off = compile_with(
        APP,
        CompileOptions {
            v2_fusion: false,
            ..CompileOptions::default()
        },
    );
    assert!(off.contains("_$perform($signal(0))"), "{off}");
    assert!(off.contains("$component(_$$(function(props)"), "{off}");
    assert!(!off.contains("Compiled"), "{off}");

    // SSR: the v2 fusion runs (the same blocks fuse on every generate), the
    // client lowering does not.
    let ssr = compile_with(
        APP,
        CompileOptions {
            generate: Generate::Ssr,
            ..CompileOptions::default()
        },
    );
    assert!(ssr.contains("_$perform($signal(0))"), "{ssr}");
    assert!(
        ssr.contains("const doubled = _$createMemo(function() {"),
        "{ssr}"
    );
    assert!(
        !ssr.contains("Compiled") && !ssr.contains("syncBlock"),
        "{ssr}"
    );
}

#[test]
fn plain_hosts_and_settled_bodies_use_compiled_entries() {
    let out = dom(
        r#"import { createEffect, createMemo, createSignal, onSettled, $cleanup } from "solid-js";
const [n] = createSignal(0);
createEffect(function* () { log(yield* n); yield* $cleanup(() => log(0)); });
onSettled(function* () { yield* $cleanup(() => log(1)); });
export const m = createMemo(function* () { return (yield* n) + 1; });
"#,
    );
    let flat = flat(&out);
    // `createEffect(function* …)`: a fused half, created with `createEffect`.
    assert!(
        flat.contains(
            "_$createEffect(function() { return [n()]; }, function(_$v) { log(_$v[0]); const _$cleanup0 = () => log(0); return _$cleanup0; });"
        ),
        "{out}"
    );
    assert!(
        flat.contains(
            "_$settledBlockCompiled(_$$(function() { _$blockCleanup(() => log(1)); }, 1));"
        ),
        "{out}"
    );
    assert!(flat.contains("syncBlock as _$$"), "{out}");
}

#[test]
fn store_forms_and_lowered_stores_share_a_module() {
    // `store_forms` names its plain store `_$createPlainStore`; the lowered
    // `$store` must not collide with it.
    let out = dom(r#"import { $component, $store, createStore } from "solid-js";
const [shared] = createStore({ n: 1 });
export const C = $component(function* () {
  const [s, setS] = yield* $store({ n: 2 });
  return function* () { return <i>{yield* s.n}{yield* shared.n}</i>; };
});
"#);
    assert!(out.contains("_$plainStore({ n: 2 })"), "{out}");
    assert!(out.contains("_$createPlainStore({ n: 1 })"), "{out}");
    assert_eq!(out.matches("as _$plainStore").count(), 1, "{out}");
    assert_eq!(out.matches("as _$createPlainStore").count(), 1, "{out}");
}
