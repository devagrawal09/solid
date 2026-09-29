/**
 * The lab shell: four cards, each with a Broken / Fixed switch, beside one
 * evidence panel.
 *
 * Two invariants hold the demo together:
 *
 *   1. `arm()` runs BEFORE the card mounts. It is called from the same click
 *      handler that switches scenario or variant, ahead of the writes that
 *      cause the remount, so the new card's creation runs are attributed and
 *      the engine's once-per-key verdict ledgers start empty. Without the
 *      `disable()` inside `arm()`, a second visit to a Broken card would be
 *      silent: cycle and tear verdicts report once per key.
 *
 *   2. The card is keyed on `scenario:variant`, so switching either one
 *      disposes every node and builds fresh ones. Some of the engine's
 *      once-only flags live on the nodes themselves; reusing them would make
 *      the second demonstration lie.
 *
 * Written with generator blocks v2 (examples/attribution-lab's App): the
 * handlers are `$event`s; `current()` / `cardKey()` — plain derived functions
 * in the original, not nodes — are helper generators the view `yield*`s, so
 * the port adds no memo to the graph the lab reports on.
 */
import { $component, $event, $signal, For, Show, type TypedProps } from "solid-js";
// `main.tsx` refuses to render this component at all on the production tier
// (no `OBSERVE`, no channels), so everything below can assume they exist.
import { arm, type Variant } from "./lab/engine";
import { Report } from "./lab/report";
import { CLAMP_WATCH, Pager } from "./scenarios/clamp/Pager";
import { RELAY_WATCH, Results } from "./scenarios/relay/Results";
import { WATERFALL_WATCH, OrgPage } from "./scenarios/waterfall/OrgPage";
import { PUBLISH_WATCH, Publisher } from "./scenarios/publish/Publisher";
import type { Element as SolidElement } from "solid-js";

interface Scenario {
  id: string;
  n: number;
  title: string;
  code: string;
  /** What the card is about, in one sentence. */
  blurb: string;
  /** The broken → fixed diff, in one line each. */
  broken: string;
  fixed: string;
  /** How to drive it. */
  script: string;
  watch: readonly string[];
  waterfalls?: { minFlightMs: number };
  render(variant: Variant): SolidElement;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "clamp",
    n: 1,
    title: "The effect that corrects its own input",
    code: "EFFECT_WRITES_OWN_SOURCE",
    blurb:
      "Page 6 stops existing when the page size grows. Clamping it in an effect takes a second flush — and renders an impossible state in between.",
    broken:
      "createEffect(() => ({ page: page(), max: pageCount() }), v => { if (v.page > v.max) setPage(v.max) })",
    fixed: "const page = createMemo(() => Math.min(rawPage(), pageCount()))",
    script: "Press “Next page” 5 times, then switch to 25 per page.",
    watch: CLAMP_WATCH,
    render: variant => <Pager variant={variant} />
  },
  {
    id: "relay",
    n: 2,
    title: "Derived state kept in sync by an effect",
    code: "EFFECT_RELAY_TEAR",
    blurb:
      "Filtering the list has to move the selection. Doing it with a write makes every reader of both values run twice for one keystroke, and the first frame is inconsistent.",
    broken:
      "createEffect(visibleIds, ids => { if (!ids.includes(selectedId())) setSelectedId(ids[0]) })",
    fixed:
      "const selectedId = createMemo(() => visibleIds().includes(chosen()) ? chosen() : visibleIds()[0])",
    script: "Select Ada Lovelace, then filter to “li”, then “ken”, then “den”.",
    watch: RELAY_WATCH,
    render: variant => <Results variant={variant} />
  },
  {
    id: "waterfall",
    n: 3,
    title: "The accidental request chain",
    code: "ASYNC_WATERFALL",
    blurb:
      "Three memos, each needing an id the previous response carried. Nothing is wrong with any single one; together they are three round trips where one would do.",
    broken: "const team = createMemo(() => fetchTeam(org().teamId))  // waits on org",
    fixed: "Promise.all([fetchOrg(id), fetchTeamByOrg(id), fetchLeadByOrg(id)])",
    script: "Press “Load organisation” and watch the paint time.",
    watch: WATERFALL_WATCH,
    waterfalls: { minFlightMs: 50 },
    render: variant => <OrgPage variant={variant} />
  },
  {
    id: "publish",
    n: 4,
    title: "The action that lost its click",
    code: "provenance only — no diagnostic",
    blurb:
      "Both variants finish in exactly the same state. Only the attribution record shows that one of them stopped being an action halfway through.",
    broken: "const r = await upload(d);        setProgress(p => p + 1)   // external",
    fixed: "const r = await upload(d); yield; setProgress(p => p + 1)   // action “publish”",
    script: "Press “Publish 3 drafts” once.",
    watch: PUBLISH_WATCH,
    render: variant => <Publisher variant={variant} />
  }
];

