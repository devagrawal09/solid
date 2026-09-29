---
"@solidjs/compiler": patch
---

Compiled islands: a component that belongs to two islands (two independent cells, one shared with more components than the other) no longer gets every member component's cells, handlers and holes in each island's chunk. The client emitter now keeps, per island, only the sites the partitioner assigned to it and the setup items those need; a cell of another island is never created locally (a second copy went out of phase once the islands activated at different times, and the page showed the inverse of the state). A site that would need another island's cell inside content this island creates (a fresh region row, a client-built fallback), or island sites inside another island's `<Show>` / `<For>`, is refused with a reason (the union-find should have merged those).
