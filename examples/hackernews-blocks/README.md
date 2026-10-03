# HackerNews (server components) — `@solidjs/blocks` twin (JSX flavor)

[`examples/hackernews`](../hackernews) — HackerNews as Solid Server Components over frame streams — written with `@solidjs/blocks`. The frames wiring (`start: {}`, `ssr: true`, `serverFunctions.components`), the data layer (`src/lib/hn.ts`; `src/lib/api.ts`: the server components wrapped in the router's `query`), the route tree and preloads, `server.js` and the styles are the original's (the 600KB thread capture is imported from the original).

```bash
pnpm test         # behavior (7) + parity against examples/hackernews (1): URL + DOM after 15 steps
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs hackernews                   # 13 steps
node ../../scripts/example-blocks/browser.mjs hackernews --variant thread  # the 1,406-comment thread
```

## What is converted

Everything that is a component:

| Module                                                                       | As blocks                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/views.tsx` — the `"use server"` views (nav, stories, story, user)   | Each call answers with a `$component` whose view renders the markup from the data the call awaited. The story view takes its `toggle` slot once (`$snapshot`) and hands it to the recursive `comment` helper, which calls it as the original does (`toggle({ children })`: a helper returning markup, not a component, in the original as here). |
| `src/components/toggle.tsx` — the client component filling the `toggle` slot | `$component` with a `$signal` and an `$event` (the hackernews-spa twin's).                                                                                                                                                                                                                                                                       |
| `src/routes/*`                                                               | `$component`s whose **setup** creates the `dynamic()` over the query-wrapped server component, its source reading the route's props through `accessor`s (a plain Solid computation, tracked: a new feed, page or id re-calls it and the response morphs the boundary). The view renders the instance.                                            |
| `src/app.tsx`                                                                | `$component` whose setup creates the nav's `dynamic()` and the router's tree.                                                                                                                                                                                                                                                                    |

Not converted: nothing that renders. `src/lib/api.ts` (the `query` wrappers), `src/lib/hn.ts` (the server-only data source) and `server.js` are data and transport, used as they are. The server views' failures are not typed through the router (the `dynamic` instance is plain Solid; the route components are settled), as in the original.

The pitfalls the experiment branch's port hit do not occur on this library, and each is checked here: a `Toggle` block in a document-rendered thread adopts the server's markup (the thread variant compares the DOM after load, collapse and expand); the server views keep the frames runtime's attribute-hole addresses (`data-lha`) on SSR and after client navigation (compared unnormalized); routes mounted by client navigation appear with the `dynamic` created in the setup and the instance rendered in the view.

Casts: none in block code. `src/lib/hn.ts` (`cachedStory as unknown as StoryDefinition`) and `storyType` (`as StoryTypes`) are the original's, verbatim.

## Tests

- The apps run client-only in jsdom: `~/lib/views` is an ordinary module, so each route's `dynamic(() => getStory(id))` resolves the server component in process — the `toggle` slot included — with `fetch` answering the HN API from `tests/fixtures/hn-data.mjs`.
- Behavior (7) and parity (15 steps, URL + DOM) as in the hackernews-spa twin; the markup is the same app's.

## Browser check (Chromium, production servers)

Both servers are started with `tests/fixtures/hn-fetch.mjs`. 13 steps (SSR of `/`, paging, every feed, a story with collapse / expand, a user, SSR of a user with an about and of `/show?page=2`, back to top) and the `thread` variant (SSR of the capture in a fresh page, collapse, expand, its author). No console errors, page errors or hydration warnings; the same DOM after every step.

## Client bundle

|          |       min |                gz |
| -------- | --------: | ----------------: |
| original | 292,781 B |         102,461 B |
| twin     | 302,679 B | 106,166 B (+3.6%) |
