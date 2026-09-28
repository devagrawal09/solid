---
"@solidjs/web": patch
---

Fix document-root hydration starting before the shell is parsed. An `async` client entry (the vite plugin's generated entry) runs as soon as it loads, which on a large page or a slow CPU is mid-parse: `hydrate(…, document)` then claimed elements whose children were not parsed yet, the compiled walk threw on a null `firstChild`/`nextSibling`, and everything after the failure point stayed dead (hackernews-spa: 6 of 7 loads at 4× CPU). `hydrate()` on a document that is still loading now waits for DOMContentLoaded, or, when the stream still has pending fragments, for a shell-parsed marker that `renderToStream` writes right after the shell (`_$HY.sh`), so a streamed shell still hydrates before its slow boundaries resolve. Events in between are captured and replayed as before.
