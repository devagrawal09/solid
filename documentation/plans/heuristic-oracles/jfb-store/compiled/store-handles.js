import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { readShallow as _$readShallow } from "@solidjs/web";
import { className as _$className } from "@solidjs/web";
import { effect as _$effect } from "@solidjs/web";
import { addEvent as _$addEvent } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(
  `<div class="col-sm-6 smallpad"><button class="btn btn-primary btn-block"type=button>`
);
var _tmpl$2 = /* @__PURE__ */ _$template(
  `<div class=container><div class=jumbotron><div class=row><div class=col-md-6><h1>Solid Store</div><div class=col-md-6><div class=row><!><!><!><!><!><!></div></div></div></div><table class="table table-hover table-striped test-data"><tbody></table><span class="preloadicon glyphicon glyphicon-remove"aria-hidden=true>`
);
var _tmpl$3 = /* @__PURE__ */ _$template(
  `<tr><td class=col-md-1></td><td class=col-md-4><a> </a></td><td class=col-md-1><a><span class="glyphicon glyphicon-remove"aria-hidden=true></a></td><td class=col-md-6>`
);
// store-strict: store-main.jsx authored in the strict generator style, so the
// compiler lowers the store reads to path readers: `$(function* () {...})`
// blocks (the rows memo and each row), and `yield*` on every reactive read.
// Markup, ops and setters are identical to store-main.jsx.
// Based on: Solid 2 port of frameworks/keyed/solid-store/src/main.jsx (JFB f2df01a8).
// Differences are only the Solid 2 API renames:
//   createSelector(() => state.selected) -> createProjection (04-stores.md migration)
//   setState(path..., value)             -> setState(storePath(path..., value)), the
//                                           documented 1.x path-setter compat helper
//   solid-js/web, solid-js/store         -> @solidjs/web, solid-js
import {
  $,
  createMemo,
  createStore,
  createProjection,
  storePath,
  For,
  perform as _$perform,
  readPath1 as _$readPath1,
  createStoreHandle as _$createStoreHandle,
  readHandle1 as _$readHandle1,
  storeProxy as _$storeProxy
} from "solid-js";
import { render } from "@solidjs/web";
const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy"
];
const colors = [
  "red",
  "yellow",
  "blue",
  "green",
  "pink",
  "brown",
  "purple",
  "brown",
  "white",
  "black",
  "orange"
];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard"
];
const random = max => Math.round(Math.random() * 1e3) % max;
let nextId = 1;
const buildData = count => {
  let data = new Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = {
      id: nextId++,
      label: `${adjectives[random(adjectives.length)]} ${colors[random(colors.length)]} ${nouns[random(nouns.length)]}`
    };
  }
  return data;
};
const Button = ([id, text, fn]) =>
  (() => {
    var _el$ = _tmpl$();
    var _el$2 = _el$.firstChild;
    _$addEvent(_el$2, "click", fn, true);
    _el$2.id = id;
    _$insert(_el$2, text);
    return _el$;
  })();
render(() => {
  const [state, setState] = _$createStoreHandle({
    data: [],
    selected: null
  });
  const run = () => setState(storePath({ data: buildData(1e3) }));
  const runLots = () => setState(storePath({ data: buildData(1e4) }));
  const add = () => setState(storePath("data", d => [...d, ...buildData(1e3)]));
  const update = () => setState(storePath("data", { by: 10 }, "label", l => l + " !!!"));
  const swapRows = () =>
    setState(
      storePath("data", d =>
        d.length > 998
          ? {
              1: d[998],
              998: d[1]
            }
          : d
      )
    );
  const clear = () => setState(storePath({ data: [] }));
  let prev = null;
  const isSelected = createProjection(s => {
    const id = _$storeProxy(state).selected;
    if (prev != null) delete s[prev];
    if (id != null) s[id] = true;
    prev = id;
  }, {});
  // The rows array, read as a lowered path in a block hosted by a memo. (Putting
  // the whole app in a `$` block fails in production builds: see README,
  // "Strict-mode finding".)
  const rows = createMemo(
    $(function () {
      return _$readHandle1(state, "data");
    })
  );
  var _el$3 = _tmpl$2();
  var _el$4 = _el$3.firstChild;
  var _el$5 = _el$4.firstChild;
  var _el$6 = _el$5.firstChild;
  var _el$7 = _el$6.nextSibling;
  var _el$8 = _el$7.firstChild;
  var _el$9 = _el$8.firstChild;
  var _el$10 = _el$9.nextSibling;
  var _el$11 = _el$10.nextSibling;
  var _el$12 = _el$11.nextSibling;
  var _el$13 = _el$12.nextSibling;
  var _el$14 = _el$13.nextSibling;
  var _el$15 = _el$4.nextSibling;
  var _el$16 = _el$15.firstChild;
  _$insert(_el$8, _$createComponent(Button, ["run", "Create 1,000 rows", run]), _el$9);
  _$insert(_el$8, _$createComponent(Button, ["runlots", "Create 10,000 rows", runLots]), _el$10);
  _$insert(_el$8, _$createComponent(Button, ["add", "Append 1,000 rows", add]), _el$11);
  _$insert(_el$8, _$createComponent(Button, ["update", "Update every 10th row", update]), _el$12);
  _$insert(_el$8, _$createComponent(Button, ["clear", "Clear", clear]), _el$13);
  _$insert(_el$8, _$createComponent(Button, ["swaprows", "Swap Rows", swapRows]), _el$14);
  _$insert(
    _el$16,
    _$createComponent(For, {
      get each() {
        return rows();
      },
      children: row => {
        return $(function () {
          const rowId = _$readPath1(row, "id");
          var _el$17 = _tmpl$3();
          var _el$18 = _el$17.firstChild;
          var _el$19 = _el$18.nextSibling;
          var _el$20 = _el$19.firstChild;
          var _el$21 = _el$20.firstChild;
          var _el$22 = _el$19.nextSibling;
          var _el$23 = _el$22.firstChild;
          _el$18.textContent = rowId;
          _el$20.$$click = () => setState(storePath("selected", rowId));
          _el$23.$$click = () =>
            setState(
              storePath("data", d =>
                d.toSpliced(
                  d.findIndex(d => d.id === rowId),
                  1
                )
              )
            );
          _$effect(
            () => {
              return {
                e: _$readShallow(_$readPath1(isSelected, rowId) ? "danger" : ""),
                t: _$readPath1(row, "label")
              };
            },
            ({ e, t }, _p$) => {
              _$className(_el$17, e, _p$?.e);
              (!_p$ || t !== _p$.t) && (_el$21.data = t);
            }
          );
          return _el$17;
        });
      }
    })
  );
  return _el$3;
}, document.getElementById("main"));
_$delegateEvents(["click"]);
