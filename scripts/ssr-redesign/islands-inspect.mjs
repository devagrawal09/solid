#!/usr/bin/env node
// Print the minified client bundle of a compiled-islands variant (entry and
// lazy chunks) with gzip sizes: `node scripts/ssr-redesign/islands-inspect.mjs hn C-lazy`.
import { join } from "node:path";
import { bundleClient, gz, HERE, islandsCompiler } from "./lib.mjs";
import { APPS } from "./apps.mjs";

const [appName = "hn", vname = "C-lazy"] = process.argv.slice(2);
const v = APPS[appName].variants[vname];
const compiler = islandsCompiler({ minTier: v.islands.minTier, tier1Core: v.islands.tier1Core });
const root = join(HERE, v.islands.root);
const collected = compiler.collect(root);
console.log(JSON.stringify(collected.islands.map(({ id, root, tier, activation, events, windowEvents, why }) => ({ id, root, tier, activation, events, windowEvents, why })), null, 1));
const out = await bundleClient(join(HERE, v.client), {
  splitting: !!v.splitting,
  aliases: v.aliases,
  islands: { compiler, root, mode: v.islands.mode, prefetch: v.islands.prefetch, files: new Set(collected.files) }
});
for (const [name, code] of Object.entries(out.files)) console.log(`\n--- ${name} (${code.length} B, ${gz(code)} B gz)\n${code}`);
