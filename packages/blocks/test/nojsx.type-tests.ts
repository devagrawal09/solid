/**
 * The strict rules, no-JSX flavor (`h`, `html`) — checked by `tsc`, never
 * executed.
 */
import {
  $,
  $component,
  $memo,
  $signal,
  attempt,
  For,
  Loading,
  render,
  type HView
} from "@solidjs/blocks";
import { h } from "@solidjs/blocks/h";
import { html } from "@solidjs/blocks/html";

declare const root: HTMLElement;
declare function fetchUser(): Promise<{ name: string }>;

export const Settled = $component(function* () {
  const [n] = yield* $signal(1);
  const doubled = $(function* () {
    return (yield* n) * 2;
  });
  return function* () {
    return h(
      "p",
      { class: doubled, title: "static", onClick: () => {} },
      "count ",
      n,
      " ",
      function* () {
        return (yield* n) + 1;
      }
    );
  };
});
const settledOut: HView<false, never> = h("p", "x");
void settledOut;

// tag and attribute names are typed (h)
// @ts-expect-error not an element
export const badTag = h("dvi");
// @ts-expect-error not an attribute of <a>
export const badAttr = h("a", { hreff: "/" });
// @ts-expect-error href is a string
export const badValue = h("a", { href: 5 });

// no hidden reads in holes: plain thunks are not holes
// @ts-expect-error a plain thunk child
export const thunkChild = h("p", () => 1);
// @ts-expect-error a plain thunk attribute
export const thunkAttr = h("p", { title: () => "x" });
// @ts-expect-error a plain thunk hole in html
export const thunkHtml = html`<p>${() => 1}</p>`;

// a no-JSX view reads only in holes
// @ts-expect-error [HVIEW_READ]
export const ReadsInView = $component(function* () {
  const [n] = yield* $signal(1);
  return function* () {
    const v = yield* n;
    return h("p", String(v));
  };
});

// pending holes make the output (and so the view) pending
export const Pending = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser());
  });
  return function* () {
    return h("p", function* () {
      return (yield* user).name;
    });
  };
});
export const PendingHtml = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser());
  });
  const name = $(function* () {
    return (yield* user).name;
  });
  return function* () {
    return html`<p>${name}</p>`;
  };
});
const pendingOut: HView<true, never> = h("p", Pending());
void pendingOut;
// @ts-expect-error the root would suspend
render(() => Pending(), root);
// @ts-expect-error the root would suspend
render(() => PendingHtml(), root);
render(() => Loading({ children: Pending() }), root);
export const handled = h("div", Loading({ fallback: "…", children: Pending() }));
const handledOut: HView<false, never> = handled;
void handledOut;
// a fragment, h([a, b]), carries its holes' pending
const fragmentOut: HView<true, never> = h([h("i", "x"), h(Pending, {})]);
void fragmentOut;
// @ts-expect-error a pending fragment is not settled
const fragmentSettled: HView<false, never> = h([h("i", "x"), h(Pending, {})]);
void fragmentSettled;

// row blocks in h
export const Rows = $component(function* () {
  const [items] = yield* $signal(["a"]);
  return function* () {
    return h(
      "ul",
      For({
        each: items,
        children: function* (item) {
          const [open] = yield* $signal(false);
          return function* () {
            return h("li", item, open);
          };
        }
      })
    );
  };
});
