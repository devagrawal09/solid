import type { Item } from "./types";
import "./polyfill";
import def, * as ns from "./ns";
import { lazy } from "solid-js";

export { a, b as bee } from "./ab";
export * from "./star";
export * as all from "./all";
export type { Item };

const Page = lazy(() => import("./Page"));
const later = () => import(`./later`);

export const registry = new Map<string, Item>();
registry.set("x", { id: 1 } as Item);

export default function run() {
  return [def, ns.value, Page, later];
}
