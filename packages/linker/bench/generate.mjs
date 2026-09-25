// Generate a synthetic strict Solid app of roughly `targetBytes` of source.
//
// Shape (per feature, ~11.5 KB with the default profile):
//   features/f<i>/Feature.tsx  component: a render block reading a store and
//                              signals, three extractable event blocks
//                              (submit with a preventDefault prelude, click,
//                              input) and one hot negative (stopPropagation
//                              after a read)
//   features/f<i>/logic.ts     cold-only handler logic (validation,
//                              summaries, transforms over lookup tables)
//   features/f<i>/view.ts      render-only helpers
//   shared/format.ts           used by rendering and by handler logic
// Features are split between the entry (home) and lazy routes of
// `routeSize` features each.
//
// Profiles: "default" (handler logic ≈ 52% of source) and "thin" (handler
// bodies only call render-side helpers: nothing substantial to move).
import fs from "node:fs";
import path from "node:path";

const PROFILES = {
  default: { logicUnits: 22, viewUnits: 10 },
  thin: { logicUnits: 0, viewUnits: 16 }
};

function unit(prefix, index, kind) {
  // ~260 bytes of plausible logic per unit.
  return `  if (key === "${prefix}${index}") {
    const parts = input.split(/[,;]/).map(part => part.trim()).filter(Boolean);
    const weight = parts.reduce((sum, part, at) => sum + part.length * (at + ${(index % 7) + 1}), ${index});
    return \`${kind}:${prefix}${index}:\${parts.length}:\${weight % ${97 + (index % 13)}}\`;
  }
`;
}

function logicModule(i, units) {
  const body = Array.from({ length: units }, (_, u) => unit(`v${i}_`, u, "validate")).join("");
  return `import { clampText, formatCount } from "../../shared/format";

export class InvalidName${i} extends Error {}

function classify${i}(key: string, input: string): string {
${body}  return \`plain:\${key}:\${input.length}\`;
}

export function validate${i}(name: string): string {
  const trimmed = clampText(name.trim(), 48);
  if (!trimmed) throw new InvalidName${i}("empty name in feature ${i}");
  return classify${i}("v${i}_" + (trimmed.length % ${Math.max(units, 1)}), trimmed).split(":")[0] === "plain" ? trimmed : trimmed;
}

export function summarize${i}(text: string): string {
  return \`added \${text} (\${classify${i}("v${i}_" + (text.length % ${Math.max(units, 1)}), text)})\`;
}

export function transform${i}(count: number): string {
  return \`\${formatCount(count)} after \${classify${i}("v${i}_" + (count % ${Math.max(units, 1)}), String(count * ${i + 3}))}\`;
}
`;
}

function viewModule(i, units) {
  const body = Array.from({ length: units }, (_, u) => unit(`l${i}_`, u, "label")).join("");
  return `function describe${i}(key: string, input: string): string {
${body}  return \`\${key}:\${input.length}\`;
}

export function label${i}(count: number): string {
  return \`Feature ${i}: \${describe${i}("l${i}_" + (count % ${Math.max(units, 1)}), String(count))}\`;
}
`;
}

function featureModule(i, profile) {
  const thin = profile.logicUnits === 0;
  const logicImport = thin
    ? `import { formatCount, clampText } from "../../shared/format";`
    : `import { formatCount } from "../../shared/format";
import { summarize${i}, transform${i}, validate${i} } from "./logic";`;
  const validate = thin ? `clampText(name.trim(), 48)` : `validate${i}(name)`;
  const summarize = thin ? `\`added \${checked}\`` : `summarize${i}(checked)`;
  const transform = thin ? `formatCount(count)` : `transform${i}(count)`;
  return `import { $, createSignal, createStore, write } from "solid-js";
${logicImport}
import { label${i} } from "./view";

interface Row${i} {
  id: number;
  name: string;
}

export function Feature${i}() {
  const [rows, setRows] = createStore<{ list: Row${i}[] }>({ list: [] });
  const [draft, setDraft] = createSignal("");
  const [status, setStatus] = createSignal("");
  const add = $(function* (e: SubmitEvent) {
    e.preventDefault();
    const name = yield* draft;
    const checked = ${validate};
    yield* write(setRows, state => {
      state.list.push({ id: state.list.length + 1, name: checked });
    });
    yield* write(setStatus, ${summarize});
  });
  const bump = $(function* () {
    const count = yield* rows.list.length;
    yield* write(setStatus, ${transform});
  });
  const edit = $(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* write(setDraft, e.currentTarget.value);
  });
  // Hot: propagation control after a read.
  const guard = $(function* (e: MouseEvent) {
    const value = yield* draft;
    if (value === "stop") e.stopPropagation();
  });
  return $(function* () {
    return (
      <section class="feature" id="f${i}">
        <h2>{label${i}(yield* rows.list.length)}</h2>
        <form class="add" onSubmit={add}>
          <input class="name" onInput={edit} />
        </form>
        <button class="bump" onClick={bump}>
          {formatCount(yield* rows.list.length)}
        </button>
        <p class="status" onClick={guard}>
          {yield* status}
        </p>
      </section>
    );
  });
}
`;
}

