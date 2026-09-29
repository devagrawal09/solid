// The frames client switches (packages/web/frames/src/features.ts) proven
// from compiled SERVER output (capabilities.js, proveFramesFeatures), and the
// linker's substitute module. Server output comes from the real compiler
// (`generate: "ssr"`), as the plugin sees it in the server build.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { transform } = require("..");
const {
  proveFramesFeatures,
  framesFeaturesModuleSource,
  FRAMES_SWITCHES
} = require("../capabilities.js");

const ssr = (code, filename = "mod.tsx") =>
  transform(code, { filename, generate: "ssr", hydratable: true }).code;

const on = features => FRAMES_SWITCHES.filter(f => features[f].on);

test("a server-only page with no server components switches every frames feature off", () => {
  const features = proveFramesFeatures({
    modules: [{ rel: "page.tsx", code: ssr(`export const Page = () => <main><h1>Hi</h1></main>;`) }]
  });
  expect(on(features)).toEqual([]);
});

test("a propless server component keeps the slot switches off; one with props turns them on", () => {
  const propless = ssr(`"use server";
export async function Feed() { const items = await load(); return () => <ul>{items.map(i => <li>{i}</li>)}</ul>; }`);
  expect(on(proveFramesFeatures({ modules: [{ rel: "feed.tsx", code: propless }] }))).toEqual([]);
  const withProps = ssr(`"use server";
export async function Story(id: string) {
  const story = await load(id);
  return (props: { toggle: (p: any) => any }) => <article>{story.title}{props.toggle({})}</article>;
}`);
  const features = proveFramesFeatures({ modules: [{ rel: "story.tsx", code: withProps }] });
  expect(on(features)).toEqual(["SLOT_DATA", "LIVE_PROPS", "FULL_CODEC", "HYDRATION_CLAIMS"]);
  expect(features.SLOT_DATA.because[0]).toMatch(/^story\.tsx:\d+: server component takes props/);
  expect(features.FULL_CODEC.because).toEqual(["SLOT_DATA (data records)"]);
});

test("Loading, asyncArg, stores, CSS and the flight transform each turn their switch on", () => {
  const cases = [
    [
      `import { Loading } from "solid-js"; export const P = () => <Loading fallback="…"><p/></Loading>;`,
      ["FRAGMENTS"]
    ],
    [
      `import { asyncArg } from "@solidjs/web/frames"; export const x = asyncArg(p);`,
      ["ASYNC_ARGS", "FULL_CODEC"]
    ],
    [
      `"use server"; import { createStore } from "solid-js"; export async function F() { const [s] = createStore({ n: 1 }); return () => <p>{s.n}</p>; }`,
      ["CONTAINERS", "FULL_CODEC"]
    ],
    [
      `"use server"; import "./feed.css"; export async function F() { return () => <p>x</p>; }`,
      ["ASSETS"]
    ],
    [
      `import { frameTransformFlightResult } from "@solidjs/web/frames/server"; export const o = { transformFlightResult: frameTransformFlightResult };`,
      ["SINGLE_FLIGHT"]
    ]
  ];
  for (const [source, expected] of cases)
    expect(on(proveFramesFeatures({ modules: [{ rel: "m.tsx", code: ssr(source) }] }))).toEqual(
      expected
    );
});

test("an unknown module or graph keeps every switch on", () => {
  expect(on(proveFramesFeatures({ modules: [{ rel: "x.tsx", code: null }] }))).toEqual(
    FRAMES_SWITCHES
  );
  expect(on(proveFramesFeatures({ modules: [], complete: false }))).toEqual(FRAMES_SWITCHES);
});

test("the substitute module folds the proven switches and keeps the guard", async () => {
  const features = proveFramesFeatures({ modules: [] });
  features.FRAGMENTS.on = true;
  const source = framesFeaturesModuleSource(features);
  expect(source).toContain("export const FRAGMENTS = true;");
  expect(source).toContain("export const CONTAINERS = false;");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-features-"));
  const file = path.join(dir, "features.mjs");
  fs.writeFileSync(file, source);
  const mod = await import(file);
  expect(mod.SLOT_DATA).toBe(false);
  expect(() => mod.featureExcluded("SLOT_DATA")).toThrow(/\[FEATURE_EXCLUDED\].*SLOT_DATA/);
  expect(mod.markFeature("SLOT_DATA")).toBeUndefined();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the plugin: the server build writes the proof, the client build substitutes the module", async () => {
  const { solidCapabilities } = require("../capabilities.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frames-proof-app-"));
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    const logs = [];
    const logger = { info: m => logs.push(m), warn: () => {} };
    // Server build: records the application modules' compiled output.
    const server = solidCapabilities();
    server.configResolved({ root, command: "build", build: { ssr: true }, logger });
    await server.buildStart.call({ resolve: async () => null }, { input: [] });
    const page = path.join(root, "src/page.tsx");
    const authored = `"use server"; export async function Feed() { return () => <ul><li>a</li></ul>; }`;
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, authored);
    server.transform.handler.call({}, ssr(authored), page);
    server.generateBundle();
    const proof = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules/.cache/solid/frames-features.json"), "utf8")
    );
    expect(proof.modules).toEqual(["src/page.tsx"]);
    expect(FRAMES_SWITCHES.every(f => !proof.features[f].on)).toBe(true);
    // Client build: the frames client's features module resolves to the
    // substitute with every proven switch off.
    const client = solidCapabilities();
    client.configResolved({ root, command: "build", build: {}, logger });
    await client.buildStart.call({ resolve: async () => null }, { input: [] });
    const dist = path.resolve(__dirname, "../../web/frames/dist/client.features.js");
    const id = await client.resolveId.call(
      { resolve: async () => ({ id: dist }) },
      "./client.features.js",
      path.join(path.dirname(dist), "client.js"),
      {}
    );
    expect(id).toBe("\0solid-frames-features");
    const source = client.load(id);
    for (const f of FRAMES_SWITCHES) expect(source).toContain(`export const ${f} = false;`);
    expect(logs.some(m => /frames client: switched off FRAGMENTS/.test(m))).toBe(true);
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
