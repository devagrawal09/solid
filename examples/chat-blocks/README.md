# Chat — `@solidjs/blocks` twin (JSX flavor)

[`examples/chat`](../chat) — a simulated LLM chat as Solid Server Components — written with `@solidjs/blocks`. The frames wiring (`start: {}`, `ssr: true`, `serverFunctions.components`), `server.js`, the model (`src/lib/model.ts`), the markdown and highlighting code and the styles are the original's. Every component is a block: the client app, the client `Status` rendered in the server's slot, the server components themselves (`src/lib/ai.tsx`) and the document shell `start` renders into (`src/Document.tsx`).

```bash
pnpm test         # behavior (7) + parity against examples/chat (1): DOM + draft after 18 steps
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs chat    # after building both (production servers)
```

## What the library's rules change

- **`App` is a `$component`**: signals and handlers (`$event`) in its setup; autoscroll is `$settled` + `$cleanup` (the original's `onSettled(() => { …; return teardown })`).
- **`dynamic()` is created in a setup**: the welcome reply's in `App`'s, each reply's in its message's **row block** (`<For>{function* (m) { const prompt = yield* $snapshot(m.prompt); const Reply = dynamic(() => reply(prompt)); … }}`). A `dynamic` created in a view would be re-created whenever the view re-rendered.
- **The copy handler is an `$event`.** The server puts it in an event position on each code block's button; delegation resolves it at dispatch, as in the original.
- **Server components are `$component`s.** `reply` and `welcome` answer with one component (`generation(gen)`): its setup creates the two `$memo`s over the async faces and the usage projection, and takes the slot and the copy handler once (`$snapshot` — a prop is a read); the view renders the slot as a tag, its args written as holes (`<StatusFill progress={yield* progress} stats={yield* stats} usage={usage} />`), so they stay live expressions at the slot border.
- **What a `<Loading>` covers is its own component**: a view that reads a pending source is pending. `Message`'s markdown is `Markdown`, handed to the boundary in the call form (`Loading({ fallback, children: () => Markdown(…) })`); `Status`'s three reads are `Meter`, `Ticker` and `Done`. Components add no owner, so hydration keys are the original's.
- **Failures are typed.** The reply's text is a memo over a stream, which may fail with anything; as in the original nothing handles it, so the boundary is the call form (a tag must be settled) and `Message` / the reply carry the failure in their types.
- **`Status`'s props say what they are**: each is pending until its first value lands (`Source<T, true>`); the slot passes plain values.

Casts: none in block code. `src/lib/model.ts` (`as AsyncIterable<T>`) and the markdown helper (`marked.parse(…) as string`) are the original's, verbatim. The original's `{ … } as Usage` seed is now a typed variable (same fields). The tests' `mount` casts an `App` to `(props: {}) => Node` for `createComponent` (it mounts the original and the twin alike).

## Tests

- `vitest.config.ts` runs both apps client-only: without server functions `~/lib/ai` is an ordinary module, so each reply's server component resolves in process and renders in jsdom (the slot, the projection and the claim-marked copy buttons included).
- Behavior: the welcome streaming through its states, the composer (disabled send, whitespace, submit, reset), independent replies and the fallback answer, copy and its label reset, autoscroll following while pinned, stopping once the reader scrolls up, re-pinning on send, and disconnecting on dispose.
- Parity: the same 18-step script against both apps under one fake clock; DOM (hydration markers normalized) and the input's draft after every step.

## Browser check (Chromium, production servers)

7 steps: the SSR welcome streams into the document, hydrates and finishes; a whitespace draft; two replies over server-function calls; copy and its reset; the fallback answer. No console errors, page errors or hydration warnings; the same DOM after every step. Normalized: generation timing (tok/s, seconds), frames' ids, claim-marker ids, besides hydration keys and markers.

## Client bundle

|          |       min |               gz |
| -------- | --------: | ---------------: |
| original | 202,169 B |         67,944 B |
| twin     | 208,764 B | 70,190 B (+3.3%) |
