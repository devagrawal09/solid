//! Unit tests: the island partitioner, the tier selector, and both emitters.
use super::*;

fn opts() -> IslandOptions {
    IslandOptions {
        filename: Some("app.tsx".into()),
        ..IslandOptions::default()
    }
}

fn run(src: &str) -> IslandsOutput {
    compile_islands(src, &opts()).expect("compiles")
}

fn manifest(out: &IslandsOutput) -> String {
    out.manifest.clone()
}

const TOGGLE: &str = r#"
import { $component, $event, $signal, For, Show } from "solid-js";
export const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          {props.children}
        </ul>
      </>
    );
  };
});
const Comment = $component(function* (props) {
  return function* () {
    return (
      <li class="comment">
        <div class="by">{yield* props.comment.user}</div>
        <Show when={(yield* props.comment.comments).length}>
          <Toggle>
            <For each={yield* props.comment.comments}>{c => <Comment comment={c} />}</For>
          </Toggle>
        </Show>
      </li>
    );
  };
});
export const Page = $component(function* (props) {
  return function* () {
    return <ul><For each={yield* props.comments}>{c => <Comment comment={c} />}</For></ul>;
  };
});
"#;

#[test]
fn toggle_is_a_tier0_island_and_comment_is_inert() {
    let out = run(TOGGLE);
    assert!(out.fallback.is_none(), "fallback: {:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""root":"Toggle""#), "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
    assert!(
        m.contains(r#"{"name":"Comment","class":"inert","islands":[]}"#),
        "{m}"
    );
    assert!(
        m.contains(r#"{"name":"Page","class":"inert","islands":[]}"#),
        "{m}"
    );
    assert_eq!(out.chunks.len(), 1);
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("@solidjs/signals/t0"), "{chunk}");
    assert!(chunk.contains("$cell(true)"), "{chunk}");
    assert!(chunk.contains("addEventListener(\"click\""), "{chunk}");
    // No reactive runtime.
    assert!(!chunk.contains("createRenderEffect"), "{chunk}");
    // Server: the anchor on the first element, no markers on inert holes.
    assert!(
        out.server.contains("data-i=\\\"i0\\\"") || out.server.contains("data-i=\"i0\""),
        "{}",
        out.server
    );
    assert!(!out.server.contains("_hk"), "{}", out.server);
}

#[test]
fn two_unrelated_cells_in_one_component_are_two_islands() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [a, setA] = yield* $signal(1);
  const [b, setB] = yield* $signal(2);
  const incA = $event(function* () { setA(x => x + 1); });
  const incB = $event(function* () { setB(x => x + 1); });
  return function* () {
    return (
      <div>
        <p class="a">{yield* a}</p><button class="ia" onClick={incA} />
        <p class="b">{yield* b}</p><button class="ib" onClick={incB} />
        <p class="static">{"x"}</p>
      </div>
    );
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert_eq!(out.chunks.len(), 2, "{}", manifest(&out));
    assert!(out.server.contains("data-i=\"i0 i1\""), "{}", out.server);
    // Each chunk carries only its own cell, handler and hole.
    let (ca, cb) = (&out.chunks[0].code, &out.chunks[1].code);
    assert!(ca.contains("incA") && !ca.contains("incB"), "{ca}");
    assert!(!ca.contains("setB") && !ca.contains("$cell(2"), "{ca}");
    assert!(cb.contains("incB") && !cb.contains("incA"), "{cb}");
    assert!(!cb.contains("setA") && !cb.contains("$cell(1"), "{cb}");
    assert_eq!(ca.matches("addEventListener").count(), 1, "{ca}");
    assert_eq!(cb.matches("addEventListener").count(), 1, "{cb}");
}

/// A component in two islands (one cell shared with more components than
/// the other) gets, in each chunk, only that island's cells, handlers and
/// holes: a second copy of the other island's cell would go out of phase
/// with it once the islands activate at different times.
#[test]
fn a_component_in_two_islands_gets_only_each_islands_sites() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
const AddToCart = $component(function* (props) {
  const add = $event(function* () { props.setCount(c => c + 1); });
  return function* () {
    return <form class="add" onSubmit={add}><button>Add {props.name}</button></form>;
  };
});
const CartBadge = $component(function* (props) {
  const flip = $event(function* () { props.setDark(d => !d); });
  return function* () {
    return <span class={{ badge: true, dark: yield* props.dark }} onClick={flip}>{yield* props.count} items</span>;
  };
});
const Product = $component(function* (props) {
  return function* () {
    return <article><h2>{yield* props.item.title}</h2></article>;
  };
});
export const Page = $component(function* (props) {
  const [count, setCount] = yield* $signal(0);
  const [dark, setDark] = yield* $signal(false);
  return function* () {
    return (
      <div class={{ page: true, dark: yield* dark }}>
        <header><CartBadge count={count} dark={dark} setDark={setDark} /></header>
        <Product item={props.item} />
        <footer><AddToCart name={props.item.title} setCount={setCount} /></footer>
      </div>
    );
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 2, "{m}");
    assert!(m.contains(r#""events":["submit"]"#), "{m}");
    assert!(m.contains(r#""events":["click"]"#), "{m}");
    let i0 = &out.chunks.iter().find(|c| c.id == "i0").expect("i0").code;
    let i1 = &out.chunks.iter().find(|c| c.id == "i1").expect("i1").code;
    // i0 = {count}: the submit handler and the count text hole only.
    assert!(i0.contains("setCount") && i0.contains("\"submit\""), "{i0}");
    assert!(!i0.contains("dark"), "{i0}");
    assert!(!i0.contains("setDark"), "{i0}");
    assert!(!i0.contains("classList.toggle(\"dark\""), "{i0}");
    assert!(!i0.contains("\"click\""), "{i0}");
    // i1 = {dark}: the click handler and the two `dark` class holes only.
    assert!(i1.contains("setDark") && i1.contains("\"click\""), "{i1}");
    assert_eq!(i1.matches("classList.toggle(\"dark\"").count(), 2, "{i1}");
    assert!(!i1.contains("count"), "{i1}");
    assert!(!i1.contains("setCount"), "{i1}");
    assert!(!i1.contains("\"submit\""), "{i1}");
}

#[test]
fn shared_state_merges_to_one_group_at_tier1() {
    let out = run(r#"
import { $component, $event, $memo, $signal } from "solid-js";
const Counter = $component(function* (props) {
  const inc = $event(function* () { props.set(c => c + 1); });
  return function* () { return <button class="inc" onClick={inc} />; };
});
const Display = $component(function* (props) {
  const doubled = yield* $memo(function* () { return (yield* props.count) * 2; });
  return function* () { return <p><span>{yield* props.count}</span><span>{yield* doubled}</span></p>; };
});
export const App = $component(function* () {
  const [count, setCount] = yield* $signal(1);
  return function* () { return <div><Counter set={setCount} /><Display count={count} /></div>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 1, "{m}");
    assert!(m.contains(r#""tier":1"#), "{m}");
    assert!(
        m.contains(r#""members":["App","Counter","Display"]"#)
            || m.contains(r#""members":["App","#),
        "{m}"
    );
    assert!(m.contains(r#""ownTiers":{"#), "{m}");
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("@solidjs/signals/kernel"), "{chunk}");
    assert!(chunk.contains("$M("), "{chunk}");
}

#[test]
fn a_store_island_is_tier2_on_the_cores_plain_store() {
    let out = run(r#"
import { $component, $event, $store } from "solid-js";
export const App = $component(function* () {
  const [s, setS] = yield* $store({ n: 1 });
  const inc = $event(function* () { setS(x => { x.n++; }); });
  return function* () { return <button onClick={inc}>{yield* s.n}</button>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""tier":2"#), "{m}");
    assert!(m.contains("store `s` (the kernel has no stores)"), "{m}");
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains(r#"from "@solidjs/signals""#), "{chunk}");
    // Rebuilt from its constant: nothing serialized.
    assert!(chunk.contains("$$createPlainStore({ n: 1 })"), "{chunk}");
    assert!(!out.server.contains("data-s"), "{}", out.server);
}

#[test]
fn a_store_from_server_data_serializes_only_the_keys_its_code_touches() {
    let out = run(r#"
import { $component, $event, $store, readStore } from "solid-js";
export const App = $component(function* (props) {
  const [s, setS] = yield* $store({ items: yield* props.items, label: yield* props.label, big: yield* props.big });
  const add = $event(function* () { setS(d => { d.items.push(1); }); });
  return function* () {
    return <p onClick={add}>{yield* s.label}: {yield* readStore(s, x => x.items.length)}</p>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert!(
        out.server
            .contains(r#""$s": _$pick(s, ["items", "label"])"#),
        "{}",
        out.server
    );
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains(r#"$$createPlainStore($d["$s"])"#), "{chunk}");
    // The same store used as a value serializes whole.
    let out = run(r#"
import { $component, $event, $store } from "solid-js";
export const App = $component(function* (props) {
  const [s, setS] = yield* $store({ a: yield* props.a, b: 1 });
  const log = $event(function* () { console.log(s); setS(d => { d.b++; }); });
  return function* () { return <p onClick={log}>{yield* s.b}</p>; };
});
"#);
    assert!(out.server.contains(r#""$s": s }"#), "{}", out.server);
}

#[test]
fn a_cell_nothing_writes_is_server_authoritative() {
    let out = run(r#"
import { $component, $signal } from "solid-js";
export const App = $component(function* () {
  const [a] = yield* $signal(1);
  return function* () { return <p>{yield* a}</p>; };
});
"#);
    assert!(out.fallback.is_none());
    assert!(out.chunks.is_empty(), "{}", manifest(&out));
    assert!(out.manifest.contains(r#""class":"inert""#));
}

#[test]
fn conditional_reads_need_tier1() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [a, setA] = yield* $signal(1);
  const [b, setB] = yield* $signal(2);
  const f = $event(function* () { setA(x => x + 1); setB(x => x + 1); });
  return function* () { return <p onClick={f}>{(yield* a) > 1 ? yield* b : 0}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""tier":1"#), "{m}");
    assert!(m.contains("conditional read"), "{m}");
}

fn fallback_of(src: &str) -> String {
    compile_islands(src, &opts())
        .expect("compiles")
        .fallback
        .expect("falls back")
}

#[test]
fn context_flows_join_the_provider_and_its_consumers() {
    let out = run(r#"
import { $component, $event, $signal, createContext } from "solid-js";
const Ctx = createContext();
const Child = $component(function* () {
  const [count, inc] = yield* Ctx;
  const click = $event(function* () { inc(); });
  return function* () { return <button onClick={click}>{yield* count}</button>; };
});
export const App = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  const inc = () => setCount(c => c + 1);
  return function* () { return <Ctx value={[count, inc]}><div><Child /></div></Ctx>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 1, "{m}");
    assert!(
        m.contains(r#""root":"App""#) && m.contains(r#""members":["App","Child"]"#),
        "{m}"
    );
    // The provider value is bound once; the consumer destructures it.
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("const $c1 = [count, inc];"), "{chunk}");
    assert!(chunk.contains("= $c1;"), "{chunk}");
    // The anchor goes through the provider to its first element.
    assert!(out.server.contains("<div data-i=\"i0\"${_$k(_$p, $c)}>"), "{}", out.server);
}

#[test]
fn a_settled_listener_is_a_lazy_stub_and_other_settled_work_is_hot() {
    let stub = run(r#"
import { $component, $event, $settled, $signal, $cleanup } from "solid-js";
export const App = $component(function* () {
  const [hash, setHash] = yield* $signal(location.hash);
  yield* $settled(function* () {
    const sync = $event(function* () { setHash(location.hash); });
    window.addEventListener("hashchange", sync);
    yield* $cleanup(() => window.removeEventListener("hashchange", sync));
  });
  return function* () { return <p>{yield* hash}</p>; };
});
"#);
    let m = manifest(&stub);
    assert!(m.contains(r#""windowEvents":["hashchange"]"#), "{m}");
    assert!(m.contains(r#""activation":"lazy""#), "{m}");
    let hot = run(r#"
import { $component, $settled, $signal } from "solid-js";
export const App = $component(function* () {
  const [w, setW] = yield* $signal(0);
  yield* $settled(function* () { setW(window.innerWidth); });
  return function* () { return <p>{yield* w}</p>; };
});
"#);
    let m = manifest(&hot);
    assert!(m.contains(r#""activation":"load""#), "{m}");
    assert!(m.contains("settled body (load-time)"), "{m}");
}

#[test]
fn an_effect_is_split_into_compute_and_effect_halves() {
    let out = run(r#"
import { $component, $effect, $event, $signal, $cleanup } from "solid-js";
export const App = $component(function* () {
  const [a, setA] = yield* $signal(1);
  const [b, setB] = yield* $signal(0);
  const inc = $event(function* () { setA(x => x + 1); });
  yield* $effect(function* () {
    const v = yield* a;
    setB(v * 10);
    yield* $cleanup(() => console.log(v));
  });
  return function* () { return <p onClick={inc}>{yield* b}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("$Ef(() => [a()], $v => {"), "{chunk}");
    assert!(chunk.contains("const v = $v[0];"), "{chunk}");
    assert!(chunk.contains("$cl.push("), "{chunk}");
    let m = manifest(&out);
    assert!(
        m.contains(r#""tier":1"#) && m.contains("`b` is written by an effect"),
        "{m}"
    );
    assert!(m.contains(r#""activation":"load""#), "{m}");
}

#[test]
fn an_escaped_setter_makes_its_cell_live() {
    let out = run(r#"
import { $component, $signal } from "solid-js";
export let setLabel;
export const App = $component(function* () {
  const [label, set] = yield* $signal("a");
  setLabel = set;
  return function* () { return <p>{yield* label}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 1, "{m}");
    assert!(m.contains("setter escapes"), "{m}");
    // The module binding is reachable through the chunk.
    assert!(
        out.chunks[0].code.contains("export let setLabel;"),
        "{}",
        out.chunks[0].code
    );
}

#[test]
fn a_side_effecting_setup_keeps_its_component_in_one_island() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  console.log("setup");
  const [a, setA] = yield* $signal(1);
  const [b, setB] = yield* $signal(2);
  const incA = $event(function* () { setA(x => x + 1); });
  const incB = $event(function* () { setB(x => x + 1); });
  return function* () {
    return <div><p onClick={incA}>{yield* a}</p><p onClick={incB}>{yield* b}</p></div>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert_eq!(out.chunks.len(), 1, "{}", manifest(&out));
    assert_eq!(
        out.chunks[0].code.matches("console.log(\"setup\")").count(),
        1
    );
}

#[test]
fn a_member_rendered_outside_its_island_root_is_refused() {
    let reason = fallback_of(
        r#"
import { $component, $event, $signal } from "solid-js";
const Button = $component(function* (props) {
  const click = $event(function* () { props.set(1); });
  return function* () { return <button onClick={click} />; };
});
export const Other = $component(function* () {
  return function* () { return <Button set={() => {}} />; };
});
export const App = $component(function* () {
  const [a, setA] = yield* $signal(0);
  return function* () { return <div>{yield* a}<Button set={setA} /></div>; };
});
"#,
    );
    assert!(
        reason.contains("no single component renders every member"),
        "{reason}"
    );
}

/// State lifted into the parent and read by a recursive child (the thread
/// under one `closed` signal): genuinely shared state, so ONE island over
/// the thread, whose rows the island adopts under the server's structural
/// regions — each level runs the same row function.
#[test]
fn lifted_state_read_by_a_recursive_child_is_one_island_over_the_thread() {
    let out = run(r#"
import { $component, $event, $signal, For } from "solid-js";
const Node = $component(function* (props) {
  const click = $event(function* () { props.set(x => x + 1); });
  return function* () {
    return <li onClick={click}><For each={yield* props.kids}>{k => <Node kids={k} set={props.set} />}</For></li>;
  };
});
export const App = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  return function* () { return <ul><b>{yield* n}</b><Node kids={yield* props.kids} set={setN} /></ul>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 1, "{m}");
    assert!(m.contains(r#""root":"App","members":["App","Node"]"#), "{m}");
    let chunk = &out.chunks[0].code;
    // The rows of each level: one row function, called again for its own rows.
    assert!(chunk.contains("const $rows = "), "{chunk}");
    let name = chunk
        .lines()
        .find(|l| l.starts_with("const $r") && l.contains(" = (k$"))
        .and_then(|l| l.split(' ').nth(1))
        .expect("a row function");
    let calls = chunk
        .lines()
        .filter(|l| l.starts_with("$rows(") && l.ends_with(&format!(", {name});")))
        .count();
    assert_eq!(calls, 2, "{chunk}");
    // The server marks the structural region around the rows.
    assert!(out.server.contains("<!--$-->${_$forR("), "{}", out.server);
    // A recursion whose props change per level is refused with its reason.
    let reason = fallback_of(
        r#"
import { $component, $event, $signal, For } from "solid-js";
const Node = $component(function* (props) {
  const click = $event(function* () { props.set(x => x + 1); });
  return function* () {
    return <li onClick={click}>{props.depth}<For each={yield* props.kids}>{k => <Node kids={k} depth={props.depth + 1} set={props.set} />}</For></li>;
  };
});
export const App = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  return function* () { return <ul><b>{yield* n}</b><Node kids={yield* props.kids} depth={0} set={setN} /></ul>; };
});
"#,
    );
    assert!(reason.contains("props that change per level"), "{reason}");
}

#[test]
fn an_island_inside_another_islands_live_region_joins_it() {
    let out = run(r#"
import { $component, $event, $signal, Show } from "solid-js";
const Inner = $component(function* () {
  const [on, setOn] = yield* $signal(false);
  const flip = $event(function* () { setOn(x => !x); });
  return function* () { return <b onClick={flip}>{(yield* on) ? "on" : "off"}</b>; };
});
export const App = $component(function* () {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(x => !x); });
  return function* () {
    return <div><button onClick={toggle} /><Show when={yield* open}><Inner /></Show></div>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(out.chunks.len(), 1, "{m}");
    assert!(m.contains(r#""members":["App","Inner"]"#), "{m}");
    assert!(
        out.chunks[0].code.contains("$show("),
        "{}",
        out.chunks[0].code
    );
}

#[test]
fn a_server_authoritative_async_memo_is_awaited_on_the_server() {
    let out = run(r#"
import { $component, $memo, attempt, Loading } from "solid-js";
const Story = $component(function* () {
  const story = yield* $memo(function* () { return yield* attempt(() => fetchStory()); });
  return function* () { return <h1>{(yield* story).title}</h1>; };
});
export const Page = $component(function* () {
  return function* () { return <Loading fallback={<p>…</p>}><Story /></Loading>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert!(out.chunks.is_empty());
    assert!(
        out.server.contains("const story = _$v(await (async () =>"),
        "{}",
        out.server
    );
    assert!(
        out.server.contains("export const Page = async function"),
        "{}",
        out.server
    );
}

#[test]
fn a_live_async_memo_is_tier2_and_adopts_the_server_value() {
    let out = run(r#"
import { $component, $event, $memo, $signal, attempt } from "solid-js";
export const App = $component(function* () {
  const [id, setId] = yield* $signal(1);
  const user = yield* $memo(function* () { const i = yield* id; return yield* attempt(() => load(i)); });
  const next = $event(function* () { setId(x => x + 1); });
  return function* () { return <p onClick={next}>{(yield* user).name}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(
        m.contains("async memo `user`") && m.contains(r#""tier":2"#),
        "{m}"
    );
    assert!(m.contains(r#""serialized":["memo user"]"#), "{m}");
    // The server serializes the settled value; the client's first run reads
    // `id` (subscribing) and returns it without calling `load`.
    assert!(out.server.contains(r#""$user": user()"#), "{}", out.server);
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains(r#"return $d["$user"];"#), "{chunk}");
    assert!(chunk.contains("(await (() => load(i))())"), "{chunk}");
    // A memo whose value is not its one attempt's result is refused.
    let reason = fallback_of(
        r#"
import { $component, $event, $memo, $signal, attempt } from "solid-js";
export const App = $component(function* () {
  const [id, setId] = yield* $signal(1);
  const user = yield* $memo(function* () { const i = yield* id; const u = yield* attempt(() => load(i)); return u.name; });
  const next = $event(function* () { setId(x => x + 1); });
  return function* () { return <p onClick={next}>{yield* user}</p>; };
});
"#,
    );
    assert!(reason.contains("not adoptable"), "{reason}");
}

#[test]
fn an_event_that_attempts_async_work_is_an_async_handler() {
    let out = run(r#"
import { $component, $event, $signal, attempt } from "solid-js";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const save = $event(function* () { const r = yield* attempt(() => fetch("/n")); setN(r.status); });
  return function* () { return <p onClick={save}>{yield* n}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("const save = async () => {"), "{chunk}");
    assert!(
        chunk.contains(r#"(await (() => fetch("/n"))())"#),
        "{chunk}"
    );
}

#[test]
fn component_call_forms_compile_as_jsx() {
    // `Loading({ … })` / `Child({ … })` in a view are read as the elements
    // they stand for (a source pre-pass), nested ones inside out.
    let out = run(r#"
import { $component, $event, $signal, Loading, Errored } from "solid-js";
const Child = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () { return <b onClick={inc} title={props.t}>{yield* n}</b>; };
});
export const App = $component(function* () {
  return function* () {
    return <main>{Errored({ fallback: e => <p>{String(e())}</p>, children: Loading({ fallback: "…", children: Child({ t: "x" }) }) })}</main>;
  };
});
"#);
    assert!(out.fallback.is_none(), "fallback: {:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""root":"Child""#), "{m}");
    assert!(
        out.server.contains(r#"Child({ "t": "x" }, $c)"#),
        "{}",
        out.server
    );
    // A call form the pre-pass cannot express as JSX (a spread) is refused.
    let reason = fallback_of(
        r#"
import { $component, Loading } from "solid-js";
const Child = $component(function* () { return function* () { return <b />; }; });
export const App = $component(function* (props) {
  return function* () { return <main>{Child({ ...props })}</main>; };
});
"#,
    );
    assert!(reason.contains("component call form"), "{reason}");
}

#[test]
fn live_jsx_expressions_fall_back() {
    let reason = fallback_of(
        r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [on, setOn] = yield* $signal(false);
  const flip = $event(function* () { setOn(x => !x); });
  return function* () { return <div onClick={flip}>{(yield* on) ? <b>on</b> : <i>off</i>}</div>; };
});
"#,
    );
    assert!(reason.contains("live expression producing JSX"), "{reason}");
}

#[test]
fn a_loading_over_server_data_streams_and_a_spanning_island_waits() {
    let out = run(r#"
import { $component, $event, $memo, $signal, attempt, Loading } from "solid-js";
const Data = $component(function* (props) {
  const info = yield* $memo(function* () { return yield* attempt(() => fetch("/x")); });
  return function* () { return <section><h2>{(yield* info).title}</h2><span>{yield* props.n}</span></section>; };
});
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return <div><button onClick={inc}>inc</button><Loading fallback={<p>…</p>}><Data n={yield* n} /></Loading></div>;
  };
});
"#);
    assert!(out.fallback.is_none(), "fallback: {:?}", out.fallback);
    // The boundary renders through `_$ld` (streamed with a stream, awaited
    // in place without one); its fallback is a thunk.
    assert!(
        out.server.contains("await _$ld($c, async ($c) =>"),
        "{}",
        out.server
    );
    let m = manifest(&out);
    assert!(m.contains(r#""streams":true"#), "{m}");
    // The island's member renders inside the boundary: it waits for it.
    assert!(m.contains(r#""waits":true"#), "{m}");
    // The member's server-authoritative async memo is not rebuilt.
    let chunk = &out.chunks[0].code;
    assert!(!chunk.contains("info"), "{chunk}");
}

#[test]
fn live_holes_sharing_an_element_get_marker_pairs_and_inert_ones_none() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return <p onClick={inc}><b>{yield* n}</b> {yield* n} of {yield* props.total}</p>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    // Sole child: no markers; shared element: a pair; inert: none.
    assert!(
        out.server.contains(
            "<b>${_$e(n())}</b> <!--$-->${_$e(n())}<!--/--> of ${_$e(_$r(props.total))}</p>"
        ),
        "{}",
        out.server
    );
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("$mk($a, 0)"), "{chunk}");
    assert!(chunk.contains("$a.firstElementChild"), "{chunk}");
}

#[test]
fn props_read_by_client_code_are_serialized_on_the_anchor() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + (yield* props.step)); });
  return function* () { return <button onClick={inc}>{yield* n}</button>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert!(
        out.server.contains(
            r#"data-s="${_$ea(JSON.stringify({ "i0": { "step": _$r(props["step"]) } }))}""#
        ),
        "{}",
        out.server
    );
    assert!(
        out.chunks[0]
            .code
            .contains(r#"const $d = JSON.parse($a.getAttribute("data-s"))["i0"]"#),
        "{}",
        out.chunks[0].code
    );
    assert!(
        out.manifest.contains(r#""serialized":["props.step"]"#),
        "{}",
        out.manifest
    );
}

#[test]
fn a_prevent_default_handler_marks_its_element() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const go = $event(function* (e) { e.preventDefault(); setN(x => x + 1); });
  return function* () { return <div><a href="/x" onClick={go}>go {yield* n}</a></div>; };
});
"#);
    assert!(
        out.server.contains("<a href=\"/x\" data-pd>"),
        "{}",
        out.server
    );
    assert!(out.manifest.contains(r#""preventDefault":true"#));
}

#[test]
fn min_tier_binds_the_same_chunk_to_the_core() {
    let t1 = compile_islands(
        TOGGLE,
        &IslandOptions {
            min_tier: 1,
            ..opts()
        },
    )
    .unwrap();
    assert!(
        t1.chunks[0].code.contains("\"@solidjs/signals/kernel\""),
        "{}",
        t1.chunks[0].code
    );
    let t2 = compile_islands(
        TOGGLE,
        &IslandOptions {
            min_tier: 2,
            ..opts()
        },
    )
    .unwrap();
    assert!(
        t2.chunks[0].code.contains("from \"@solidjs/signals\""),
        "{}",
        t2.chunks[0].code
    );
    assert_eq!(
        t1.chunks[0]
            .code
            .replace("@solidjs/signals/kernel", "@solidjs/signals"),
        t2.chunks[0].code
    );
    assert!(t2.manifest.contains(r#""tier":2"#) && t2.manifest.contains(r#""analysisTier":0"#));
}

#[test]
fn chunks_are_plain_javascript() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
interface Item { id: number }
function first(list: Item[]): Item | undefined { return list[0]; }
export const App = $component(function* () {
  const [items, setItems] = yield* $signal<Item[]>([]);
  const add = $event(function* (e: MouseEvent) { setItems(l => [...l, { id: l.length } as Item]); });
  return function* () { return <p onClick={add}>{first(yield* items)?.id ?? "none"}</p>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let chunk = &out.chunks[0].code;
    for ts in [
        "interface",
        ": Item",
        "as Item",
        "<Item[]>",
        "(e: MouseEvent)",
    ] {
        assert!(!chunk.contains(ts), "`{ts}` left in {chunk}");
    }
    assert!(chunk.contains("function first(list) {"), "{chunk}");
}

#[test]
fn module_state_shared_by_two_islands_is_refused() {
    let reason = fallback_of(
        r#"
import { $component, $event, $signal } from "solid-js";
let clicks = 0;
export const A = $component(function* () {
  const [a, setA] = yield* $signal(0);
  const f = $event(function* () { clicks++; setA(clicks); });
  return function* () { return <p onClick={f}>{yield* a}</p>; };
});
export const B = $component(function* () {
  const [b, setB] = yield* $signal(0);
  const f = $event(function* () { clicks++; setB(clicks); });
  return function* () { return <p onClick={f}>{yield* b}</p>; };
});
"#,
    );
    assert!(reason.contains("module-level mutable state"), "{reason}");
}

// --- cross-module: summaries and inlining ----------------------------------------------

fn run_with(src: &str, imports: &[(&str, &str)]) -> IslandsOutput {
    let opts = IslandOptions {
        filename: Some("/app/src/app.tsx".into()),
        imports: imports
            .iter()
            .map(|(spec, code)| ImportedModule {
                specifier: spec.to_string(),
                filename: format!("/app/src/{}.tsx", spec.trim_start_matches("./")),
                code: code.to_string(),
            })
            .collect(),
        ..IslandOptions::default()
    };
    compile_islands(src, &opts).expect("compiles")
}

const COUNTER: &str = r#"
import { createMemo, createSignal } from "solid-js";
import { log } from "./log";
const step = 1;
export function createCounter(start) {
  const [n, setN] = createSignal(start);
  const double = createMemo(() => n() * 2);
  return { n, double, inc: () => { log("inc"); setN(x => x + step); } };
}
export function plain(x) { return x + 1; }
"#;

#[test]
fn island_exports_summarize_kinds_and_relative_imports() {
    let s = island_exports(COUNTER, Some("counter.ts"));
    assert!(
        s.contains(r#"{"name":"createCounter","kind":"factory"}"#),
        "{s}"
    );
    assert!(s.contains(r#"{"name":"plain","kind":"function"}"#), "{s}");
    assert!(
        s.contains(r#""imports":[{"specifier":"./log","names":["log"]}]"#),
        "{s}"
    );
    let s = island_exports(
        r#"
import { $component, createContext } from "solid-js";
export const Theme = createContext("light");
export function* useTheme() { return yield* Theme; }
export const Badge = $component(function* () { return function* () { return <b />; }; });
"#,
        Some("theme.tsx"),
    );
    assert!(s.contains(r#"{"name":"Badge","kind":"component"}"#), "{s}");
    assert!(s.contains(r#"{"name":"Theme","kind":"value"}"#), "{s}");
    assert!(s.contains(r#"{"name":"useTheme","kind":"helper"}"#), "{s}");
}

#[test]
fn an_imported_factory_is_inlined_and_its_state_is_the_islands() {
    let src = r#"
import { $component, $event } from "solid-js";
import { createCounter, plain } from "./counter";
export const App = $component(function* () {
  const c = createCounter(plain(0));
  const inc = $event(function* () { c.inc(); });
  return function* () { return <button onClick={inc}>{yield* c.double}</button>; };
});
"#;
    // Without the module's source the factory is opaque: a `yield*` read of
    // what it returns cannot be classified, and the module falls back.
    let reason = fallback_of(src);
    assert!(reason.contains("comes from `createCounter(…)`"), "{reason}");
    let out = run_with(src, &[("./counter", COUNTER)]);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""root":"App""#), "{m}");
    assert!(m.contains("memo `double$f"), "{m}");
    let chunk = &out.chunks[0].code;
    // Its closure is copied renamed apart; its other imports are absolute;
    // a plain export it does not need stays imported from the module.
    assert!(chunk.contains("const step$m1 = 1;"), "{chunk}");
    assert!(chunk.contains(r#"from "/app/src/log""#), "{chunk}");
    assert!(chunk.contains("$S(start$f"), "{chunk}");
    assert!(
        out.server.contains(r#"import { plain } from "./counter";"#),
        "{}",
        out.server
    );
}

#[test]
fn an_imported_context_keeps_its_identity_and_helpers_inline() {
    let theme = r#"
import { $component, $event, $signal, createContext } from "solid-js";
export const Theme = createContext("light");
function* useTheme() { const t = yield* Theme; return t; }
export const Badge = $component(function* (props) {
  const theme = yield* useTheme();
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); props.onBump(); });
  return function* () { return <b class={theme} onClick={inc}>{yield* n} {yield* props.label}</b>; };
});
"#;
    let src = r#"
import { $component, $event, $signal } from "solid-js";
import { Badge, Theme } from "./theme";
export const App = $component(function* () {
  const [total, setTotal] = yield* $signal(0);
  const bump = () => setTotal(x => x + 1);
  return function* () {
    return <Theme value="dark"><main><Badge label={yield* total} onBump={bump} /></main></Theme>;
  };
});
"#;
    let out = run_with(src, &[("./theme", theme)]);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    // `Badge` receives live state: it is compiled into the page's island.
    assert!(m.contains(r#""members":["App","Badge"]"#), "{m}");
    // The context is still the module's (imported, not copied).
    assert!(
        out.server.contains(r#"import { Theme } from "./theme";"#),
        "{}",
        out.server
    );
    assert!(
        !out.server.contains("createContext(\"light\")"),
        "{}",
        out.server
    );
    assert!(out.server.contains("_$ctx($c, Theme)"), "{}", out.server);
}

#[test]
fn factory_and_helper_calls_in_setups_are_inlined_in_one_module() {
    let out = run(r#"
import { $component, $event, createContext, createSignal } from "solid-js";
const Ctx = createContext();
function createToggle(initial) {
  const [on, setOn] = createSignal(initial);
  return [on, () => setOn(x => !x)];
}
function* useCtx() {
  const v = yield* Ctx;
  if (!v) throw new Error("no provider");
  return v;
}
const Button = $component(function* () {
  const [on, flip] = yield* useCtx();
  const click = $event(function* () { flip(); });
  return function* () { return <button onClick={click}>{(yield* on) ? "on" : "off"}</button>; };
});
export function App() {
  return <Ctx value={createToggle(false)}><Button /></Ctx>;
}
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""members":["App","Button"]"#), "{m}");
    // The provider value was hoisted and inlined: the cell is App's.
    assert!(m.contains("App.on$f"), "{m}");
    assert!(out.server.contains("if (!v$f"), "{}", out.server);
}

#[test]
fn an_errored_around_a_tier2_islands_content_is_a_client_boundary() {
    let src = r#"
import { $component, $event, $store, Errored } from "solid-js";
export const App = $component(function* () {
  const [s, setS] = yield* $store({ n: 0 });
  const inc = $event(function* () { setS(d => { d.n++; }); });
  return function* () {
    return (
      <main>
        <Errored fallback={(err, reset) => <p onClick={reset}>{String(err())}</p>}>
          <b onClick={inc}>{yield* s.n}</b>
        </Errored>
      </main>
    );
  };
});
"#;
    let out = run(src);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    // The server marks the boundary's region; the client activates its
    // content inside `createErrorBoundary` and builds the fallback.
    assert!(out.server.contains("<!--$-->${_$err("), "{}", out.server);
    let chunk = &out.chunks[0].code;
    assert!(
        chunk.contains("createErrorBoundary as $$createErrorBoundary"),
        "{chunk}"
    );
    assert!(chunk.contains("$err($m"), "{chunk}");
    assert!(
        chunk.contains("addEventListener(\"click\", reset$"),
        "{chunk}"
    );
    // A tier-0 island under an `<Errored>` keeps its runtime (no boundary).
    let out = run(r#"
import { $component, $event, $signal, Errored } from "solid-js";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return <main><Errored fallback={<p>x</p>}><b onClick={inc}>{yield* n}</b></Errored></main>;
  };
});
"#);
    assert!(manifest(&out).contains(r#""tier":0"#), "{}", manifest(&out));
    assert!(!out.server.contains("<!--$-->"), "{}", out.server);
}

#[test]
fn a_context_provided_outside_the_island_is_serialized_at_its_root() {
    let src = r#"
import { $component, $event, $signal, createContext } from "solid-js";
const Api = createContext("api");
function* useApi() { return yield* Api; }
const Saver = $component(function* () {
  const api = yield* useApi();
  const [saved, setSaved] = yield* $signal("none");
  const save = $event(function* () { setSaved(api); });
  return function* () { return <button onClick={save}>{yield* saved}</button>; };
});
export function App() {
  return <Api value="remote"><Saver /></Api>;
}
"#;
    let out = run(src);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""serialized":["context Api"]"#), "{m}");
    assert!(
        out.server
            .contains(r#""$ctx:Api": _$cv(_$ctx($c, Api), "Api")"#),
        "{}",
        out.server
    );
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains(r#"= $d["$ctx:Api"];"#), "{chunk}");
    // A provider whose value holds reactive state makes it the island's: the
    // provider joins the island (or the module falls back), never a
    // serialized snapshot.
    let live = src.replace(
        r#"export function App() {
  return <Api value="remote"><Saver /></Api>;
}"#,
        r#"export const App = $component(function* () {
  const [k, setK] = yield* $signal("remote");
  const flip = $event(function* () { setK("local"); });
  return function* () { return <div onClick={flip}><Api value={k}><Saver /></Api></div>; };
});"#,
    );
    let out = run(&live);
    for c in &out.chunks {
        assert!(!c.code.contains("$ctx:Api"), "{}", c.code);
    }
}

// --- scopes: component boundaries do not matter ------------------------------------

/// `TOGGLE` written as ONE component: the thread is a named, recursive row
/// block declared in the page's setup, holding each comment's `open`.
const TOGGLE_SINGLE: &str = r#"
import { $component, $event, $signal, For, Show } from "solid-js";
export const Page = $component(function* (props) {
  function* comment(c) {
    const [open, setOpen] = yield* $signal(true);
    const toggle = $event(function* () { setOpen(o => !o); });
    return function* () {
      return (
        <li class="comment">
          <div class="by">{c.user}</div>
          <Show when={c.comments.length}>
            <div class={["toggle", { open: yield* open }]}>
              <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
            </div>
            <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
              <For each={c.comments}>{comment}</For>
            </ul>
          </Show>
        </li>
      );
    };
  }
  return function* () {
    return <ul><For each={yield* props.comments}>{comment}</For></ul>;
  };
});
"#;

fn islands_of(m: &str) -> Vec<String> {
    m.split(r#""root":""#)
        .skip(1)
        .map(|r| r.split('"').next().unwrap_or("").to_string())
        .collect()
}

#[test]
fn a_named_recursive_row_block_partitions_like_the_split_components() {
    let split = run(TOGGLE);
    let single = run(TOGGLE_SINGLE);
    assert!(single.fallback.is_none(), "{:?}", single.fallback);
    let m = manifest(&single);
    // One tier-0 island per toggle, rooted at the branch that owns `open`;
    // the page and the row markup are inert, nothing is serialized.
    assert_eq!(islands_of(&m).len(), 1, "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
    assert!(m.contains(r#"{"name":"Page","class":"inert","islands":[]}"#), "{m}");
    assert!(!m.contains(r#""serialized":[{"#), "{m}");
    assert_eq!(single.chunks.len(), split.chunks.len());
    // The same client code: component boundaries do not matter.
    assert_eq!(single.chunks[0].code, split.chunks[0].code);
}

#[test]
fn a_bare_row_block_gives_per_row_islands() {
    let out = run(r#"
import { $component, $event, $signal, For } from "solid-js";
export const App = $component(function* (props) {
  return function* () {
    return (
      <ul>
        <For each={yield* props.items}>
          {function* (item) {
            const [n, setN] = yield* $signal(0);
            const inc = $event(function* () { setN(x => x + 1); });
            return function* () { return <li onClick={inc}>{item.name} {yield* n}</li>; };
          }}
        </For>
      </ul>
    );
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m), vec!["App$For".to_string()], "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
    assert!(m.contains(r#"{"name":"App","class":"inert","islands":[]}"#), "{m}");
    // The row's capture is a prop of the row scope, read on the server.
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("$cell(0)"), "{chunk}");
}

#[test]
fn state_in_one_branch_roots_the_island_at_the_branch() {
    let out = run(r#"
import { $component, $event, $signal, Show } from "solid-js";
export const App = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <main>
        <h1>{yield* props.title}</h1>
        <Show when={yield* props.editable}>
          <button onClick={inc}>{yield* n}</button>
        </Show>
      </main>
    );
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m), vec!["App$Show".to_string()], "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
    // The title stays server-rendered.
    assert!(!out.chunks[0].code.contains("title"), "{}", out.chunks[0].code);
}

#[test]
fn exported_children_of_lifted_state_join_one_island() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const AddToCart = $component(function* (props) {
  const add = $event(function* () { props.setCount(c => c + 1); });
  return function* () { return <button onClick={add}>Add</button>; };
});
export const CartBadge = $component(function* (props) {
  return function* () { return <span class="badge">{yield* props.count}</span>; };
});
export const Page = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  return function* () {
    return (
      <main>
        <header><CartBadge count={count} /></header>
        <p>Static copy</p>
        <AddToCart setCount={setCount} />
      </main>
    );
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m), vec!["Page".to_string()], "{m}");
    assert!(m.contains(r#""members":["#), "{m}");
    assert!(m.contains("AddToCart") && m.contains("CartBadge"), "{m}");
}

const KEYED: &str = r#"
import { $component, $event, $store, For } from "solid-js";
export const App = $component(function* (props) {
  const [closed, setClosed] = yield* $store({});
  return function* () {
    return (
      <ul>
        <For each={yield* props.comments}>
          {function* (c) {
            const toggle = $event(function* () {
              setClosed(s => { s[c.id] = !s[c.id]; });
            });
            return function* () {
              return <li onClick={toggle}>{c.text}:{(yield* closed[c.id]) ? "closed" : "open"}</li>;
            };
          }}
        </For>
      </ul>
    );
  };
});
"#;

#[test]
fn a_store_read_and_written_at_the_rows_key_is_a_cell_per_row() {
    let out = run(KEYED);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m), vec!["App$For".to_string()], "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
    assert!(m.contains("closed$key"), "{m}");
    assert!(m.contains(r#"{"name":"App","class":"inert","islands":[]}"#), "{m}");
}

#[test]
fn a_store_read_at_another_key_stays_one_shared_island() {
    // The handler finds its key through the DOM: not the row's own key.
    let dataset = KEYED
        .replace(
            "const toggle = $event(function* () {\n              setClosed(s => { s[c.id] = !s[c.id]; });",
            "const toggle = $event(function* (e) {\n              const id = Number(e.currentTarget.dataset.id);\n              setClosed(s => { s[id] = !s[id]; });",
        )
        .replace("<li onClick", "<li data-id={c.id} onClick");
    assert_ne!(dataset, KEYED);
    let out = run(&dataset);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m).len(), 1, "{m}");
    assert!(!m.contains("closed$key"), "{m}");
    assert!(!m.contains(r#""root":"App$For""#), "{m}");
    // A row store split still holds for the keyed rows when a filter signal
    // every row reads is shared: the filter is its own shared island.
    let filtered = KEYED
        .replace(
            "const [closed, setClosed] = yield* $store({});",
            "const [closed, setClosed] = yield* $store({});\n  const [filter, setFilter] = yield* $signal(\"\");\n  const search = $event(function* (e) { setFilter(e.currentTarget.value); });",
        )
        .replace("$store, For", "$store, $signal, For")
        .replace("<ul>", "<ul><input onInput={search} />")
        .replace("<li onClick={toggle}>", "<li class={{ hit: c.text === (yield* filter) }} onClick={toggle}>");
    let out = run(&filtered);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    let roots = islands_of(&m);
    // ONE shared island for the filter every row reads (rooted at the
    // page), and the toggles keep their per-row keyed cells.
    assert_eq!(roots, vec!["App$For".to_string(), "App".to_string()], "{m}");
    assert!(m.contains(r#""cells":["App.filter"]"#), "{m}");
    assert!(m.contains(r#""cells":["App$For.closed$key"]"#), "{m}");
    // The store nothing else writes is its initial value, not a live store.
    for c in &out.chunks {
        assert!(!c.code.contains("createPlainStore"), "{}", c.code);
    }
}

#[test]
fn helper_generators_are_read_at_their_sites() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* (props) {
  const [first, setFirst] = yield* $signal("a");
  const [last] = yield* $signal("b");
  function* label(sep) { return (yield* first) + sep + (yield* last); }
  const rename = $event(function* () { setFirst(f => f + "!"); });
  return function* () {
    return <main><h1>{yield* props.title}</h1><button onClick={rename}>{yield* label(" ")}</button></main>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m).len(), 1, "{m}");
    assert!(m.contains(r#""tier":0"#), "{m}");
}

// --- client-environment reads (islands mode) ---------------------------------------

fn env_page(expr: &str) -> String {
    format!(
        r#"
import {{ $component, isServer }} from "solid-js";
export const Page = $component(function* (props) {{
  return function* () {{
    return <main><h1>title</h1><p class="env">{{{expr}}}</p></main>;
  }};
}});
"#
    )
}

#[test]
fn every_environment_read_in_a_view_is_client_live() {
    for (expr, why) in [
        ("isServer ? \"server\" : \"client\"", "isServer"),
        ("typeof window === \"undefined\" ? \"s\" : \"c\"", "window"),
        ("window.innerWidth", "window"),
        ("document.title", "document"),
        ("navigator.language", "navigator"),
        ("(1234.5).toLocaleString()", ".toLocaleString()"),
        ("new Intl.NumberFormat().format(3)", "Intl"),
        ("Date.now()", "Date.now()"),
        ("new Date().getFullYear()", "new Date()"),
        ("Math.random()", "Math.random()"),
    ] {
        let out = run(&env_page(expr));
        assert!(out.fallback.is_none(), "{expr}: {:?}", out.fallback);
        let m = manifest(&out);
        // One island, activated at load, rooted at the page.
        assert_eq!(islands_of(&m).len(), 1, "{expr}: {m}");
        assert!(m.contains(r#""activation":"load""#), "{expr}: {m}");
        assert!(
            m.contains(&format!("reads the client environment ({why})")),
            "{expr}: {m}"
        );
        // Activation computes and writes the hole (tier 0: applied at once).
        let chunk = &out.chunks[0].code;
        assert!(chunk.contains("$p($h());"), "{expr}: {chunk}");
    }
}

#[test]
fn environment_reads_flow_through_locals_and_props() {
    let out = run(r#"
import { $component } from "solid-js";
const Stamp = $component(function* (props) {
  return function* () { return <time>{yield* props.at}</time>; };
});
export const Page = $component(function* () {
  const now = new Date().toISOString();
  return function* () {
    return <main><Stamp at={now} /><b>{"static"}</b></main>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains("reads the client environment (new Date())"), "{m}");
    assert!(m.contains(r#""activation":"load""#), "{m}");
    // A deterministic view stays inert.
    let out = run(r#"
import { $component } from "solid-js";
export const Page = $component(function* (props) {
  const d = new Date(props.at).toISOString();
  return function* () { return <time>{d}</time>; };
});
"#);
    assert!(out.chunks.is_empty(), "{}", manifest(&out));
}

#[test]
fn an_environment_read_in_a_live_island_hole_applies_at_activation() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
export const Page = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return <button onClick={inc} title={`${yield* n} at ${Date.now()}`}>{yield* n}</button>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert_eq!(islands_of(&m).len(), 1, "{m}");
    assert!(m.contains(r#""activation":"load""#), "{m}");
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("$p($h());"), "{chunk}");
    // Handlers stay attached as before.
    assert!(chunk.contains("addEventListener(\"click\""), "{chunk}");
}

#[test]
fn a_show_over_the_environment_falls_back_with_the_reason() {
    let reason = fallback_of(
        r#"
import { $component, Show } from "solid-js";
export const Page = $component(function* () {
  return function* () {
    return <main><Show when={typeof window !== "undefined"}><p>client</p></Show></main>;
  };
});
"#,
    );
    assert!(reason.contains("over the client environment (window)"), "{reason}");
}

// --- serialization pruned to the paths client code reads ---------------------------

#[test]
fn a_prop_is_serialized_only_along_the_paths_client_code_reads() {
    let out = run(r#"
import { $component, $event, $signal, For } from "solid-js";
const Row = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const click = $event(function* () { setN(x => x + 1); console.log(props.item.title, props.item.by.name); });
  return function* () {
    return <li><span>{props.label}</span><button onClick={click}>{yield* n}</button></li>;
  };
});
export const Page = $component(function* (props) {
  return function* () {
    return <ul><For each={props.items}>{item => <Row item={item} label={"x" + item.id} />}</For></ul>;
  };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(
        m.contains(r#""serialized":["props.item.by.name","props.item.title"]"#),
        "{m}"
    );
    // Only those paths reach `data-s`; `label` (read by an inert hole) not at all.
    assert!(
        out.server
            .contains(r#""item": _$pp(_$r(props["item"]), [["by", "name"], ["title"]])"#),
        "{}",
        out.server
    );
    assert!(out.server.contains("function _$pp(v, ps)"), "{}", out.server);
    let ds = out.server.split("data-s=").nth(1).unwrap().split("}))}").next().unwrap();
    assert!(!ds.contains("label"), "{ds}");
}

#[test]
fn a_prop_used_whole_is_serialized_whole() {
    let out = run(r#"
import { $component, $event, $signal } from "solid-js";
const Row = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const click = $event(function* () { setN(x => x + 1); send(props.item); console.log(props.item.title); });
  return function* () { return <button onClick={click}>{yield* n}</button>; };
});
export const Page = $component(function* (props) {
  return function* () { return <main><Row item={props.item} /></main>; };
});
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""serialized":["props.item"]"#), "{m}");
    assert!(!out.server.contains("_$pp("), "{}", out.server);
}

// --- frames: compiler-derived server components -----------------------------------------

fn run_frames(src: &str) -> IslandsOutput {
    compile_islands(
        src,
        &IslandOptions {
            filename: Some("routes/story.tsx".into()),
            server_imports: vec![ServerImport {
                specifier: "../lib/hn".into(),
                names: None,
                tainted: vec!["getSecret".into()],
            }],
            ..IslandOptions::default()
        },
    )
    .expect("compiles")
}

const STORY_ROUTE: &str = r#"
import { $component, $event, $memo, $signal, attempt, For, Show } from "solid-js";
import type { RouteProps } from "@solidjs/router";
import { getStory } from "../lib/hn";
const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          {props.children}
        </ul>
      </>
    );
  };
});
const Comment = $component(function* (props) {
  return function* () {
    return (
      <li class="comment">
        <div class="by">{yield* props.comment.user}</div>
        <Show when={(yield* props.comment.comments).length}>
          <Toggle>
            <For each={yield* props.comment.comments}>{c => <Comment comment={c} />}</For>
          </Toggle>
        </Show>
      </li>
    );
  };
});
const Story = $component(function* (props: RouteProps<"/stories/:id">) {
  const story = yield* $memo(function* () {
    const id = yield* props.params.id;
    return yield* attempt(() => getStory(id));
  });
  return function* () {
    return (
      <div class="item-view">
        <h1>{(yield* story).title}</h1>
        <ul><For each={(yield* story).comments}>{c => <Comment comment={c} />}</For></ul>
      </div>
    );
  };
});
export default Story;
"#;

#[test]
fn a_route_components_server_call_is_a_frame() {
    let out = run_frames(STORY_ROUTE);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""frames":[{"id":"Story-"#), "{m}");
    assert!(m.contains(r#""driver":"route""#), "{m}");
    assert!(m.contains(r#""arguments":["id"]"#), "{m}");
    assert!(m.contains(r#""argumentsFrom":["props.params"]"#), "{m}");
    assert!(m.contains(r#""serverFunctions":["getStory"]"#), "{m}");
    // The toggle is a nested island, keyed by its server row.
    assert!(m.contains(r#""root":"Toggle","key":"row item id""#), "{m}");
    // Server: the region carries the frame id, the frame function renders
    // it from the argument alone, registered and declared GET.
    assert!(out.server.contains(r#"<div data-f="Story-"#), "{}", out.server);
    assert!(out.server.contains("const $$frame0 = async (...$a) => {"), "{}", out.server);
    assert!(out.server.contains("const id = $a[0];"), "{}", out.server);
    assert!(out.server.contains("(await getStory(...$a))"), "{}", out.server);
    assert!(out.server.contains("_$fget(_$fcsr(_$frsr("), "{}", out.server);
    assert!(out.server.contains("from \"@solidjs/web/server-functions\""), "{}", out.server);
    // Rows key their islands.
    assert!(out.server.contains("_$forK($c, "), "{}", out.server);
    assert!(out.server.contains("${_$k(props, $c)}"), "{}", out.server);
    // The navigation runtime's argument function.
    let fc = out.frames_client.as_deref().expect("route args");
    assert!(fc.contains("(props) => {\nconst id = props.params.id;\nreturn [id];"), "{fc}");
}

const SEARCH: &str = r#"
import { $component, $event, $memo, $signal, attempt, For } from "solid-js";
import { search } from "../lib/hn";
export const Search = $component(function* () {
  const [q, setQ] = yield* $signal("solid");
  const results = yield* $memo(function* () {
    const s = yield* q;
    return yield* attempt(() => search(s));
  });
  const input = $event(function* (e) { setQ(e.target.value); });
  return function* () {
    return (
      <section>
        <input value={yield* q} onInput={input} />
        <ul class="results"><For each={yield* results}>{r => <li>{r.title}</li>}</For></ul>
      </section>
    );
  };
});
"#;

#[test]
fn a_server_call_over_island_state_is_a_frame_driven_by_the_island() {
    let out = run_frames(SEARCH);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""driver":"island""#), "{m}");
    assert!(m.contains(r#""region":"<ul class=\"results\">"#), "{m}");
    assert!(m.contains(r#""argumentsFrom":["Search.q"]"#), "{m}");
    // The memo is never materialized on the client: the island is tier 0
    // (no async memo), and nothing is serialized for the results.
    assert!(m.contains(r#""tier":0"#), "{m}");
    assert!(!m.contains("memo results"), "{m}");
    assert!(out.server.contains(r#"<ul data-f="Search-"#), "{}", out.server);
}

#[test]
fn prefer_client_keeps_a_server_call_over_island_state_as_client_code() {
    let src = SEARCH.replace(
        "  const results = yield* $memo(",
        "  // @frame prefer: \"client\"\n  const results = yield* $memo(",
    );
    let out = run_frames(&src);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let m = manifest(&out);
    assert!(m.contains(r#""frames":[]"#), "{m}");
    assert!(m.contains(r#"prefer: \"client\""#), "{m}");
    // Today's compile: an adopted tier-2 memo, its value serialized.
    assert!(m.contains(r#""tier":2"#) && m.contains("memo results"), "{m}");
}

#[test]
fn a_call_that_is_not_a_server_function_is_not_a_frame() {
    let src = SEARCH.replace("import { search } from \"../lib/hn\";", "import { search } from \"./local\";");
    let out = run_frames(&src);
    let m = manifest(&out);
    assert!(m.contains(r#""frames":[]"#), "{m}");
    assert!(m.contains("is not a server function"), "{m}");
}

#[test]
fn a_frame_candidate_inside_client_control_flow_stays_client_code() {
    let out = run_frames(r#"
import { $component, $event, $memo, $signal, attempt, For, Show } from "solid-js";
import { search } from "../lib/hn";
export const Search = $component(function* () {
  const [q, setQ] = yield* $signal("solid");
  const [shown, setShown] = yield* $signal(true);
  const results = yield* $memo(function* () {
    const s = yield* q;
    return yield* attempt(() => search(s));
  });
  const input = $event(function* (e) { setQ(e.target.value); });
  const flip = $event(function* () { setShown(v => !v); });
  return function* () {
    return (
      <section>
        <input value={yield* q} onInput={input} />
        <button onClick={flip}>toggle</button>
        <Show when={yield* shown}>
          <ul class="results"><For each={yield* results}>{r => <li>{r.title}</li>}</For></ul>
        </Show>
      </section>
    );
  };
});
"#);
    let m = manifest(&out);
    assert!(m.contains(r#""frames":[]"#), "{m}");
    assert!(m.contains("client control flow"), "{m}");
}

#[test]
fn a_server_result_a_live_island_also_reads_is_not_a_frame() {
    let out = run_frames(r#"
import { $component, $event, $memo, $signal, attempt, For } from "solid-js";
import { search } from "../lib/hn";
export const Search = $component(function* () {
  const [q, setQ] = yield* $signal("solid");
  const [picked, setPicked] = yield* $signal(0);
  const results = yield* $memo(function* () {
    const s = yield* q;
    return yield* attempt(() => search(s));
  });
  const input = $event(function* (e) { setQ(e.target.value); });
  const pick = $event(function* () { setPicked(p => p + 1); });
  return function* () {
    return (
      <section>
        <input value={yield* q} onInput={input} />
        <p onClick={pick}>{(yield* results).length + (yield* picked)} picked</p>
        <ul class="results"><For each={yield* results}>{r => <li>{r.title}</li>}</For></ul>
      </section>
    );
  };
});
"#);
    let m = manifest(&out);
    assert!(m.contains(r#""frames":[]"#), "{m}");
    assert!(m.contains("a live island also reads it"), "{m}");
}

#[test]
fn an_island_serializing_a_tainted_value_is_a_build_error() {
    let err = compile_islands(
        r#"
import { $component, $event, $memo, $signal, attempt } from "solid-js";
import { getSecret } from "../lib/hn";
export const Account = $component(function* () {
  const account = yield* $memo(function* () { return yield* attempt(() => getSecret()); });
  const [shown, setShown] = yield* $signal(account());
  const show = $event(function* () { setShown(yield* account); });
  return function* () { return <p onClick={show}>{(yield* shown).email}</p>; };
});
"#,
        &IslandOptions {
            filename: Some("routes/account.tsx".into()),
            server_imports: vec![ServerImport {
                specifier: "../lib/hn".into(),
                names: None,
                tainted: vec!["getSecret".into()],
            }],
            ..IslandOptions::default()
        },
    )
    .map(|o| o.manifest)
    .expect_err("a build error");
    let msg = err.to_string();
    assert!(msg.contains("marked `@taint`"), "{msg}");
    assert!(msg.contains("Account.account"), "{msg}");
    // Rendered in inert markup, the same data is fine (HTML, not data).
    let out = run_frames(r#"
import { $component, $memo, attempt } from "solid-js";
import type { RouteProps } from "@solidjs/router";
import { getSecret } from "../lib/hn";
const Account = $component(function* (props: RouteProps<"/me">) {
  const account = yield* $memo(function* () { return yield* attempt(() => getSecret()); });
  return function* () { return <p class="me">{(yield* account).email}</p>; };
});
export default Account;
"#);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    assert!(manifest(&out).contains(r#""tainted":true"#), "{}", manifest(&out));
}

#[test]
fn an_island_frames_driver_refetches_the_region_through_the_lazy_applier() {
    let out = run_frames(SEARCH);
    assert!(out.fallback.is_none(), "{:?}", out.fallback);
    let chunk = &out.chunks[0].code;
    // The region is addressed statically; its content is not walked.
    assert!(
        chunk.contains("$hole([q], () => {\nconst s = q.v;\nreturn JSON.stringify([s]);\n}, v => { $frame($n"),
        "{chunk}"
    );
    assert!(
        chunk.contains(r#"const $frame = (e, v) => import("@solidjs/compiler/frames-client").then(m => m.frame(e, v));"#),
        "{chunk}"
    );
    // No list code: the rows are server HTML.
    assert!(!chunk.contains("$list"), "{chunk}");
}

#[test]
fn keyed_state_seeds_cells_and_exposes_them_on_the_anchor() {
    let out = compile_islands(
        TOGGLE,
        &IslandOptions {
            filename: Some("app.tsx".into()),
            keyed_state: true,
            ..IslandOptions::default()
        },
    )
    .unwrap();
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("export function activate($a, $st) {"), "{chunk}");
    assert!(chunk.contains("const open = $cell($st ? $st[0] : true);"), "{chunk}");
    assert!(
        chunk.contains("const $hole = $st ? (c, h, p) => { $hole0(c, h, p); p(h()); } : $hole0;"),
        "{chunk}"
    );
    assert!(chunk.contains(r#"($a.$ss ||= {})["i0"] = () => [open.v];"#), "{chunk}");
    assert!(manifest(&out).contains(r#""transplant":true"#), "{}", manifest(&out));
    // Without the option the chunk is unchanged.
    let plain = run(TOGGLE);
    assert!(plain.chunks[0].code.contains("export function activate($a) {"));
    assert!(!plain.chunks[0].code.contains("$st"));
}
