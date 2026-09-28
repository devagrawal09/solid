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
    assert!(out.server.contains("<div data-i=\"i0\">"), "{}", out.server);
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

#[test]
fn live_sites_under_server_driven_structure_are_refused() {
    let reason = fallback_of(
        r#"
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
"#,
    );
    assert!(
        reason.contains("renders itself")
            || reason.contains("server values")
            || reason.contains("no single component"),
        "{reason}"
    );
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
    assert!(m.contains("async memo `user`") && m.contains(r#""tier":2"#), "{m}");
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
  const user = yield* $memo(function* () { const u = yield* attempt(() => load(yield* id)); return u.name; });
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
    assert!(chunk.contains(r#"(await (() => fetch("/n"))())"#), "{chunk}");
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
    assert!(out.server.contains(r#"Child({ "t": "x" }, $c)"#), "{}", out.server);
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
    assert!(s.contains(r#"{"name":"createCounter","kind":"factory"}"#), "{s}");
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
    assert!(out.server.contains(r#"import { plain } from "./counter";"#), "{}", out.server);
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
    assert!(out.server.contains(r#"import { Theme } from "./theme";"#), "{}", out.server);
    assert!(!out.server.contains("createContext(\"light\")"), "{}", out.server);
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