const byId = (id: string) => SCENARIOS.find(scenario => scenario.id === id)!;

export const App = $component(function* () {
  const [scenarioId, setScenarioId] = yield* $signal(SCENARIOS[0].id);
  const [variant, setVariant] = yield* $signal<Variant>("broken");
  const [nonce, setNonce] = yield* $signal(0);
  function* current() {
    return byId(yield* scenarioId);
  }

  /** Re-arm first, then write: the remount must happen under the new engine. */
  function select(id: string, next: Variant) {
    const scenario = byId(id);
    arm({ watch: scenario.watch, waterfalls: scenario.waterfalls });
    setScenarioId(id);
    setVariant(next);
    setNonce(n => n + 1);
  }
  const selectTab = (id: string) =>
    $event(function* () {
      select(id, "broken");
    });
  const selectVariant = (next: Variant) =>
    $event(function* () {
      select(yield* scenarioId, next);
    });
  const rearm = $event(function* () {
    select(yield* scenarioId, yield* variant);
  });

  return function* () {
    return (
      <div class="app">
        <header class="app-header">
          <h1>
            Attribution <span class="times">Lab</span>
          </h1>
          <p>
            Four reactivity defects a compiler cannot see. Each card runs the same story twice —
            once with the defect, once without — and the panel on the right is Solid's own
            diagnostics and attribution channels, unedited.
          </p>
        </header>

        <nav class="tabs" aria-label="Scenarios">
          <For each={SCENARIOS}>
            {scenario => (
              <ScenarioTab
                scenario={scenario}
                current={scenarioId}
                onSelect={selectTab(scenario.id)}
              />
            )}
          </For>
        </nav>

        <main>
          <section class="panel card">
            <header>
              <h2>{(yield* current()).title}</h2>
              <p>{(yield* current()).blurb}</p>
            </header>

            <div class="variant-switch" role="group" aria-label="Variant">
              <button
                id="variant-broken"
                class={["seg", { selected: (yield* variant) === "broken" }]}
                onClick={selectVariant("broken")}
              >
                Broken
              </button>
              <button
                id="variant-fixed"
                class={["seg", { selected: (yield* variant) === "fixed" }]}
                onClick={selectVariant("fixed")}
              >
                Fixed
              </button>
            </div>

            <pre class={(yield* variant) === "broken" ? "diff broken" : "diff fixed"}>
              {(yield* variant) === "broken" ? (yield* current()).broken : (yield* current()).fixed}
            </pre>

            {/* Keying the card on all three forces a fresh set of nodes for
                every demonstration — see the note at the top of this file.
                The nonce is what makes "Clear & re-arm" (and re-picking the
                variant you are already on) rebuild rather than quietly reuse
                nodes that have already reported. (Inline rather than a
                `cardKey()` helper generator: a helper reading sources of
                different types infers its `next` type as their intersection,
                `never`, and cannot be delegated to from the view.) */}
            <Show when={`${yield* scenarioId}:${yield* variant}:${yield* nonce}`} keyed>
              {key => {
                const [id, active] = key.split(":") as [string, Variant, string];
                return byId(id).render(active);
              }}
            </Show>

            <p class="lab-script">{(yield* current()).script}</p>
          </section>

          <Report watching={(yield* current()).watch} onClear={rearm} />
        </main>
      </div>
    );
  };
});

/**
 * One scenario tab. The original writes it inline in the `For` callback with
 * `class={["tab", { selected: scenarioId() === scenario.id }]}`; a render
 * callback cannot `yield*`, so the tab is a component (a render-callback block
 * would keep it inline).
 */
const ScenarioTab = $component(function* (
  props: TypedProps<{ scenario: Scenario; current: string; onSelect: (e: MouseEvent) => void }>
) {
  return function* () {
    const scenario = yield* props.scenario;
    return (
      <button
        id={`tab-${scenario.id}`}
        class={["tab", { selected: (yield* props.current) === scenario.id }]}
        onClick={yield* props.onSelect}
      >
        <span>{`${scenario.n}. ${scenario.title}`}</span>
        <small>{scenario.code}</small>
      </button>
    );
  };
});
