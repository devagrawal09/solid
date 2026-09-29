# Room — `@solidjs/blocks` twin (JSX flavor)

[`examples/room`](../room) — live server functions, a live server component, SSR with the router — written with `@solidjs/blocks`. The wire is the original's, verbatim: `src/lib/sources.ts`, `src/lib/rooms.ts`, `src/server-config.ts`, `server.js`, the chaos plugin in `vite.config.ts`. Every component is a block, the live server component included (`src/lib/room-panel.tsx`).

```bash
pnpm test         # behavior (7) + parity against examples/room (1): DOM + draft after 23 steps, both pages
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs room    # after building both (production servers)
```

## What the library's rules change

- **Components are `$component`s** with named setups (`$component(function* Card(props) {…})`, so dev owner labels read `<Live> › <Card>`). Handlers are `$event`s; the transport's `onstatus` hook reports through one (`createWire`).
- **The router is created in `App`'s setup** and the view returns it. `routes.ts` passes each route through `route()`: the router is plain Solid and cannot see a block's coloring, so `route()` states what it may be — pending (the app's `<Loading>` is above it), never failing.
- **`dynamic(() => roomPanel(room, me))` is created in `Panel`'s setup.** It is a plain Solid computation: its compute reads the props through `accessor(props.room)`. Such a computation's first pass runs while the setup is the host; its reads are its own, not the setup's (a runtime rule this app found — see below).
- **What a `<Loading>` covers is its own component**, handed to the boundary as a view: `<Loading>{Members({ who, me })}</Loading>`, or in the call form `Loading({ fallback, children: () => Members({ who, me }) })` — the content is a function so it is built inside the boundary.
- **Failures are typed.** A memo over a stream or a promise may fail with anything, so every panel that reads a live source may fail. The original lets that reach the app root; here `/live`'s page is wrapped in an `Errored` at its root, each directory row handles its own (a `For` row is settled), and the summary keeps its own `Errored`. With no failure, the markup is the original's.
- **Where the type linker cannot see an async value, the prop says so**: `who: Source<Presence, true, unknown>` (a memo returning `wire.watch(presence(…))` — a method call the syntax takes as synchronous). The linker's facts and a declared source join.
- **`live`'s call type is the answer itself** (`RoomCard & { onstatus }`), not a stream of it: the card memo is widened to `Source<RoomCard, boolean, unknown>` (an upcast, not a cast).
- **A row is settled**: the card's ticks read the (pending) activity once, into one flag per tick, and the rows read their flag.
- **Posting on `/live` is Solid's**: `createOptimisticStore`, `createOptimistic`, `action` + `until` are used as they are (the library has no optimistic forms); blocks read the store through `paths<…, true>` and the flag through `read`. The composer shows `latestOf(text)`.
- **Identity outside the provider is "nobody"** (the original throws; a setup does not fail).

No `any`, no casts.

## Tests

- `tests/fake-server-functions.ts` stands in for `@solidjs/web/server-functions` (aliased in `vitest.config.ts` for both apps): the `"use server"` bodies run in process against the in-memory rooms, `live` re-invokes on a death and reports `onstatus`, an undeclared stream (`GET` over an async generator) dies with an error. `fetch("/__chaos/drop")` is stubbed to kill every open call.
- The parity script drives both pages: the panel, the tab's join, a post, the chaos switch (a reconnect is a new render), a room switch, `/live`'s shell sources, the card's nested promise and stream, an optimistic post held for its echo, the summary dying under chaos and regenerating, the archive's room-keyed boundary. `Math.random` is seeded and time is fake, so both apps mint the same identity and ids.
- The fake remounts the panel on a reconnect (it cannot morph); the real transport keeps the composer's instance.

## Browser check (Chromium, production servers)

`/` is streamed with the panel in the document, hydrated, and joined; a post arrives as markup. `/live` is compared as streamed: over the production harness (HTTP/1.1, six connections per origin) its seven live sources do not connect in headless Chromium — the original's as well as the twin's. The chaos switch is the dev server's; the production harness answers the POST with the app's document. Normalized: the tab's random identity, clock times, render / connection counters, and frames' ids (`data-fid`), besides hydration keys and markers.

## Client bundle

| | min | gz |
| --- | ---: | ---: |
| original | 322,023 B | 111,464 B |
| twin | 332,570 B | 114,598 B (+2.8%) |
