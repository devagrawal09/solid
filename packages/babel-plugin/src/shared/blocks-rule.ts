/**
 * The one block rule of the JSX transform (generator blocks as a library,
 * `documentation/plans/blocks-library.md`), the Babel twin of
 * `packages/compiler/src/blocks_rule.rs`.
 *
 * Inside a JSX expression or attribute value, `yield* e` becomes
 * `perform(e)` (imported from `blocksModule`, default `@solidjs/blocks`),
 * so the expression is a call, the transform treats it as dynamic, and the
 * view generator runs once. Nothing else is lowered. The refused positions
 * are exactly `REFUSALS`; `packages/compiler/tests/blocks-rule-fixtures.json`
 * pins the list for both compilers and the ESLint rule.
 */
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { registerImportMethod } from "./utils";

export const REFUSALS = {
  BLOCKS_YIELD_IN_EVENT:
    "a `yield*` in an event handler prop would read once, at render: read inside the `$event` instead",
  BLOCKS_YIELD_IN_REF: "a `yield*` in a `ref` has no hole to read in: a ref is set once",
  BLOCKS_YIELD_IN_SPREAD:
    "a `yield*` in a spread cannot become a hole: spread an object of values, or pass each prop",
  BLOCKS_YIELD_IN_SPREAD_CHILD: "a `yield*` in a spread child cannot become a hole",
  BLOCKS_PLAIN_YIELD_IN_JSX: "a plain `yield` inside JSX is not a read: use `yield*`"
} as const;
export type RefusalCode = keyof typeof REFUSALS;

type Hole = "none" | "allowed" | RefusalCode;

function attributeHole(name: t.JSXAttribute["name"]): Hole {
  if (t.isJSXNamespacedName(name)) {
    const ns = name.namespace.name;
    return ns === "on" || ns === "oncapture" ? "BLOCKS_YIELD_IN_EVENT" : "allowed";
  }
  const n = name.name;
  if (n === "ref") return "BLOCKS_YIELD_IN_REF";
  if (n.length > 2 && n.startsWith("on") && n[2] >= "A" && n[2] <= "Z")
    return "BLOCKS_YIELD_IN_EVENT";
  return "allowed";
}

/** Where a `yield` sits: which hole of the nearest JSX, if any, before a function boundary. */
function holeOf(path: NodePath): Hole {
  let child: NodePath = path;
  let parent = path.parentPath;
  while (parent) {
    const node = parent.node;
    if (t.isFunction(node) || t.isClass(node)) return "none";
    if (t.isJSXSpreadAttribute(node)) return "BLOCKS_YIELD_IN_SPREAD";
    if (t.isJSXSpreadChild(node)) return "BLOCKS_YIELD_IN_SPREAD_CHILD";
    if (t.isJSXExpressionContainer(node)) {
      const owner = parent.parentPath?.node;
      return owner && t.isJSXAttribute(owner) ? attributeHole(owner.name) : "allowed";
    }
    child = parent;
    parent = parent.parentPath;
  }
  void child;
  return "none";
}

export function applyBlocksRule(program: NodePath<t.Program>, blocksModule: string): void {
  program.traverse({
    YieldExpression(path) {
      const hole = holeOf(path);
      if (hole === "none") return;
      const code: RefusalCode | undefined = !path.node.delegate
        ? "BLOCKS_PLAIN_YIELD_IN_JSX"
        : hole === "allowed"
          ? undefined
          : hole;
      if (code) throw path.buildCodeFrameError(`[${code}] ${REFUSALS[code]}`);
      const argument = path.node.argument!;
      const perform = registerImportMethod(path, "perform", blocksModule);
      path.replaceWith(t.callExpression(perform, [argument]));
    }
  });
}
