# chat-blocks

`examples/chat` (a simulated LLM chat as Solid Server Components) rewritten
with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
Same frames wiring (`start: {}`, `ssr: true`, `serverFunctions.components`),
server, model and styles.

```sh
pnpm build && pnpm start   # SSR + frames, as the original
pnpm test                  # vitest + jsdom (client-only): behavior + parity with examples/chat
pnpm typecheck             # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs chat   # Chromium, both production servers
```

The vitest config (`vitest.config.ts`) runs the apps client-only: without
server functions `~/lib/ai` is an ordinary module, so each reply's server
component resolves in-process and renders in jsdom. The parity test
(`tests/script.ts`) drives examples/chat's App and this twin's under one fake
clock. SSR, hydration and the streamed morphs are compared in Chromium by the
browser check (both `node server.js` builds, DOM after every step, console
and page errors, hydration warnings).

## What is v2 and what is not

| Module | v2? | Notes |
| --- | --- | --- |
| `src/app.tsx` `App` | yes | `$signal`s, `$event` handlers (submit, input), `$settled` + `$cleanup` for the autoscroll observer (the original's `onSettled(() => { …; return teardown })`). The per-message `For` callback stays a plain render callback (`m` is a plain object; the row holds no state), as does `copyCode` (DOM-only). |
| `src/lib/ai.tsx` `Message` (server) | yes | `$memo` over the text iterable, `yield*` reads; `props.copy` is read once in the view (`const copy = yield* props.copy`) because the code blocks are produced in a `.map` callback. The `_bnd` claim marker still names `copy`: the value read is the props stub carrying its prop name. |
| `src/lib/ai.tsx` components returned by `reply` / `welcome` (server) | **no** | as `$component`s they render and stream, but their view runs under its own `blockScope`: the `status` slot fill's hydration keys shift (`…status#0-10000` vs `…status#0-1000`) and the `usage` projection arg stops updating on the client (meter stuck at ¶ 0) |
| `src/components/status.tsx` `Status` (client, rendered in a server slot) | **no** | as a `$component` it is rendered inside the server component's scope instead of as a client fill: no hydration keys, live-hole markers around its reads, never updates |
| `src/Document.tsx` (the `start` document shell) | **no** | as a `$component` it adds a hydration-key level (`_hk=000100120` vs `0010020` on `<main>`), so the server's ids no longer match the client hydration root and the welcome reply never renders on the client |

The three "no" rows are findings (see the report); the plain versions are
the originals, unchanged.

## Porting notes

| Original | v2 | Why |
| --- | --- | --- |
| `<props.status progress={progress()} …/>` in a server component | `const StatusFill = yield* props.status; <StatusFill …/>` (tried; reverted with the component, see above) | a v2 prop is a read, not the value |
| `createMemo(() => gen.progress)` (an AsyncIterable) | `$memo(function* () { return gen.progress as unknown as string })` (tried) | `$memo` types its value as the body's return: a memo returning an async source needs a cast, which hides its pending state from the type layer |
| `onClick={props.copy}` inside `segments.map(…)` | `const copy = yield* props.copy` at the top of the view | a `.map` callback is a plain arrow and cannot `yield*`; a render-callback block would read it inline |
