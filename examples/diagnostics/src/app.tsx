import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { SCENARIO_IDS, clearFeed, startDiagnostics, type ScenarioId } from "./diagnostics/channel";
import { EvidencePanel } from "./diagnostics/Evidence";
import { ResultsPanel } from "./scenarios/tear/ResultsPanel";
import { CheckoutSummary } from "./scenarios/overrun/CheckoutSummary";
import { StoryCard } from "./scenarios/waterfall/StoryCard";
import { QuantityStepper } from "./scenarios/action/QuantityStepper";

const observing = startDiagnostics();

interface Scenario {
  id: ScenarioId;
  title: string;
  symptom: string;
  code: string;
  repair: string;
  view: (props: { broken: boolean }) => JSX.Element;
}

const SCENARIOS: Scenario[] = [
  {
    id: "tear",
    title: "1 · The frame nobody looks at",
    symptom:
      "Derived state kept in a signal and re-synced by an effect. Final values are right; for one frame the query and its results disagree.",
    code: "EFFECT_RELAY_TEAR",
    repair: "Make it a memo: one flush, no extra signal, lazy when nothing reads it.",
    view: ResultsPanel
  },
  {
    id: "overrun",
    title: "2 · The effect that runs on every keystroke",
    symptom:
      "A summary memo reads the whole cart — including the note being typed — and returns a fresh object each run, so its equality gate never closes.",
    code: "UNSTABLE_MEMO_OUTPUT",
    repair: "Derive from the state the summary is actually a function of.",
    view: CheckoutSummary
  },
  {
    id: "waterfall",
    title: "3 · Three requests standing in line",
    symptom:
      "story → author → avatar: each request is described with an id the previous response carried, so they can only run one after another.",
    code: "ASYNC_WATERFALL",
    repair: "Key every request by the id you already have and compose them in one place.",
    view: StoryCard
  },
  {
    id: "action",
    title: "4 · The click that lost an update",
    symptom:
      "An action reads the quantity before it awaits and writes it back after. Two fast clicks both read 0, both write 1 — behind a wait the screen never acknowledged.",
    code: "SILENT_HOLD",
    repair: "Write optimistically and let the server apply a delta.",
    view: QuantityStepper
  }
];

export function App(): JSX.Element {
  const [broken, setBroken] = createSignal(true);
  const [focused, setFocused] = createSignal<ScenarioId | "all">("all");

  const setMode = (next: boolean) => {
    for (const id of SCENARIO_IDS) clearFeed(id);
    clearFeed("other");
    setBroken(next);
  };

  const visible = () => SCENARIOS.filter(s => focused() === "all" || focused() === s.id);

  return (
    <main>
      <header class="masthead">
        <div>
          <h1>Four defects a compiler cannot see</h1>
          <p>
            Every code and number below arrives on Solid&nbsp;2&apos;s own dev channels —{" "}
            <code>OBSERVE.diagnostics</code> and <code>solid-js/attribution</code>. Nothing here is
            hardcoded.
          </p>
        </div>
        <div class="controls">
          <div class="switch" role="group" aria-label="mode">
            <button
              id="mode-broken"
              type="button"
              class={broken() ? "primary" : "ghost"}
              onClick={() => setMode(true)}
            >
              Broken
            </button>
            <button
              id="mode-fixed"
              type="button"
              class={broken() ? "ghost" : "primary"}
              onClick={() => setMode(false)}
            >
              Fixed
            </button>
          </div>
          <select
            id="focus"
            aria-label="focus one scenario"
            value={focused()}
            onChange={event => setFocused(event.currentTarget.value as ScenarioId | "all")}
          >
            <option value="all">All four</option>
            <For each={SCENARIOS}>{s => <option value={s.id}>{s.title}</option>}</For>
          </select>
        </div>
      </header>

      <Show
        when={observing}
        fallback={<p class="warn">This build has no diagnostics channel — run the dev server.</p>}
      >
        <p class="quiet mode-line">
          Showing the <strong>{broken() ? "broken" : "fixed"}</strong> implementation. Switching
          rebuilds each graph from scratch and clears the feeds.
        </p>
      </Show>

      <section class="grid">
        <For each={visible()}>
          {scenario => (
            <article class="card">
              <header>
                <h2>{scenario.title}</h2>
                <p>{scenario.symptom}</p>
                <p class="repair">
                  <code>{scenario.code}</code> → {scenario.repair}
                </p>
              </header>
              <Show when={broken()} fallback={<scenario.view broken={false} />}>
                <scenario.view broken={true} />
              </Show>
            </article>
          )}
        </For>
      </section>

      <section class="card">
        <header>
          <h2>Everything else the channel saw</h2>
          <p class="quiet">
            Diagnostics that did not belong to a scenario. An empty list means the demo&apos;s own
            UI is quiet.
          </p>
        </header>
        <EvidencePanel feed="other" />
      </section>
    </main>
  );
}
