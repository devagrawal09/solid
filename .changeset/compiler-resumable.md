---
"@solidjs/compiler": patch
---

Add the experimental `compileResumable(code, { filename, islands })`: compiles an island module into a resumable server module (the source plus `data-q` instance markers and a `__qState()` export serializing only the live closure — the cells an exported handler writes, and each live binding's captured values) and a client with no component code (cells rebuilt from the serialized values, the handlers verbatim, one expression per live binding with component-local memos inlined, and a waker that binds a cell's subscribers before its first write). Anything it cannot prove — live values passed to components, mixed-child text bindings, JSX event handlers, handlers reading server-only data, escaping setters — is reported in `reasons` and the islands should hydrate instead.
