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
 */
import { For, Show, createSignal } from "solid-js";
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

export function App() {
  const [scenarioId, setScenarioId] = createSignal(SCENARIOS[0].id);
  const [variant, setVariant] = createSignal<Variant>("broken");
  const [nonce, setNonce] = createSignal(0);
  const current = () => byId(scenarioId());
  // Keying the card on all three forces a fresh set of nodes for every
  // demonstration — see the note at the top of this file. The nonce is what
  // makes "Clear & re-arm" (and re-picking the variant you are already on)
  // rebuild rather than quietly reuse nodes that have already reported.
  const cardKey = () => `${scenarioId()}:${variant()}:${nonce()}`;

  /** Re-arm first, then write: the remount must happen under the new engine. */
  function select(id: string, next: Variant) {
    const scenario = byId(id);
    arm({ watch: scenario.watch, waterfalls: scenario.waterfalls });
    setScenarioId(id);
    setVariant(next);
    setNonce(n => n + 1);
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>
          Attribution <span class="times">Lab</span>
        </h1>
        <p>
          Four reactivity defects a compiler cannot see. Each card runs the same story twice — once
          with the defect, once without — and the panel on the right is Solid's own diagnostics and
          attribution channels, unedited.
        </p>
      </header>

      <nav class="tabs" aria-label="Scenarios">
        <For each={SCENARIOS}>
          {scenario => (
            <button
              id={`tab-${scenario.id}`}
              class={["tab", { selected: scenarioId() === scenario.id }]}
              onClick={() => select(scenario.id, "broken")}
            >
              <span>{`${scenario.n}. ${scenario.title}`}</span>
              <small>{scenario.code}</small>
            </button>
          )}
        </For>
      </nav>

      <main>
        <section class="panel card">
          <header>
            <h2>{current().title}</h2>
            <p>{current().blurb}</p>
          </header>

          <div class="variant-switch" role="group" aria-label="Variant">
            <button
              id="variant-broken"
              class={["seg", { selected: variant() === "broken" }]}
              onClick={() => select(scenarioId(), "broken")}
            >
              Broken
            </button>
            <button
              id="variant-fixed"
              class={["seg", { selected: variant() === "fixed" }]}
              onClick={() => select(scenarioId(), "fixed")}
            >
              Fixed
            </button>
          </div>

          <pre class={variant() === "broken" ? "diff broken" : "diff fixed"}>
            {variant() === "broken" ? current().broken : current().fixed}
          </pre>

          <Show when={cardKey()} keyed>
            {key => {
              const [id, active] = key.split(":") as [string, Variant, string];
              return byId(id).render(active);
            }}
          </Show>

          <p class="lab-script">{current().script}</p>
        </section>

        <Report watching={current().watch} onClear={() => select(scenarioId(), variant())} />
      </main>
    </div>
  );
}
