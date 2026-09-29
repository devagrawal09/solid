---
"@solidjs/compiler": minor
---

Compiled islands derive server components (frames) from the inert proof. `"use server"` goes on data functions only, never on markup. A memo whose value is one server call, with readers that are inert, becomes a frame: the server renders its region, and one server function per frame is generated and registered like a `"use server"` reference (a declared GET). The client refetches the region when the call's arguments change (a route's params and search, or island state) and morphs it with a lazily loaded applier (`@solidjs/compiler/frames-client`). Keyed islands inside the region (`$key`, or the row's item id) keep their state across a refetch. A `refresh` after a mutation in island code is one single-flight request (`@solidjs/compiler/frames-server`).

The guards:

- a `@taint`ed server function whose value reaches client-visible markup is a build error;
- client-environment reads are client-live;
- serialization is pruned to the prop paths client code reads, and static text is no longer serialized;
- a `@frame prefer: "client"` pragma keeps a call as client code;
- no frame is cut inside client control flow or read by a live island.

The islands manifest lists `frames` (id, region, arguments, server functions, keyed islands, and the public/guard status) and `frameCandidates`. The Vite plugin compiles `createRouter` / `defineRoute` route tables to server matching and client navigation into the outlet, and writes `.vite/solid-frames.json`.

The capability linker (`@solidjs/compiler/capabilities`) proves `@solidjs/web/frames`' client switches from the server build's compiled output (`proveFramesFeatures`) and substitutes them in the client build.
