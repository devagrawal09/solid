#!/usr/bin/env node
// After jsx-sync: the brands that libraries attach to @solidjs/web's JSX
// namespace must be web's own, not a copy. `SerializableAttributeValue` is
// branded with a unique symbol, so the generated namespace's copy made every
// web-typed serializable value (the router's `action()` in <form action>, its
// typed paths in <a href>) unassignable in block JSX. It is re-declared here
// as an alias of web's.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../jsx/jsx.d.ts");
const source = fs.readFileSync(file, "utf8");
const copy =
  /  const SERIALIZABLE: unique symbol;\n  interface SerializableAttributeValue \{\n    toString\(\): string;\n    \[SERIALIZABLE\]: never;\n  \}\n/;
if (!copy.test(source)) throw new Error("jsx-web-shared: SerializableAttributeValue declaration not found");
fs.writeFileSync(
  file,
  source.replace(
    copy,
    '  /** @solidjs/web\'s own (libraries brand values with it). */\n  type SerializableAttributeValue = import("@solidjs/web").JSX.SerializableAttributeValue;\n'
  )
);
