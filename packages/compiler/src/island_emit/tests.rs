//! Unit tests: the island partitioner, the tier selector, and both emitters.
use super::*;

fn opts() -> IslandOptions {
    IslandOptions { filename: Some("app.tsx".into()), ..IslandOptions::default() }
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
    assert!(m.contains(r#"{"name":"Comment","class":"inert","islands":[]}"#), "{m}");
    assert!(m.contains(r#"{"name":"Page","class":"inert","islands":[]}"#), "{m}");
    assert_eq!(out.chunks.len(), 1);
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("@solidjs/signals/t0"), "{chunk}");
    assert!(chunk.contains("$cell(true)"), "{chunk}");
    assert!(chunk.contains("addEventListener(\"click\""), "{chunk}");
    // No reactive runtime.
    assert!(!chunk.contains("createRenderEffect"), "{chunk}");
    // Server: the anchor on the first element, no markers on inert holes.
    assert!(out.server.contains("data-i=\\\"i0\\\"") || out.server.contains("data-i=\"i0\""), "{}", out.server);
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
    assert!(m.contains(r#""members":["App","Counter","Display"]"#) || m.contains(r#""members":["App","#), "{m}");
    assert!(m.contains(r#""ownTiers":{"#), "{m}");
    let chunk = &out.chunks[0].code;
    assert!(chunk.contains("@solidjs/signals/kernel"), "{chunk}");
    assert!(chunk.contains("$M("), "{chunk}");
}

#[test]
fn a_store_needs_tier2_and_falls_back() {
    let out = run(r#"
import { $component, $event, $store } from "solid-js";
export const App = $component(function* () {
  const [s, setS] = yield* $store({ n: 1 });
  const inc = $event(function* () { setS(x => { x.n++; }); });
  return function* () { return <button onClick={inc}>{yield* s.n}</button>; };
});
"#);
    let reason = out.fallback.expect("falls back");
    assert!(reason.contains("tier 2"), "{reason}");
    assert!(out.client.is_some());
    assert!(out.server.contains("ssr"), "{}", out.server);
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
    compile_islands(src, &opts()).expect("compiles").fallback.expect("falls back")
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
    assert!(m.contains(r#""root":"App""#) && m.contains(r#""members":["App","Child"]"#), "{m}");
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
    assert!(m.contains(r#""tier":1"#) && m.contains("`b` is written by an effect"), "{m}");
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
    assert!(out.chunks[0].code.contains("export let setLabel;"), "{}", out.chunks[0].code);
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
    assert_eq!(out.chunks[0].code.matches("console.log(\"setup\")").count(), 1);
}

#[test]
fn a_member_rendered_outside_its_island_root_is_refused() {
    let reason = fallback_of(r#"
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
"#);
    assert!(reason.contains("no single component renders every member"), "{reason}");
}

#[test]
fn live_sites_under_server_driven_structure_are_refused() {
    let reason = fallback_of(r#"
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
    assert!(
        reason.contains("renders itself") || reason.contains("server values") || reason.contains("no single component"),
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
    assert!(out.chunks[0].code.contains("$show("), "{}", out.chunks[0].code);
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
    assert!(out.server.contains("const story = _$v(await (async () =>"), "{}", out.server);
    assert!(out.server.contains("export const Page = async function"), "{}", out.server);
}

#[test]
fn an_async_memo_read_by_a_live_island_needs_tier2() {
    let reason = fallback_of(r#"
import { $component, $event, $memo, $signal, attempt } from "solid-js";
export const App = $component(function* () {
  const [id, setId] = yield* $signal(1);
  const user = yield* $memo(function* () { const i = yield* id; return yield* attempt(() => load(i)); });
  const next = $event(function* () { setId(x => x + 1); });
  return function* () { return <p onClick={next}>{(yield* user).name}</p>; };
});
"#);
    assert!(reason.contains("tier 2") && reason.contains("async memo"), "{reason}");
}

#[test]
fn component_call_forms_and_live_jsx_expressions_fall_back() {
    let reason = fallback_of(r#"
import { $component, Loading } from "solid-js";
const Child = $component(function* () { return function* () { return <b />; }; });
export const App = $component(function* () {
  return function* () { return <main>{Loading({ fallback: "…", children: Child({}) })}</main>; };
});
"#);
    assert!(reason.contains("component call form"), "{reason}");
    let reason = fallback_of(r#"
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [on, setOn] = yield* $signal(false);
  const flip = $event(function* () { setOn(x => !x); });
  return function* () { return <div onClick={flip}>{(yield* on) ? <b>on</b> : <i>off</i>}</div>; };
});
"#);
    assert!(reason.contains("live expression producing JSX"), "{reason}");
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
        out.server.contains("<b>${_$e(n())}</b> <!--$-->${_$e(n())}<!--/--> of ${_$e(_$r(props.total))}</p>"),
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
        out.server.contains(r#"data-s="${_$ea(JSON.stringify({ "i0": { "step": _$r(props["step"]) } }))}""#),
        "{}",
        out.server
    );
    assert!(
        out.chunks[0].code.contains(r#"const $d = JSON.parse($a.getAttribute("data-s"))"#),
        "{}",
        out.chunks[0].code
    );
    assert!(out.manifest.contains(r#""serialized":["props.step"]"#), "{}", out.manifest);
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
    assert!(out.server.contains("<a href=\"/x\" data-pd>"), "{}", out.server);
    assert!(out.manifest.contains(r#""preventDefault":true"#));
}

#[test]
fn min_tier_binds_the_same_chunk_to_the_core() {
    let t1 = compile_islands(TOGGLE, &IslandOptions { min_tier: 1, ..opts() }).unwrap();
    assert!(t1.chunks[0].code.contains("\"@solidjs/signals/kernel\""), "{}", t1.chunks[0].code);
    let t2 = compile_islands(TOGGLE, &IslandOptions { min_tier: 2, ..opts() }).unwrap();
    assert!(t2.chunks[0].code.contains("from \"@solidjs/signals\""), "{}", t2.chunks[0].code);
    assert_eq!(t1.chunks[0].code.replace("@solidjs/signals/kernel", "@solidjs/signals"), t2.chunks[0].code);
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
    for ts in ["interface", ": Item", "as Item", "<Item[]>", "(e: MouseEvent)"] {
        assert!(!chunk.contains(ts), "`{ts}` left in {chunk}");
    }
    assert!(chunk.contains("function first(list) {"), "{chunk}");
}

#[test]
fn module_state_shared_by_two_islands_is_refused() {
    let reason = fallback_of(r#"
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
"#);
    assert!(reason.contains("module-level mutable state"), "{reason}");
}
