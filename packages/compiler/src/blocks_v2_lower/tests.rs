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
        flat.contains("const [state, setState] = _$createPlainStore({ items: [] });"),
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
        "createPlainStore as _$createPlainStore",
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
    let out = dom(
        r#"import { $component, $signal, $event, raise } from "solid-js";
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
"#,
    );
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
    // An async event whose other operations are erased is an async body:
    // no block, no driver.
    assert!(
        flat.contains(
            "const save = _$$eventCompiled(_$asyncBody(async function(_$i, _$a) { try { const r = _$a.t(() => fetch(\"/x\")) ? _$a.r(await _$a.p) : _$a.v; setN(r); } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); } }));"
        ),
        "{out}"
    );
    assert!(flat.contains("syncBlock as _$$"), "{out}");
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

    // SSR: the same lowering as DOM output (hydration ids stay aligned: the
    // same blocks are erased on both sides, `block_scope.rs`).
    let ssr = compile_with(
        APP,
        CompileOptions {
            generate: Generate::Ssr,
            ..CompileOptions::default()
        },
    );
    assert!(!ssr.contains("_$perform"), "{ssr}");
    assert!(ssr.contains("_$createSignal(0)"), "{ssr}");
    assert!(
        ssr.contains("const doubled = _$createMemo(function() {"),
        "{ssr}"
    );
    assert!(ssr.contains("_$$componentCompiled("), "{ssr}");
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
    // `onSettled(function* …)`: fused like an effect half — `onSettled`
    // runs the body once and takes its cleanups as the returned cleanup.
    assert!(
        flat.contains(
            "_$onSettled(function() { const _$cleanup0 = () => log(1); return _$cleanup0; });"
        ),
        "{out}"
    );
    assert!(!flat.contains("settledBlock"), "{out}");
    // Nothing is left for a block: neither `$` nor `syncBlock`.
    assert!(!flat.contains("_$$"), "{out}");
}

#[test]
fn store_forms_and_lowered_stores_share_a_module() {
    // `store_forms` names its plain store `_$createPlainStore`; the lowered
    // `$store` must not collide with it.
    let out = dom(
        r#"import { $component, $store, createStore } from "solid-js";
const [shared] = createStore({ n: 1 });
export const C = $component(function* () {
  const [s, setS] = yield* $store({ n: 2 });
  return function* () { return <i>{yield* s.n}{yield* shared.n}</i>; };
});
"#,
    );
    // One specifier serves both: the lowered `$store` adds it, `store_forms`
    // reuses it for the plain `createStore`.
    assert!(out.contains("_$createPlainStore({ n: 2 })"), "{out}");
    assert!(out.contains("_$createPlainStore({ n: 1 })"), "{out}");
    assert_eq!(out.matches("as _$createPlainStore").count(), 1, "{out}");
    assert!(!out.contains("_$plainStore"), "{out}");
    // From another source, the plain form gets its own local.
    let mixed = dom(r#"import { $component, $store } from "@solidjs/signals";
import { createStore } from "solid-js";
const [shared] = createStore({ n: 1 });
export const C = $component(function* () {
  const [s] = yield* $store({ n: 2 });
  return function* () { return <i>{yield* s.n}{yield* shared.n}</i>; };
});
"#);
    assert!(
        mixed.contains("createPlainStore as _$createPlainStore,"),
        "{mixed}"
    );
    assert!(
        mixed.contains("createPlainStore as _$createPlainStore2"),
        "{mixed}"
    );
    assert!(mixed.contains("_$createPlainStore2({ n: 1 })"), "{mixed}");
}

const ASYNC_APP: &str = r#"import { $component, $signal, $memo, $event, $flush, attempt, raise, createContext, readStore } from "solid-js";
import { imported, NotFound } from "./data";
const Ctx = createContext();
function* useCtx() {
  const value = yield* Ctx;
  return value;
}
export const C = $component(function* (props) {
  const ctx = yield* useCtx();
  const theme = yield* Ctx;
  const [n, setN] = yield* $signal(0);
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    return yield* attempt(() => load(id, ctx), NotFound);
  });
  const tried = yield* $memo(function* () {
    const id = yield* n;
    try { return yield* attempt(() => load(id)); } catch (e) { return null; }
  });
  const late = yield* $memo(function* () {
    const a = yield* attempt(() => load(1));
    return a + (yield* n);
  });
  const looped = yield* $memo(function* () {
    let a = 0;
    for (const x of [1, 2]) a += yield* attempt(() => load(x));
    return a;
  });
  const erased = $event(function* (e) {
    const v = yield* n;
    try {
      const r = yield* attempt(() => save(v, e));
      setN(r);
    } catch (err) {
      yield* raise(err);
    }
    return v;
  });
  const flushed = $event(function* () {
    setN(1);
    yield* $flush();
    const r = yield* attempt(() => save(1));
    setN(r);
    yield* $flush();
  });
  const restored = $event(function* () {
    const v = yield* imported;
    yield* attempt(() => save(v));
    yield* $flush();
  });
  return function* () {
    return <i onClick={erased} title={yield* n} data-u={yield* user}>{theme}{yield* readStore(ctx, s => s.x)}</i>;
  };
});
"#;

