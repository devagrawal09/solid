/**
 * Scenario 3 — ASYNC_WATERFALL (examples/attribution-lab's OrgPage, written
 * with generator blocks v2).
 *
 * Story: show an organisation, its team, and that team's lead.
 *
 *   broken — three memos, each reading the previous one. `team` cannot even
 *            start until `org` has landed, because the id it needs is in
 *            `org`'s response. Three round trips end to end, and the engine
 *            proves the chain from the cause records.
 *
 *   fixed  — one memo, one scope. All three requests are launched from the
 *            same input in the same turn and composed with `Promise.all`.
 *
 * v2 notes:
 * - the chain's memos are `$memo` blocks that `yield* attempt(() => fetch…)`
 *   (named, as `$memo` takes options); the per-variant shape means `OrgBody`
 *   is built per variant (a setup does not read props);
 * - `orgSummary` stays a plain named `createEffect` (an effect block takes no
 *   `name`). Its effect half needs `onLanded` and `startedAt`, which the
 *   original read from props; a plain effect cannot `yield*` a prop, so
 *   `OrgPage` hands them down through a context, which a setup can read.
 */
import {
  $component,
  $event,
  $memo,
  $signal,
  For,
  Loading,
  Show,
  attempt,
  createContext,
  createEffect,
  type SourceAccessor,
  type TypedProps
} from "solid-js";
import { attribution } from "solid-js/attribution";
import { APP_LATENCY_MS, createDirectoryApi, type DirectoryApi } from "./api";
import type { Variant } from "../../lab/engine";
import { perValue } from "../../lab/variants";

/** Scope names whose re-runs this card renders in the report. */
export const WATERFALL_WATCH = ["orgSummary"] as const;

export interface OrgView {
  org: { name: string };
  team: { name: string };
  lead: { name: string; title: string };
}

export interface Landed {
  org: string;
  team: string;
  lead: string;
  title: string;
  /** Wall time from the click to the reader's first complete run. */
  ms: number;
}

export interface ChainView {
  names: string[];
  sequentialMs: number;
}

/** What `OrgPage` hands its body (the original passed these as props). */
interface Run {
  api: SourceAccessor<DirectoryApi>;
  startedAt: () => number;
  onLanded: (landed: Landed) => void;
}
const RunContext = createContext<Run>();

/** The run from context (provided by `OrgPage`). */
function* useRun() {
  const run = yield* RunContext;
  if (!run) throw new Error("OrgBody needs OrgPage's RunContext");
  return run;
}

const orgBodyFor = perValue((variant: Variant) =>
  $component(function* (props: TypedProps<{ id: number }>) {
    const run = yield* useRun();

    // The only code that differs between the variants.
    let view: () => OrgView;
    if (variant === "broken") {
      // ── the defect ────────────────────────────────────────────────────
      // Each memo's input is the previous memo's output, so the requests are
      // serialised by the shape of the graph.
      const org = yield* $memo(
        function* () {
          const id = yield* props.id;
          const api = yield* run.api;
          return yield* attempt(() => api.fetchOrg(id));
        },
        { name: "org" }
      );
      const team = yield* $memo(
        function* () {
          const teamId = (yield* org).teamId;
          const api = yield* run.api;
          return yield* attempt(() => api.fetchTeam(teamId));
        },
        { name: "team" }
      );
      const lead = yield* $memo(
        function* () {
          const leadId = (yield* team).leadId;
          const api = yield* run.api;
          return yield* attempt(() => api.fetchLead(leadId));
        },
        { name: "lead" }
      );
      view = () => ({ org: org(), team: team(), lead: lead() });
    } else {
      // The fix: one scope, every flight launched from the same input.
      view = yield* $memo(
        function* () {
          const id = yield* props.id;
          const api = yield* run.api;
          return yield* attempt(() =>
            Promise.all([api.fetchOrg(id), api.fetchTeamByOrg(id), api.fetchLeadByOrg(id)]).then(
              ([org, team, lead]) => ({ org, team, lead })
            )
          );
        },
        { name: "orgPage" }
      );
    }

    // The named reader. Its compute output is the view; what it writes
    // (through `onLanded`) is a different object, so it is not a copy relay.
    createEffect(
      view,
      page => {
        run.onLanded({
          org: page.org.name,
          team: page.team.name,
          lead: page.lead.name,
          title: page.lead.title,
          ms: Math.round(performance.now() - run.startedAt())
        });
      },
      { name: "orgSummary" }
    );

    return function* () {
      return (
        <dl class="lab-facts">
          <div>
            <dt>Organisation</dt>
            <dd id="org-name">{view().org.name}</dd>
          </div>
          <div>
            <dt>Team</dt>
            <dd id="team-name">{view().team.name}</dd>
          </div>
          <div>
            <dt>Lead</dt>
            <dd id="lead-name">{view().lead.name}</dd>
          </div>
        </dl>
      );
    };
  })
);

