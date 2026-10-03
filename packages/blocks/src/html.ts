/*
 * `html` for blocks: Solid's tagged templates with typed holes.
 *
 *   html`<p class=${cls}>Hello ${function* () { return (yield* user).name }}</p>`
 *
 * Holes are typed exactly as in `h` (sources, bare `function*` holes, `$event` handlers,
 * child views, statics; no plain thunks) and the result carries their
 * pending / failures. Tag and attribute names inside the template string
 * are not checked by TypeScript (a template literal's text is not typed);
 * use `h` when that matters.
 */
import solidHtml from "@solidjs/html";
import { toHole, type Hole, type HtmlValue, type HViewOf } from "./holes.js";

export interface BlocksHtml<Registry extends Record<string, (props: any) => any> = {}> {
  <const V extends readonly HtmlValue[]>(
    strings: TemplateStringsArray,
    ...values: V
  ): HViewOf<V[number]>;
  /** A template tag with components added to its registry (`<${"Name"} />` by name). */
  define<R extends Record<string, (props: any) => any>>(components: R): BlocksHtml<Registry & R>;
  readonly components: Registry;
}

function wrap(core: any): any {
  const tag: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    core(strings, ...values.map(toHole));
  tag.define = (components: Record<string, unknown>) => wrap(core.define(components));
  tag.components = core.components;
  return tag;
}

export const html: BlocksHtml = wrap(solidHtml);

export type { Hole, HViewOf };
