---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
---

Generator blocks v2 compiler lowering: `$component` / `$memo` / `$effect` / `$event` and generator `createMemo` / `createEffect` bodies compile to call form (`yield*` inside JSX supported), effects are split into a compute half holding every read and an effect half receiving the values, component and boundary call forms get lazy props, and host rules are compile errors. The runtime constructors accept prebuilt blocks; `effectBlock` creates split effects.