const OrgBody = $component(function* (props: TypedProps<{ variant: Variant; id: number }>) {
  return function* () {
    const Body = orgBodyFor(yield* props.variant);
    return <Body id={props.id} />;
  };
});

export const OrgPage = $component(function* (
  props: TypedProps<{ variant: Variant; latency?: number }>
) {
  const api = yield* $memo(function* () {
    return createDirectoryApi((yield* props.latency) ?? APP_LATENCY_MS);
  });
  const [runId, setRunId] = yield* $signal(0, { name: "runId" });
  const [landed, setLanded] = yield* $signal<Landed | null>(null, { name: "landed" });
  const [chains, setChains] = yield* $signal<ChainView[]>([], { name: "chains" });
  let startedAt = 0;

  const onLanded = (value: Landed) => {
    setLanded(value);
    // `history("waterfall")` is a fact table, not a signal — read it once the chain
    // has settled, from outside the flush that landed it.
    setTimeout(
      () =>
        setChains(
          attribution.history("waterfall").map(record => ({
            names: record.chain.map(link => link.name),
            sequentialMs: Math.round(record.sequentialMs)
          }))
        ),
      0
    );
  };
  const run: Run = { api, startedAt: () => startedAt, onLanded };

  const load = $event(function* () {
    startedAt = performance.now();
    yield* setLanded(null);
    yield* setChains([]);
    yield* setRunId(n => n + 1);
  });

  return function* () {
    const latency = (yield* props.latency) ?? APP_LATENCY_MS;
    return (
      <RunContext value={run}>
        <div class="lab-stage">
          <div class="lab-controls">
            <button id="load-org" onClick={load}>
              Load organisation
            </button>
          </div>

          <Show
            when={yield* runId}
            keyed
            fallback={<p class="lab-hint">Press “Load organisation” to start the requests.</p>}
          >
            {id => (
              <Loading fallback={<p class="lab-pending">fetching…</p>}>
                <OrgBody variant={props.variant} id={id} />
              </Loading>
            )}
          </Show>

          <Show when={yield* landed}>
            {value => (
              <p class="lab-readout" id="landed">
                {`${value().org} · ${value().team} · ${value().lead} — painted ${value().ms}ms after the click`}
              </p>
            )}
          </Show>

          <Show when={(yield* chains).length > 0}>
            <div class="lab-timeline">
              <h4>attribution.history("waterfall")</h4>
              <ul id="flight-chains">
                <For each={yield* chains}>
                  {chain => (
                    <li>
                      <code>{chain.names.join(" → ")}</code>
                      <span class="lab-role">{`${chain.sequentialMs}ms sequential`}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          <p class="lab-hint">
            {`Each request takes ~${latency}ms. Three sequential requests paint in ~${latency * 3}ms; three parallel ones paint in ~${latency}ms.`}
          </p>
        </div>
      </RunContext>
    );
  };
});
