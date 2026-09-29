# Notes — `@solidjs/blocks` twin (JSX flavor)

[`examples/notes`](../notes) — the React server-components notes demo as Solid Server Components with single-flight mutations — written with `@solidjs/blocks`. The frames wiring (`start: {}`, `ssr: true`, `serverFunctions: { components: true, configure }`), the flight collector registration (`src/server-config.ts`), the route tree and preloads (`src/routes.ts`), the data layer and the mutations (`src/lib/*`, `src/server/actions.ts`), `server.js` and the styles are the original's.

```bash
pnpm test         # behavior (8) + parity against examples/notes (1): URL + DOM after 18 steps
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs notes                      # 12 steps
node ../../scripts/example-blocks/browser.mjs notes --variant mutations  # save, create, delete (8 steps)
```

## What is converted

Every component, on both sides of the border:

| Module                                                                                               | As blocks                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.tsx`                                                                                        | `App` creates the shell's `dynamic()` and the router's tree in its setup; the router's render callback renders `Shell`, whose setup creates the list's `dynamic()` (its source the search param, through an `accessor`) and the search behavior.                                                                                          |
| `src/server/App.tsx`, `Note.tsx`, `NoteList.tsx` — the `"use server"` views                          | Each answers with a `$component`. The shell takes its behavior props (event handlers, refs) once with `$snapshot` — event and ref positions take values — and the frame's claim markers still name the client props. The list and the edit view take their slots once and render them as tags (`<Item $key={note.id} …>`, `<Editor …/>`). |
| `src/components/SidebarNoteContent.tsx` — the list's client slot                                     | `$signal` for expanded, `$event`s, the active state a hole block over `read(() => location.pathname)`, the title-change flash an `$effect` that keeps the previous title (an effect block has no `prev`).                                                                                                                                 |
| `src/components/NoteEditor.tsx` (lazy, both editor routes)                                           | Seeds its state once from the slot args (`$snapshot`: the `initial*` contract the original states with `untrack`), `$event` inputs, the router's actions in `<form action>`.                                                                                                                                                              |
| `EditButton`, `NotePreview`, routes (`home`, `note`, `edit`, `new`, `not-found`), `src/Document.tsx` | `$component`s; `note` / `edit` create their `dynamic()` in the setup; `not-found` navigates from its setup. The document shell `start` renders into is a block too.                                                                                                                                                                       |
| `src/components/searchField.ts`                                                                      | Not a component: called in `Shell`'s setup; its event props are `$event`s, its ref props stay plain functions (they run at adoption and create plain Solid effects over the router's state).                                                                                                                                              |

The experiment branch's port had to keep `EditButton`, `SidebarNoteContent` and every server view plain (lost `data-lha` addresses, slots re-rendered instead of adopted, router link claims throwing in dev). None of that occurs here: the browser check compares the adopted DOM, attribute addresses included, and the tests run the development runtime.

Casts: none in block code. `NotePreview`'s `marked(…) as string`, `searchField`'s `e.target as HTMLInputElement` and `search.searchText as string`, and the store reads in `src/lib/db.ts` / `src/server/actions.ts` are the original's, verbatim.

## Library fix this port found

Block JSX declared its own `SerializableAttributeValue`, so the router's `action()` was not assignable to `<form action>`; it is now web's own.

## Tests

- Both apps client-only in jsdom (development runtime): the server components and the actions run in process, each app against its own in-memory store (the router's query cache is cleared between the two runs).
- Behavior: the shell, the list and the empty state; opening a note (server-rendered markdown, the Edit link, the active entry); expand / collapse; search (match, no match, clear); the editor's live preview; save, create and delete through the router's actions with their redirects; the catch-all redirect.
- Parity: 18 steps through all of the above; the URL and the DOM after each (clock times normalized).

## Browser check (Chromium, production servers)

12 steps (SSR of `/`, a note, the lazy editor, `/new`, a search deep link; client navigation, expand, search, typing in the editor) and the `mutations` variant (save, create and delete, each one single-flight round trip: redirect, list and note). No console errors, page errors or hydration warnings; the same DOM after every step.

**Found (not the twin's):** SSR of an unknown route fails to hydrate in the original as in the twin, every time: `NotFound` navigates home while hydrating and a Loading boundary's collection queue reads a disposed node (`TypeError: Cannot read properties of undefined (reading 'h')` in `CollectionQueue` during `drainHydrationCallbacks`, from the router's navigation). `--variant unknown` reproduces it for both apps; the client-side redirect is covered by the jsdom suites.

## Client bundle

|          |       min |                gz |
| -------- | --------: | ----------------: |
| original | 335,705 B |         115,978 B |
| twin     | 348,053 B | 120,644 B (+4.0%) |