#[test]
fn async_bodies_are_async_functions_or_stay_with_the_driver() {
    let out = dom(ASYNC_APP);
    let flat = flat(&out);
    // A memo that reads, then waits: its host calls the async body.
    assert!(
        flat.contains(
            "const user = _$createMemo(_$asyncBody(async function(_$i, _$a) { try { const id = _$readPath1(props, \"id\"); return _$a.ret(_$a.t(() => load(id, ctx), NotFound) ? _$a.r(await _$a.p) : _$a.v); } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); } }));"
        ),
        "{out}"
    );
    // Memo refusals: an `attempt` in a `try`, a read after the first
    // `attempt`, an `attempt` in a loop — each keeps its generator.
    assert!(
        flat.contains("const tried = _$createMemo(_$$(function* () {"),
        "{out}"
    );
    assert!(
        flat.contains("const late = _$createMemo(_$$(function* () {"),
        "{out}"
    );
    assert!(
        flat.contains("const looped = _$createMemo(_$$(function* () {"),
        "{out}"
    );
    // An event: `try` around an attempt is fine (no run is ever superseded),
    // `raise` is a `throw`, `return v` reports through the run.
    assert!(
        flat.contains(
            "const erased = _$$eventCompiled(_$asyncBody(async function(e, _$a) { try { const v = n(); try { const r = _$a.t(() => save(v, e)) ? _$a.r(await _$a.p) : _$a.v; setN(r); } catch (err) { throw err; } return _$a.ret(v); } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); } }));"
        ),
        "{out}"
    );
    // `$flush()` statements in an async event: `flush()` like a
    // synchronous event's, before and after the wait.
    assert!(
        flat.contains(
            "const flushed = _$$eventCompiled(_$asyncBody(async function(_$i, _$a) { try { setN(1); _$flush(); const r = _$a.t(() => save(1)) ? _$a.r(await _$a.p) : _$a.v; setN(r); _$flush(); } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); } }));"
        ),
        "{out}"
    );
    // An operation the erasure cannot prove (an imported source): the
    // generator is restored exactly as authored, its lowered `$flush()`
    // included.
    assert!(
        flat.contains(
            "const restored = _$$eventCompiled(_$$(function* () { const v = yield* imported; yield* attempt(() => save(v)); yield* $flush(); }));"
        ),
        "{out}"
    );
    assert!(flat.contains(" $ as _$$"), "{out}");
    // Server output: the same bodies are erased, restored and refused.
    let ssr = compile_with(
        ASYNC_APP,
        CompileOptions {
            generate: Generate::Ssr,
            ..CompileOptions::default()
        },
    );
    let ssr_flat = self::flat(&ssr);
    assert!(
        ssr_flat.contains(
            "const erased = _$$eventCompiled(_$asyncBody(async function(e, _$a) {"
        ),
        "{ssr}"
    );
    assert!(
        ssr_flat.contains("const looped = _$createMemo(_$$(function* () {"),
        "{ssr}"
    );
}

