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
