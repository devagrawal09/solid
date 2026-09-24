/**
 * Scenario 3 — ASYNC_WATERFALL.
 *
 * Story: show an organisation, its team, and that team's lead.
 *
 *   broken — three memos, each reading the previous one. `team` cannot even
 *            start until `org` has landed, because the id it needs is in
 *            `org`'s response. Three round trips end to end. The engine does
 *            not guess at this: it proves that each flight's recompute was
 *            CAUSED by the previous flight's landing and that the flight
 *            started after that landing, then reports the chain. Depth 3 is
 *            `warn`; depth 2 would only be `info`.
 *
 *   fixed  — one memo, one scope. All three requests are launched from the
 *            same input in the same turn and composed with `Promise.all`, so
 *            nothing waits on anything: one round trip end to end. Nothing is
 *            sequential, so `attribution.waterfalls()` is empty and no
 *            diagnostic is emitted.
 *
 * Both variants read their async values under a `<Loading>` boundary — an
 * unguarded async read is its own (unrelated) finding, and the card is about
 * the waterfall.
 */
import { For, Loading, Show, createEffect, createMemo, createSignal } from "solid-js";
import { attribution } from "solid-js/attribution";
import { APP_LATENCY_MS, createDirectoryApi, type DirectoryApi } from "./api";
import type { Variant } from "../../lab/engine";

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

/**
 * The only code that differs between the variants. Returns an accessor that
 * yields the whole page once it is available (and throws `NotReadyError`
 * until then, which is what suspends the `<Loading>` boundary).
 */
export function createOrgChain(variant: Variant, api: DirectoryApi, id: number): () => OrgView {
  if (variant === "broken") {
    // ── the defect ──────────────────────────────────────────────────────
    // Each memo's input is the previous memo's output, so the requests are
    // serialised by the shape of the graph.
    const org = createMemo(() => api.fetchOrg(id), { name: "org" });
    const team = createMemo(() => api.fetchTeam(org().teamId), { name: "team" });
    const lead = createMemo(() => api.fetchLead(team().leadId), { name: "lead" });
    return () => ({ org: org(), team: team(), lead: lead() });
  }

  // The fix: one scope, every flight launched from the same input.
  const page = createMemo(
    () =>
      Promise.all([api.fetchOrg(id), api.fetchTeamByOrg(id), api.fetchLeadByOrg(id)]).then(
        ([org, team, lead]) => ({ org, team, lead })
      ),
    { name: "orgPage" }
  );
  return page;
}

function OrgBody(props: {
  variant: Variant;
  api: DirectoryApi;
  id: number;
  startedAt: number;
  onLanded: (landed: Landed) => void;
}) {
  const view = createOrgChain(props.variant, props.api, props.id);

  // The named reader. Its compute output is the view; what it writes (through
  // `onLanded`) is a different object, so it is not a copy relay.
  createEffect(
    view,
    page => {
      props.onLanded({
        org: page.org.name,
        team: page.team.name,
        lead: page.lead.name,
        title: page.lead.title,
        ms: Math.round(performance.now() - props.startedAt)
      });
    },
    { name: "orgSummary" }
  );

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
}

export function OrgPage(props: { variant: Variant; latency?: number }) {
  const api = createDirectoryApi(props.latency ?? APP_LATENCY_MS);
  const [runId, setRunId] = createSignal(0, { name: "runId" });
  const [landed, setLanded] = createSignal<Landed | null>(null, { name: "landed" });
  const [chains, setChains] = createSignal<ChainView[]>([], { name: "chains" });
  let startedAt = 0;

  const onLanded = (value: Landed) => {
    setLanded(value);
    // `waterfalls()` is a fact table, not a signal — read it once the chain
    // has settled, from outside the flush that landed it.
    setTimeout(
      () =>
        setChains(
          attribution.waterfalls().map(record => ({
            names: record.chain.map(link => link.name),
            sequentialMs: Math.round(record.sequentialMs)
          }))
        ),
      0
    );
  };

  return (
    <div class="lab-stage">
      <div class="lab-controls">
        <button
          id="load-org"
          onClick={() => {
            startedAt = performance.now();
            setLanded(null);
            setChains([]);
            setRunId(n => n + 1);
          }}
        >
          Load organisation
        </button>
      </div>

      <Show
        when={runId()}
        keyed
        fallback={<p class="lab-hint">Press “Load organisation” to start the requests.</p>}
      >
        {id => (
          <Loading fallback={<p class="lab-pending">fetching…</p>}>
            <OrgBody
              variant={props.variant}
              api={api}
              id={id}
              startedAt={startedAt}
              onLanded={onLanded}
            />
          </Loading>
        )}
      </Show>

      <Show when={landed()}>
        {value => (
          <p class="lab-readout" id="landed">
            {`${value().org} · ${value().team} · ${value().lead} — painted ${value().ms}ms after the click`}
          </p>
        )}
      </Show>

      <Show when={chains().length > 0}>
        <div class="lab-timeline">
          <h4>attribution.waterfalls()</h4>
          <ul id="flight-chains">
            <For each={chains()}>
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
        {`Each request takes ~${props.latency ?? APP_LATENCY_MS}ms. Three sequential requests paint in ~${(props.latency ?? APP_LATENCY_MS) * 3}ms; three parallel ones paint in ~${props.latency ?? APP_LATENCY_MS}ms.`}
      </p>
    </div>
  );
}