#[test]
fn context_reads_and_helpers_lower_in_setups() {
    let out = dom(ASYNC_APP);
    let flat = flat(&out);
    // A helper that only reads proven contexts is a plain function; its
    // callers call it; a setup context read is `readContext`: the setup
    // has no operation left and loses its block.
    assert!(
        flat.contains("function useCtx() { const value = _$readContext(Ctx); return value; }"),
        "{out}"
    );
    assert!(
        flat.contains(
            "export const C = _$$componentCompiled(function(props) { const ctx = useCtx(); const theme = _$readContext(Ctx);"
        ),
        "{out}"
    );
    assert!(
        !out.contains("function*  useCtx") && !out.contains("_$perform"),
        "{out}"
    );
    // An exported helper, or a context the compiler cannot prove, keeps `perform`.
    let kept = dom(r#"import { $component, createContext } from "solid-js";
import { Theme } from "./theme";
const Ctx = createContext();
export function* useCtx() { return yield* Ctx; }
export const C = $component(function* () {
  const a = yield* useCtx();
  const b = yield* Theme;
  return function* () { return <i>{a}{b}</i>; };
});
"#);
    assert!(kept.contains("export function* useCtx()"), "{kept}");
    assert!(kept.contains("const a = _$perform(useCtx());"), "{kept}");
    assert!(kept.contains("const b = _$perform(Theme);"), "{kept}");
}

#[test]
fn view_reads_are_direct_in_computations() {
    let out = dom(ASYNC_APP);
    let flat = flat(&out);
    // Attribute holes the JSX transform turned into an effect: plain calls.
    assert!(
        flat.contains("_$effect(() => { return { e: n(), t: user() }; }"),
        "{out}"
    );
    assert!(flat.contains("return ((s) => s.x)(ctx);"), "{out}");
    // A prop getter may run with the guard up: `readAccessor` / `readSelected`.
    let getters = dom(
        r#"import { $component, $signal, readStore, Show } from "solid-js";
export const C = $component(function* (props) {
  const [n] = yield* $signal(0);
  return function* () {
    return <Show when={yield* n}><b title={yield* readStore(props.items, s => s.length)} /></Show>;
  };
});
"#,
    );
    let g = self::flat(&getters);
    assert!(
        g.contains("get when() { return _$readAccessor(n); }"),
        "{getters}"
    );
    assert!(!getters.contains("_$perform"), "{getters}");
    // A view returning a `solid-js` flow component is proven SYNC.
    assert!(g.contains("syncBlock as _$$"), "{getters}");
}

#[test]
fn fragment_views_are_sync_on_both_sides() {
    // A view returning a fragment of intrinsic elements (an array of nodes /
    // SSR strings) is proven `BLOCK_SYNC`: the module drops the driver, and
    // the flagged view is scoped the same way on both generates.
    let source = r#"import { $component, $signal, $event } from "solid-js";
export const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return (
      <>
        <a onClick={toggle}>{(yield* open) ? "-" : "+"}</a>
        <ul style={{ display: (yield* open) ? "block" : "none" }}>{props.children}</ul>
      </>
    );
  };
});
"#;
    for generate in [Generate::Dom, Generate::Ssr] {
        let out = compile_with(
            source,
            CompileOptions {
                generate,
                hydratable: true,
                ..CompileOptions::default()
            },
        );
        let flat = self::flat(&out);
        assert!(flat.contains("syncBlock as _$$"), "{out}");
        assert!(flat.contains("return _$$(_$blockScope(function() {"), "{out}");
        assert!(!out.contains("_$perform"), "{out}");
    }
    // Not a fragment of plain elements (a component child): not proven.
    let unproven = dom(
        r#"import { $component } from "solid-js";
import { Child } from "./child";
export const C = $component(function* () {
  return function* () { return <><Child /><b /></>; };
});
"#,
    );
    assert!(self::flat(&unproven).contains(" $ as _$$"), "{unproven}");
}
