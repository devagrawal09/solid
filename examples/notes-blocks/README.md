# notes-blocks

`examples/notes` (the React server-components notes demo as Solid Server
Components with single-flight mutations) with its client components and
routes rewritten in generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
The server components (`src/server/*`), the actions, the data layer, the
server entry and `serverFunctions: { components: true, configure }` are the
original's.

```sh
pnpm build && pnpm start   # production server (port 3006, as the original)
pnpm dev                   # vite dev (port 3011)
pnpm test                  # vitest + jsdom: behavior + parity with examples/notes
pnpm typecheck             # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs notes   # both production servers, Chromium
```

The jsdom suites run both apps client-only: the server components and the
actions run in-process, each app against its own in-memory store (the
router's module-level query cache is cleared between the two runs). The
parity test drives the whole demo — open, expand, search, edit with live
preview, save, create, delete, the catch-all redirect — and compares the URL
and the DOM after every step (clock times normalized). The browser check loads
every route by SSR and by client navigation against both production servers.

## What is v2 and what is not

| Module | v2? | Notes |
| --- | --- | --- |
| `app.tsx` (`App`) | yes | `<Router>` created in the setup (see ../hackernews-blocks); the router's render callback is a plain callback |
| routes `home`, `note`, `edit`, `new`, `not-found` | yes | `note`/`edit`: the id through a `$memo`, the `dynamic()` instance created in the setup |
| `NoteEditor` | yes | the lazily loaded client editor (both editor routes) |
| `NotePreview` | yes | rendered by the `noteView` server component and by the editor |
| `EditButton` | **no** | see below |
| `SidebarNoteContent` (the list's `item` slot) | **no** | see below |
| `searchField()` | **no** | not a component: a bag of event / ref props the server shell's elements are bound to (`_bnd`), resolved through the frame at dispatch |
| `server/*` (`appView`, `noteView`, `noteEditView`, `noteListView`) | **no** | returned server components (`async function` → render function); as `$component`s in ../chat-blocks the slot fill shifted hydration keys and projections stopped updating |

## Porting notes

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| `NoteEditor` | `untrack(() => ({ title: props.initialTitle, … }))` then `createSignal(initial.title)` | `const initial = yield* $memo(…yield* props.initialTitle…)`; `createSignal(() => initial().title)` | a setup cannot read props; `$signal` takes a value, not a derivation. The editor would now re-seed if the slot args changed while it is open (the original ignores that by contract; the app never does it) |
| `NoteEditor` | `{noteId != null && <form action={deleteNote.with(noteId)}>…}` | `const noteId = (yield* initial).noteId` at the top of the view | one read for both uses |
| `note.tsx`, `edit.tsx` | `dynamic(() => getNote(+props.params.id))` | `const id = yield* $memo(… +(yield* props.params.id)! …)`; `dynamic(() => getNote(id()))` | `dynamic`'s source is a plain thunk (no `yield*`); `!` because `TypedProps` maps the router's `Params` index signature to `string \| undefined` |
| `note.tsx`, `edit.tsx`, `App` | `return <View />` / `return <Router>…</Router>` | created in the setup, returned by the view | created in a view, client navigation breaks (../hackernews-blocks, ../hackernews-spa-blocks) |
| `not-found.tsx` | `useNavigate()("/", …); return null` | same call in the setup; the view returns `null` | |
| `EditButton` (tried) | `"noteId" in props` | `(yield* props.noteId) === undefined` | typed props list every key |
| children props (tried in `EditButton`, `SidebarNoteContent`) | `{props.children}` | `{props.children}` forwarded unread | `yield* props.children` over a `JSX.Element` prop fails to typecheck (TS2589, "type instantiation is excessively deep") and types the component as pending, so it is no longer a valid JSX element type |
| `SidebarNoteContent` (tried) | `location.pathname` in `isActive()` | `const pathname = createMemo(() => location.pathname)` in the setup, `yield* pathname` in the view | the router's location is a getter object, neither a node nor a store: a view cannot `yield*` it, and a direct read throws `DIRECT_READ_IN_BLOCK` |
| `SidebarNoteContent` (tried) | `createEffect(() => props.title, (title, prev) => …)` | `$effect` with the previous title in a local | an effect block has no `prev` |

## Kept plain, and why

- **`EditButton`** renders only inside server components. As a `$component`
  its server-rendered anchor loses the `data-lha` attribute-hole address
  (the same as ../hackernews-blocks' views), and the router then never marks
  the "New" link `aria-current="page"` on `/new`: the browser check fails from
  the first load.
- **`SidebarNoteContent`** (the list's client slot). As a `$component` the
  jsdom suites pass, but under SSR + hydration the slot is re-rendered on the
  client instead of adopting the server's markup (as ../hackernews-blocks'
  `Toggle`): the anchor comes back with the client template's attribute order
  and without the server's styles, and it gets router link state
  (`data-active`, `aria-current`) the adopted anchor does not have.
- Keeping both plain also keeps every `<a>` out of `$component` views, so the
  dev runtime works: in ../hackernews-spa-blocks every `<a href>` a view
  creates throws `DIRECT_READ_IN_BLOCK` from @solidjs/router's link claims
  under the dev runtime (with the v2 `EditButton` this twin's jsdom suite
  halted the same way).

## Observations about the original

- In the production server (`pnpm build && pnpm start`), every mutation's
  single-flight response carries a rejected flight entry
  (`;0x…;!{"message":"Internal Server Error"}` after the redirect header),
  nothing is logged server-side, and the page shows "Error | Uncaught Client
  Exception" — for the original and the twin alike. The mutations therefore
  run only in the jsdom suites (client-only, in-process), where both apps
  save, create and delete identically. The `vite` dev server does not show
  the error.