const SHARED = `export function formatCount(count: number): string {
  return count === 1 ? "1 item" : \`\${count} items\`;
}

export function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
`;

export function generateApp(
  dir,
  { targetBytes, profile = "default", routeSize = 10, homeFeatures = 5 } = {}
) {
  const settings = PROFILES[profile];
  fs.rmSync(dir, { recursive: true, force: true });
  const write = (file, text) => {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    return text.length;
  };
  write(
    "package.json",
    JSON.stringify({ name: path.basename(dir), private: true, type: "module" }, null, 2) + "\n"
  );
  write(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          lib: ["ESNext", "DOM"],
          jsx: "preserve",
          jsxImportSource: "@solidjs/web",
          paths: {
            "solid-js": ["../../../../solid/types/index.d.ts"],
            "@solidjs/signals": ["../../../../signals/dist/types/index.d.ts"],
            "@solidjs/web": ["../../../../web/types/index.d.ts"],
            "@solidjs/web/jsx-runtime": ["../../../../web/jsx/jsx.d.ts"],
            "@solidjs/web/jsx-dev-runtime": ["../../../../web/jsx/jsx.d.ts"]
          }
        },
        include: ["src"]
      },
      null,
      2
    ) + "\n"
  );
  let bytes = write("src/shared/format.ts", SHARED);
  const features = [];
  for (let i = 0; bytes < targetBytes; i++) {
    bytes += write(`src/features/f${i}/Feature.tsx`, featureModule(i, settings));
    if (settings.logicUnits)
      bytes += write(`src/features/f${i}/logic.ts`, logicModule(i, settings.logicUnits));
    bytes += write(`src/features/f${i}/view.ts`, viewModule(i, settings.viewUnits));
    features.push(i);
  }
  const home = features.slice(0, homeFeatures);
  const routed = features.slice(homeFeatures);
  const routes = [];
  for (let r = 0; r * routeSize < routed.length; r++) {
    const members = routed.slice(r * routeSize, (r + 1) * routeSize);
    routes.push(members);
    bytes += write(
      `src/routes/route${r}.tsx`,
      `${members.map(i => `import { Feature${i} } from "../features/f${i}/Feature";`).join("\n")}

export default function Route${r}() {
  return (
    <div class="route" id="route${r}">
${members.map(i => `      <Feature${i} />`).join("\n")}
    </div>
  );
}
`
    );
  }
  bytes += write(
    "src/App.tsx",
    `import { Loading, lazy } from "solid-js";
${home.map(i => `import { Feature${i} } from "./features/f${i}/Feature";`).join("\n")}

${routes.map((_, r) => `const Route${r} = lazy(() => import("./routes/route${r}"));`).join("\n")}

export function App() {
  return (
    <main>
${home.map(i => `      <Feature${i} />`).join("\n")}
      <Loading fallback={<p>loading</p>}>
${routes.map((_, r) => `        <Route${r} />`).join("\n")}
      </Loading>
    </main>
  );
}
`
  );
  bytes += write(
    "src/main.tsx",
    `import { render } from "@solidjs/web";
import { App } from "./App";

export { flush } from "solid-js";

render(() => <App />, document.getElementById("root")!);
`
  );
  return { dir, bytes, features: features.length, home: home.length, routes: routes.length };
}
