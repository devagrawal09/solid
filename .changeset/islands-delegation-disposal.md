---
"@solidjs/compiler": minor
---

Compiled islands (experimental):

- **Delegated handlers.** Island handlers of Solid's delegated events are bound as `node.$$click = h`, with one listener per event type on the document that walks from the target up as Solid's `eventHandler` does (`$$clickData`, `handleEvent`, disabled nodes skipped), stops at `stopPropagation` and resumes above a Solid root that already walked the event. A real click reaching nested islands now runs all their handlers in one listener, so the page flushes once (before, a trusted click flushed after each island's listener and an effect in the inner island read the outer island's stale DOM). Other events keep a listener on their element, as in Solid.
- **Swapped-out islands are disposed.** The islands entry keeps each activation's root disposer on its anchor (`anchor.$d[id]`, eager, re-seeded and lazy activations), and the frames applier (`@solidjs/compiler/frames-client`, new `dispose` export) disposes every island on an anchor a morph or a navigation removes, after reading the keyed state; a streamed boundary swap disposes the islands of the fallback it replaces. A replaced island's cleanups, effects, timers and window listeners no longer outlive it.
- **View reads bound to a local.** `const x = yield* e;` before a view's `return` (`e` an identifier or a static member chain) is read at each use, so the local may be live and a frame's readers may name its data once.
