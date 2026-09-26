// Q1 in the DOM: the round-2 <For> + Row suite (../../dom/list/baseline.jsx,
// imported read-only) with selection modelled as a projection.
//
//   baseline    per-row `isSel` memo passed to Row as a prop (round 2)
//   C2-fuse     round 2's C1-inline + fuse of that shared-source memo (oracle)
//   proj        one createProjection keyed by id; Row reads isSelected[row.id]
//   proj+C1     proj with Row inlined (the fair twin of C2-fuse)
//   control     baseline on the oracle runtime
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../common.mjs";
import { LIST_VARIANTS } from "../../dom/list/variants.mjs";

const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, name) => transform(src, { filename: `${name}.jsx`, generate: "dom" }).code;
function edit(code, from, to, what) {
  if (!code.includes(from)) throw new Error(`${what}: pattern not found`);
  return code.replace(from, to);
}

const base = readFileSync(join(ROOT, "scripts/heuristics/dom/list/baseline.jsx"), "utf8");
const RENDER_FROM = `      dispose = render(
        () => (
          <For each={rows()}>
            {row => {
              const isSel = createMemo(() => selected() === row.id);
              return <Row row={row} selected={isSel()} />;
            }}
          </For>
        ),
        tbody
      );`;
const projRender = rowJsx => `      dispose = render(() => {
        let prev;
        const isSelected = createProjection(draft => {
          const s = selected();
          if (prev !== undefined && prev !== s) delete draft[prev];
          if (s >= 0) draft[s] = true;
          prev = s;
        }, {});
        return <For each={rows()}>{row => ${rowJsx}}</For>;
      }, tbody);`;
let projSrc = edit(base, RENDER_FROM, projRender(`<Row row={row} selected={isSelected[row.id]} />`), "proj render");
projSrc = edit(projSrc, "import { createMemo,", "import { createProjection, createMemo,", "proj import");
let projInlineSrc = edit(
  base,
  RENDER_FROM,
  projRender(`(
          <tr class={isSelected[row.id] ? "danger" : ""}>
            <td class="col-md-1">{row.id}</td>
            <td class="col-md-4">{row.label()}</td>
          </tr>
        )`),
  "proj+C1 render"
);
projInlineSrc = edit(projInlineSrc, "import { createMemo,", "import { createProjection, createMemo,", "proj+C1 import");

export const SEL_VARIANTS = {
  baseline: LIST_VARIANTS.baseline,
  "C2-fuse": LIST_VARIANTS["C2-fuse"],
  proj: { runtime: "prod", source: compile(projSrc, "proj") },
  "proj+C1": { runtime: "prod", source: compile(projInlineSrc, "proj-inline") },
  control: LIST_VARIANTS.control
};
export const SEL_FIRED = {
  baseline: ["createMemo(() => selected() === row.id)"],
  "C2-fuse": ["equals: (a, b) => a === b"],
  proj: ["createProjection(", "isSelected[row.id]"],
  "proj+C1": ["createProjection(", "isSelected[row.id] ?"],
  control: []
};
