import replace from "@rollup/plugin-replace";
import typescript from "@rollup/plugin-typescript";
import prettier from "rollup-plugin-prettier";

// Three tiers, two flags (see src/globals.d.ts):
//   dev      __DEV__ true   __OBSERVE__ true   — checks + wiring
//   observe  __DEV__ false  __OBSERVE__ true   — wiring only (prod-legal)
//   prod     __DEV__ false  __OBSERVE__ false  — neither; byte-identical to
//                                                 the pre-observe prod build
// `__DEV__` implies `__OBSERVE__`; dev.ts asserts it at module init.
//
// ESM only. Node >= 22.12 (the `engines` floor) `require()`s ESM natively, so
// a CJS host gets these same artifacts through the same export conditions —
// there is no second module graph to keep in step with the first.
//
// The prod and observe builds are per-module trees (`preserveModules`); they
// are consumed by bundlers, which can drop whole feature modules — including
// their top-level GlobalQueue hook installs, which statement-level shaking of
// a flat file can never remove (#2883) — and scope-hoist the rest back into
// one module. Dev stays a flat file: dev bundle size doesn't matter, and
// vitest's per-module SSR transform makes a chunked tree ~2x slower in the
// flush hot path, poisoning CI benches.
//
// `_`-prefixed property mangling for prod and observe outputs runs as a
// single sequential post-pass (scripts/mangle-props.mjs) with one shared
// nameCache per output; per-chunk terser would mangle the same property to
// different names in different modules and break every cross-module member
// access. `_name` is reserved (the cross-package label field).
//
// Two entries per build: `index` (the core) and `attribution` (the engine
// behind `@solidjs/signals/attribution`). The engine reads the core's live
// state, so both MUST share one module instance per tier — never two flat
// bundles that each carry their own copy of core. The trees get that for
// free (preserveModules); the flat dev build is code-split instead: the two
// entries plus one shared chunk (`dev-shared.js`). Prod's engine entry is
// `attribution.prod.ts`, an inert twin with the same surface — a prod build
// has no hook sites to feed one.

const flags = (dev, observe, asyncCapability = true) =>
  replace({
    __DEV__: String(dev),
    __OBSERVE__: String(observe),
    __TEST__: "false",
    __ASYNC__: String(asyncCapability),
    preventAssignment: true
  });

const ts = outDir =>
  typescript({
    declaration: false,
    outDir,
    module: "esnext",
    target: "esnext",
    moduleResolution: "bundler",
    verbatimModuleSyntax: true
  });

const pretty = prettier({ parser: "typescript" });

// NO prettier on the per-module trees: rollup-plugin-prettier strips
// /*@__PURE__*/ annotations, silently disabling consumer-side DCE of
// annotated initializers. The mangle-props post-pass beautifies that output
// anyway (and must run terser with preserve_annotations).
const engine = observe => (observe ? "src/attribution.ts" : "src/attribution.prod.ts");

const tree = (dir, dev, observe) => ({
  input: { index: "src/index.ts", attribution: engine(observe) },
  output: { dir, format: "esm", preserveModules: true, preserveModulesRoot: "src" },
  plugins: [flags(dev, observe), ts(dir)]
});

// `name` is the stem: dist/<name>.js (core), dist/<name>.attribution.js
// (engine), dist/<name>-shared.js (the one chunk both import).
const flat = (name, dev, observe) => ({
  input: { [name]: "src/index.ts", [`${name}.attribution`]: engine(observe) },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: `${name}-shared.js`
  },
  plugins: [flags(dev, observe), ts("dist"), pretty]
});

// The async-free runtime (Track A stage 2; `@solidjs/signals/sync`, selected
// by the capability linker for graphs proven async-free — see
// src/index.sync.ts). `__ASYNC__` false folds the async machinery out of
// the sources; try deoptimization is off so that folding reaches the dead
// async branches inside recompute's try blocks (#2883), and the published
// modules are already pruned when an app bundler consumes them. One prod
// tree, plus a flat dev file whose checks verify the linker's proof at
// runtime ([ASYNC_IN_SYNC_GRAPH], [ASYNC_CAPABILITY_EXCLUDED]).
const syncTree = dir => ({
  input: { "index.sync": "src/index.sync.ts" },
  output: { dir, format: "esm", preserveModules: true, preserveModulesRoot: "src" },
  treeshake: { tryCatchDeoptimization: false },
  plugins: [flags(false, false, false), ts(dir)]
});
const syncDev = {
  input: { "sync.dev": "src/index.sync.ts" },
  output: { dir: "dist", format: "esm", entryFileNames: "[name].js" },
  treeshake: { tryCatchDeoptimization: false },
  plugins: [flags(true, true, false), ts("dist"), pretty]
};

export default [
  flat("dev", true, true),
  tree("dist/prod", false, false),
  // Observe tier: the ~40 wiring sites survive (attribution hooks, `_name`,
  // edge counters, the diagnostics channel), every check folds out. Selected
  // by the `observe` export condition. Gets its own size-limit scenario; the
  // prod tree's caps must not move because of it.
  tree("dist/observe", false, true),
  syncTree("dist/sync"),
  syncDev
];
