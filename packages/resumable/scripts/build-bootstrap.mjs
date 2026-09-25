// Builds dist/bootstrap.iife.js (the classic script the server inlines) and
// prints its size.
import { buildBootstrap } from "../src/build.js";
import { gzipSync, brotliCompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(dir, "..", "dist", "bootstrap.iife.js");
const code = await buildBootstrap({ outFile });
const raw = Buffer.byteLength(code);
console.log(
  `bootstrap.iife.js: ${raw} B raw, ${gzipSync(code).length} B gzip, ${brotliCompressSync(code).length} B brotli`
);
