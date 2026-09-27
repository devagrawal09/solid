---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/h": patch
---

Generator blocks v2 run the same source without the Solid compiler: component, `Loading` and `Errored` calls made inside a running block are deferred to where they render (created once, under the owner above the resolving computation, so a view reading a settled async memo does not re-create its component). `@solidjs/h`'s JSX runtime now passes element children through its per-child path, so a function child (an accessor, a component's view) inside a children array stays reactive.
