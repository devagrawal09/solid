# attribution-lab-blocks

`examples/attribution-lab` rewritten with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
The models (`pagination.ts`, `catalog.ts`, `selection.ts`, `drafts.ts`,
`waterfall/api.ts`) and the engine (`lab/engine.ts`) are copied; the
components are blocks.

```sh
pnpm test        # the original's five suites against the twin + a parity test
pnpm typecheck   # solid-tsc (the v2 type layer)
pnpm build       # vite build (production tier: the banner only, as the original)
node ../../scripts/example-blocks/browser.mjs attribution-lab                 # both dev servers
node ../../scripts/example-blocks/browser.mjs attribution-lab --mode static   # both prod builds
```

`tests/{clamp,relay,waterfall,publish,lab}.test.tsx` and `tests/helpers.ts`
are the original's suites, unchanged, run against the twin's components: every
diagnostic, cause chain, waterfall and interaction record the original
asserts, the twin produces. `tests/parity.test.tsx` drives the whole lab
(every card, both variants, clear & re-arm) against both apps and compares the
DOM — cards and evidence panel — after all 36 steps.

## Porting notes

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| every card | `createEffect(compute, effect, { name: "pageLabel" })` etc. | the same plain `createEffect(…, { name })` in the setup | an effect block (`$effect` / `createEffect(function* …)`) takes no options, so it cannot carry a `name`; the lab's diagnostics, watch lists and cause chains are keyed on those names |
| `Pager`, `Results`, `Publisher`, `OrgBody` | `createPagination(props.variant)`, `createSelection(props.variant, …)`, `createPublisher(props.variant, props.latency)`, `createOrgChain(props.variant, …)` in the component body | the card is built per value (`lab/variants.ts`, `perValue`) and a thin `$component` picks the built one in its view | the variant decides which nodes exist; a v2 setup cannot read props, and a memo cannot create nodes, so the prop-dependent graph has to be chosen outside the setup |
| `OrgBody` | `props.onLanded(…)`, `props.startedAt` read in the `orgSummary` effect half | `OrgPage` provides them through a context the setup reads | the named effect is a plain effect, which cannot `yield*` a prop; a setup can read a context |
| `OrgBody` (broken) | `createMemo(() => api.fetchTeam(org().teamId), { name: "team" })` | `$memo(function* () { const teamId = (yield* org).teamId; …; return yield* attempt(() => api.fetchTeam(teamId)) }, { name: "team" })` | direct translation; the engine still proves `org → team → lead` from the cause chain |
| `OrgBody` view | `view().org.name` | the same direct call | `view` is a plain function combining three memos in the broken variant (not a node); a `$memo` would add a node the waterfall detector sees |
| `OrgPage` | `createDirectoryApi(props.latency ?? …)` in the body | `$memo` of `props.latency` | a setup does not read props |
| `App` | `const current = () => byId(scenarioId())` | a helper generator `function* current() { return byId(yield* scenarioId) }`, `yield* current()` in the view | a plain derived function is not a node; a helper generator keeps it that way |
| `App` | `const cardKey = () => \`${scenarioId()}:${variant()}:${nonce()}\`` | inlined in the view | a helper generator reading sources of *different* types infers its `next` type as their intersection (`never`), and TypeScript then refuses `yield* cardKey()` (TS2766) |
| `Report` | `newestFirst = () => lines().slice().reverse()` | inlined `(yield* lines).slice().reverse()` | same: a `$memo` would add a node to the graph the panel reports on |
| `App` tabs, `Results` rows | inline `For` callbacks with `class={{ selected: signal() === id }}` and `onClick={() => …}` | `ScenarioTab` component; `Results` rows keep a plain callback with a direct `selection.selectedId()` call and an `$event` factory | render callbacks cannot `yield*`; a render-callback block would keep both inline |
| `pagination.ts`, `catalog.ts` | interface fields typed `Accessor<T>` | `SourceAccessor<T>` (type-only change) | the plain `Accessor<T>` type is not iterable, so a block cannot `yield*` a model field declared with it, although the runtime value is a signal |
| `Report` | `onClear: () => void` | `onClear: (event: MouseEvent) => void` | an `$event` handler is typed `(event: E) => void` and is not assignable to a zero-argument callback type |

Observed in both apps (not a porting difference): under the Vite dev server in
Chromium the evidence panel stays empty for the whole script (no diagnostics
are logged either), while the same flows in jsdom (vitest, also the dev
tier) fill it.
