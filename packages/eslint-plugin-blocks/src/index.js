/**
 * @solidjs/eslint-plugin-blocks — the strict rules of @solidjs/blocks that
 * TypeScript cannot express. Everything else is a type error.
 *
 *   no-throw               a block raises typed failures: `yield* raise(e)`
 *   no-read-in-view-body   a view has no body: every read is a hole (D-032)
 *   yield-in-jsx-hole      every `yield*` in JSX is in a position the transform turns into a hole
 *   read-before-attempt    a $memo reads before its first `attempt`
 *   no-unyielded-write     an operation acts only as `yield* op` (setters; with types, event calls and any op)
 *   no-foreign-reactive    no reactive state from plain Solid, the router or another library
 *   no-path-object-use     a path is a read: no spread, no `===`, no `JSON.stringify` of one
 *   no-dollar-block        `$` / `$scope` are removed: bare `function*` holes and rows, `$memo` derivations (autofix)
 *   typed-props-key        exported components name their type-linker key
 */
import {
  blockKind,
  enclosingFunction,
  isCallTo,
  isCapitalizedCall,
  jsxPosition,
  kindAt
} from "./blocks.js";

/**
 * The positions the JSX transform's block rule refuses — the same list as
 * `REFUSALS` in packages/compiler/src/blocks_rule.rs and
 * packages/babel-plugin/src/shared/blocks-rule.ts (pinned by
 * packages/compiler/tests/blocks-rule-fixtures.json).
 */
export const REFUSALS = {
  BLOCKS_YIELD_IN_EVENT:
    "a `yield*` in an event handler prop would read once, at render: read inside the `$event` instead",
  BLOCKS_YIELD_IN_REF: "a `yield*` in a `ref` has no hole to read in: a ref is set once",
  BLOCKS_YIELD_IN_SPREAD:
    "a `yield*` in a spread cannot become a hole: spread an object of values, or pass each prop",
  BLOCKS_YIELD_IN_SPREAD_CHILD: "a `yield*` in a spread child cannot become a hole",
  BLOCKS_PLAIN_YIELD_IN_JSX: "a plain `yield` inside JSX is not a read: use `yield*`"
};

/** The refusal code for a `yield` in JSX, or null when the transform accepts it. */
export function refusalFor(node, position) {
  if (!node.delegate) return "BLOCKS_PLAIN_YIELD_IN_JSX";
  if (position.hole === "spread") return "BLOCKS_YIELD_IN_SPREAD";
  if (position.hole === "spread-child") return "BLOCKS_YIELD_IN_SPREAD_CHILD";
  if (position.hole === "attribute") {
    const name = position.name;
    if (name === "ref") return "BLOCKS_YIELD_IN_REF";
    if (/^on[A-Z]/.test(name) || /^(on|oncapture):/.test(name)) return "BLOCKS_YIELD_IN_EVENT";
  }
  return null;
}

const noThrow = {
  meta: {
    type: "problem",
    docs: {
      description: "A block raises typed failures with `yield* raise(error)`, never `throw`."
    },
    messages: {
      throw:
        "`throw` in a block is an untyped failure: use `yield* raise(error)` so readers see it in the type."
    },
    schema: []
  },
  create(context) {
    return {
      ThrowStatement(node) {
        if (kindAt(node)) context.report({ node, messageId: "throw" });
      }
    };
  }
};

/**
 * A JSX view has no body (D-032): `function* () { return <…/>; }`. Every
 * read is a hole — a `yield*` in a JSX expression or attribute. An `h` view
 * (no JSX in its body) is the type's (`[HVIEW_READ]`, D-049), not this rule's.
 */
/** Whether a function's body holds JSX (an `h` view holds none). */
const jsxViews = new WeakMap();
function isJsxView(fn) {
  if (jsxViews.has(fn)) return jsxViews.get(fn);
  let found = false;
  const visit = node => {
    if (found || !node || typeof node.type !== "string") return;
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  };
  visit(fn.body);
  jsxViews.set(fn, found);
  return found;
}

const noReadInViewBody = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A view does not read: every read is a hole (a `yield*` in JSX, a bare `function*` hole in `h` / `html`); structure comes from flow controls."
    },
    messages: {
      read: "a view does not read: read in a hole (`{yield* …}` in JSX, a bare `function*` in `h` / `html`), branch with <Show> / <Match>, derive with a $memo in the setup.",
      child:
        "a view does not read: a child view is rendered by a hole (`{yield* Child(props)}` in JSX, `h(Child, props)` without JSX)."
    },
    schema: []
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (!node.delegate) return;
        if (kindAt(node) !== "view") return;
        if (jsxPosition(node)) return;
        // an `h` view is held by its type (`[HVIEW_READ]`), not the lint (D-049)
        if (!isJsxView(enclosingFunction(node))) return;
        context.report({
          node,
          messageId: isCapitalizedCall(node.argument) ? "child" : "read"
        });
      }
    };
  }
};

const yieldInJsxHole = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every `yield*` in JSX is in a position the JSX transform turns into a hole (the transform refuses the rest)."
    },
    messages: Object.fromEntries(
      Object.entries(REFUSALS).map(([code, m]) => [code, `[${code}] ${m}`])
    ),
    schema: []
  },
  create(context) {
    return {
      YieldExpression(node) {
        const position = jsxPosition(node);
        if (!position) return;
        const code = refusalFor(node, position);
        if (code) context.report({ node, messageId: code });
      }
    };
  }
};

const readBeforeAttempt = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A $memo reads before its first `attempt`: after an async attempt the memo resumes outside tracking."
    },
    messages: {
      after:
        "a $memo reads before its first `attempt`: this read would not be tracked after an async attempt."
    },
    schema: []
  },
  create(context) {
    const attempts = new WeakMap();
    return {
      YieldExpression(node) {
        if (!node.delegate) return;
        const fn = enclosingFunction(node);
        if (blockKind(fn) !== "memo") return;
        if (isCallTo(node.argument, ["attempt"])) {
          if (!attempts.has(fn)) attempts.set(fn, node.range[0]);
          return;
        }
        if (isCallTo(node.argument, ["raise"])) return;
        const first = attempts.get(fn);
        if (first !== undefined && node.range[0] > first)
          context.report({ node, messageId: "after" });
      }
    };
  }
};

/** Whether an identifier is a setter created by `yield* $signal / $store / $optimistic / $optimisticStore(…)`. */
function isBlockSetter(context, identifier) {
  const scope = context.sourceCode.getScope(identifier);
  let s = scope;
  let variable = null;
  while (s && !variable) {
    variable = s.set.get(identifier.name) || null;
    s = s.upper;
  }
  if (!variable || !variable.defs.length) return false;
  const def = variable.defs[0];
  const decl = def.node;
  if (!decl || decl.type !== "VariableDeclarator" || decl.id.type !== "ArrayPattern") return false;
  const element = decl.id.elements[1];
  if (!element || element.type !== "Identifier" || element.name !== identifier.name) return false;
  const init = decl.init;
  return (
    !!init &&
    init.type === "YieldExpression" &&
    init.delegate &&
    isCallTo(init.argument, ["$signal", "$store", "$optimistic", "$optimisticStore"])
  );
}

const OP_TYPES = new Set(["Yieldable", "Receipt", "EventCall", "Generator"]);

/** Whether a TypeScript type is (or extends) one of the named block-operation types. */
function isOpType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection && type.isUnionOrIntersection())
    return type.types.some(t => isOpType(t, seen));
  const sym = type.aliasSymbol || (type.getSymbol && type.getSymbol());
  if (sym && OP_TYPES.has(sym.getName())) return true;
  const target = type.target || type;
  const bases = (target.getBaseTypes && target.getBaseTypes()) || [];
  return bases.some(b => isOpType(b, seen));
}
function isEventCallType(type) {
  if (!type) return false;
  if (type.isUnionOrIntersection && type.isUnionOrIntersection())
    return type.types.some(isEventCallType);
  const sym = type.aliasSymbol || (type.getSymbol && type.getSymbol());
  return !!sym && sym.getName() === "EventCall";
}
/** `start(call)`: the call is the argument of `start`. */
function isStarted(node) {
  const p = node.parent;
  return !!p && isCallTo(p, ["start"]) && p.arguments[0] === node;
}
/** A call whose value nobody uses: a statement, `void x`, or an optional call statement. */
function isDiscarded(node) {
  let n = node;
  let p = n.parent;
  if (p && p.type === "ChainExpression") {
    n = p;
    p = p.parent;
  }
  return (
    !!p &&
    (p.type === "ExpressionStatement" || (p.type === "UnaryExpression" && p.operator === "void"))
  );
}

const noUnyieldedWrite = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A block operation acts only when delegated to: `yield* setX(v)`, `yield* save(x)` (an event call), `yield* attempt(…)`. With type information, any operation a block discards is reported."
    },
    messages: {
      unyielded:
        "`{{name}}(…)` writes nothing until it is delegated to: `yield* {{name}}(…)`, in an $event or an $effect.",
      discarded: "`{{name}}(…)` does nothing until it is delegated to: `yield* {{name}}(…)`.",
      eventCall:
        "`{{name}}(…)` is an event call this block does not delegate to: `yield* {{name}}(…)` waits for it (its colors join this block's type); `yield* start({{name}}(…))` runs it without waiting."
    },
    schema: []
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const checker =
      services && services.program && services.esTreeNodeToTSNodeMap
        ? services.program.getTypeChecker()
        : null;
    const nameOf = node => {
      const text = context.sourceCode.getText(node.callee);
      return text.length > 40 ? text.slice(0, 37) + "..." : text;
    };
    return {
      CallExpression(node) {
        const p = node.parent;
        if (p && p.type === "YieldExpression" && p.delegate && p.argument === node) return;
        if (node.callee.type === "Identifier" && isBlockSetter(context, node.callee)) {
          context.report({ node, messageId: "unyielded", data: { name: node.callee.name } });
          return;
        }
        if (!checker || !kindAt(node)) return;
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
        if (isEventCallType(type)) {
          // in a block an event call is delegated to, started, or kept to
          // delegate to later — never used as a bare promise (its colors would
          // not reach this block's type)
          if (isStarted(node) || (p && p.type === "VariableDeclarator" && p.init === node)) return;
          context.report({ node, messageId: "eventCall", data: { name: nameOf(node) } });
        } else if (isDiscarded(node) && isOpType(type))
          context.report({ node, messageId: "discarded", data: { name: nameOf(node) } });
      }
    };
  }
};

const ROUTE_PROPS =
  "the route component's props (`yield* props.location…`, `yield* props.params…`)";
const SOLID_FOREIGN = {
  createSignal: "`$signal`",
  createMemo: "`$memo`",
  createStore: "`$store`",
  createProjection: "`$projection`",
  createOptimistic: "`$optimistic`",
  createOptimisticStore: "`$optimisticStore`",
  createEffect: "`$effect`",
  createRenderEffect: "`$effect`",
  createTrackedEffect: "`$effect`",
  createReaction: "`$effect`",
  onSettled: "`$settled`",
  action: "`$event`",
  until: "`until` from @solidjs/blocks",
  refresh: "`refresh` from @solidjs/blocks",
  isPending: "`isPendingOf`",
  latest: "`latestOf`",
  untrack: "`$snapshot`",
  flush: null
};
/**
 * Reactive state that blocks cannot see: importing it into block code would
 * read or write outside `yield*`. Each name maps to its block replacement.
 */
export const FOREIGN_REACTIVE = {
  "solid-js": SOLID_FOREIGN,
  "@solidjs/signals": SOLID_FOREIGN,
  "@solidjs/router": {
    useLocation: ROUTE_PROPS,
    useParams: ROUTE_PROPS,
    useSearchParams: ROUTE_PROPS,
    useMatch: ROUTE_PROPS,
    useCurrentMatches: ROUTE_PROPS,
    useIsRouting: null,
    useSubmission: null,
    useSubmissions: null,
    createAsync: "`$memo`",
    createAsyncStore: "`$optimisticStore` or `$projection`"
  },
  "@solidjs/web": { dynamic: "`$dynamic`" }
};

const noForeignReactive = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Block code reads and writes only with `yield*`: no reactive state from plain Solid, the router or another library."
    },
    messages: {
      foreign:
        '`{{name}}` from "{{source}}" is reactive state blocks cannot see: blocks read and write only with `yield*`.{{hint}}'
    },
    schema: []
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const banned = FOREIGN_REACTIVE[node.source.value];
        if (!banned || node.importKind === "type") return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier" || spec.importKind === "type") continue;
          const name =
            spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          if (!Object.prototype.hasOwnProperty.call(banned, name)) continue;
          const use = banned[name];
          context.report({
            node: spec,
            messageId: "foreign",
            data: { name, source: node.source.value, hint: use ? ` Use ${use}.` : "" }
          });
        }
      }
    };
  }
};

const typedPropsKey = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description:
        'An exported $component names its type-linker key: `TypedProps<P, "Name">`, so callers\' coloring reaches its props.'
    },
    messages: {
      key: 'name this component\'s type-linker key: `TypedProps<…, "{{name}}">`.'
    },
    schema: [
      {
        type: "object",
        properties: { require: { enum: ["exported", "all"] } },
        additionalProperties: false
      }
    ]
  },
  create(context) {
    const mode = (context.options[0] && context.options[0].require) || "exported";
    return {
      CallExpression(node) {
        if (!isCallTo(node, ["$component"])) return;
        const fn = node.arguments[0];
        if (!fn || !fn.generator || !fn.params[0]) return;
        const annotation =
          fn.params[0].typeAnnotation && fn.params[0].typeAnnotation.typeAnnotation;
        if (!annotation || annotation.type !== "TSTypeReference") return;
        const typeName = annotation.typeName;
        if (typeName.type !== "Identifier" || typeName.name !== "TypedProps") return;
        const args = annotation.typeArguments || annotation.typeParameters;
        if (!args || args.params.length !== 1) return;
        const declarator = node.parent;
        if (
          !declarator ||
          declarator.type !== "VariableDeclarator" ||
          declarator.id.type !== "Identifier"
        )
          return;
        const name = declarator.id.name;
        const exported =
          declarator.parent &&
          declarator.parent.parent &&
          declarator.parent.parent.type === "ExportNamedDeclaration";
        if (mode === "exported" && !exported) return;
        context.report({
          node: annotation,
          messageId: "key",
          data: { name },
          fix: fixer => fixer.insertTextAfter(args.params[0], `, "${name}"`)
        });
      }
    };
  }
};

/** The flow-control props that read a source (where an `h`-flavor hole may stand). */
const FLOW_SOURCE_PROPS = new Set(["when", "each", "count", "on"]);
const FLOW_CONTROLS = new Set(["For", "Show", "Match", "Repeat", "Loading", "Errored", "Switch"]);

/** Whether `$` / `$scope` at `identifier` is the library's (imported from it, or unbound). */
function isLibraryBinding(context, identifier) {
  let s = context.sourceCode.getScope(identifier);
  while (s) {
    const variable = s.set.get(identifier.name);
    if (variable) {
      const def = variable.defs[0];
      return (
        !!def &&
        def.type === "ImportBinding" &&
        def.parent.type === "ImportDeclaration" &&
        def.parent.source.value === "@solidjs/blocks"
      );
    }
    s = s.upper;
  }
  return true;
}

/**
 * Whether a node is a hole of the no-JSX flavor: an argument of `h(…)` (a
 * child, or an attribute value in its props object), a value in an `html`
 * template, or a source prop (`when`, `each`, …) of a flow control called
 * directly. A bare `function*` is a hole there.
 */
function isHHole(node) {
  let child = node;
  let p = node.parent;
  let key = null;
  while (p) {
    if (p.type === "ArrayExpression") {
      child = p;
      p = p.parent;
      continue;
    }
    if (p.type === "Property" && p.value === child && p.parent.type === "ObjectExpression") {
      if (key !== null) return false;
      key = p.key.type === "Identifier" ? p.key.name : p.key.value;
      child = p.parent;
      p = child.parent;
      continue;
    }
    if (p.type === "TemplateLiteral")
      return (
        p.parent.type === "TaggedTemplateExpression" &&
        p.parent.tag.type === "Identifier" &&
        p.parent.tag.name === "html"
      );
    if (p.type === "CallExpression" && p.arguments.includes(child)) {
      const callee = p.callee.type === "Identifier" ? p.callee.name : null;
      if (callee === "h") {
        if (key !== null) return !/^on/.test(String(key)) && key !== "ref" && key !== "children";
        return p.arguments[0] !== child || child.type === "ArrayExpression";
      }
      if (callee && FLOW_CONTROLS.has(callee))
        return key !== null && FLOW_SOURCE_PROPS.has(String(key)) && child === p.arguments[0];
      return false;
    }
    return false;
  }
  return false;
}

const noDollarBlock = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "`$` and `$scope` are removed: a hole or a row is a bare `function*`, and a derivation several holes read is `yield* $memo(…)` in the setup (or the row's setup)."
    },
    messages: {
      hole: "`$` is removed: a hole is a bare `function*` here.",
      row: "`{{name}}` is removed: a row is a bare `function*` (its body is a setup that returns the row's view).",
      derived:
        "`$` is removed: a derivation is `yield* $memo(function* () { … })` in the setup (or the row's setup).",
      other:
        "`$` is removed: read inside JSX (`{yield* …}`), pass a bare `function*` hole to `h` / `html`, or derive with `yield* $memo(…)` in a setup.",
      import: "`{{name}}` is removed from @solidjs/blocks."
    },
    schema: []
  },
  create(context) {
    const source = context.sourceCode;
    let needsMemo = false;
    const unfixed = new Set();
    const imports = [];
    return {
      ImportDeclaration(node) {
        if (node.source.value === "@solidjs/blocks") imports.push(node);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "Identifier" || (callee.name !== "$" && callee.name !== "$scope"))
          return;
        if (!isLibraryBinding(context, callee)) return;
        const arg = node.arguments[0];
        const name = callee.name;
        const isGen =
          arg &&
          (arg.type === "FunctionExpression" || arg.type === "FunctionDeclaration") &&
          arg.generator;
        const argText = arg ? source.getText(arg) : "";
        // a row: `$(function* (item) …)`, `$scope(fn)`
        if (arg && (name === "$scope" || (isGen && arg.params.length > 0))) {
          context.report({
            node,
            messageId: "row",
            data: { name },
            fix: fixer => fixer.replaceText(node, argText)
          });
          return;
        }
        if (!isGen) {
          unfixed.add(name);
          context.report({ node, messageId: "other" });
          return;
        }
        // a hole of the no-JSX flavor
        if (isHHole(node)) {
          context.report({
            node,
            messageId: "hole",
            fix: fixer => fixer.replaceText(node, argText)
          });
          return;
        }
        // a derivation bound in a setup or a row's setup
        const p = node.parent;
        const kind = kindAt(node);
        if (
          p.type === "VariableDeclarator" &&
          p.init === node &&
          (kind === "setup" || kind === "row")
        ) {
          needsMemo = true;
          context.report({
            node,
            messageId: "derived",
            fix: fixer => fixer.replaceText(node, `yield* $memo(${argText})`)
          });
          return;
        }
        unfixed.add(name);
        context.report({ node, messageId: "other" });
      },
      "Program:exit"() {
        for (const decl of imports) {
          const specs = decl.specifiers.filter(
            s =>
              s.type === "ImportSpecifier" &&
              s.imported.type === "Identifier" &&
              (s.imported.name === "$" || s.imported.name === "$scope")
          );
          if (!specs.length) continue;
          const hasMemo = decl.specifiers.some(
            s => s.type === "ImportSpecifier" && s.local.name === "$memo"
          );
          // one fix for the declaration: drop the specifiers whose every use
          // was fixed, and import `$memo` when a fix introduced it
          const keep = decl.specifiers.filter(s => !specs.includes(s) || unfixed.has(s.local.name));
          const removable = keep.length < decl.specifiers.length;
          const named = keep.filter(s => s.type === "ImportSpecifier").map(s => source.getText(s));
          if (needsMemo && !hasMemo) {
            // after the `$` creators that sort before it
            let at = 0;
            named.forEach((text, i) => {
              if (text.startsWith("$") && text < "$memo") at = i + 1;
            });
            named.splice(at, 0, "$memo");
          }
          const others = keep.filter(s => s.type !== "ImportSpecifier").map(s => source.getText(s));
          const clause = [...others, ...(named.length ? [`{ ${named.join(", ")} }`] : [])].join(
            ", "
          );
          const fix = fixer =>
            clause
              ? fixer.replaceText(decl, `import ${clause} from ${source.getText(decl.source)};`)
              : fixer.remove(decl);
          specs.forEach((spec, i) =>
            context.report({
              node: spec,
              messageId: "import",
              data: { name: spec.imported.name },
              ...(i === 0 && removable ? { fix } : {})
            })
          );
        }
      }
    };
  }
};

/** The variable an identifier resolves to, or null. */
function resolve(context, identifier) {
  let s = context.sourceCode.getScope(identifier);
  while (s) {
    const variable = s.set.get(identifier.name);
    if (variable) return variable;
    s = s.upper;
  }
  return null;
}

/**
 * What a binding holds, as far as paths go: "path" (a store or a projection,
 * a row's argument — the binding itself is a path), "props" (a setup's props:
 * each key is a path, the object is not), or null.
 */
function pathBinding(context, identifier) {
  const variable = resolve(context, identifier);
  const def = variable && variable.defs[0];
  if (!def) return null;
  if (def.type === "Parameter") {
    const fn = def.node;
    const index = fn.params.findIndex(p => p === def.name || (p.left && p.left === def.name));
    const kind = blockKind(fn);
    if (kind === "row") return "path";
    if (kind === "setup" && index === 0) return "props";
    return null;
  }
  if (def.type === "Variable") {
    const decl = def.node;
    const init = decl.init;
    if (!init || init.type !== "YieldExpression" || !init.delegate) return null;
    if (
      decl.id.type === "ArrayPattern" &&
      decl.id.elements[0] === def.name &&
      isCallTo(init.argument, ["$store", "$optimisticStore"])
    )
      return "path";
    if (decl.id === def.name && isCallTo(init.argument, ["$projection"])) return "path";
  }
  return null;
}

/** Whether an expression is a path (syntactically): a store, a row argument, a prop, or a key of one. */
function isPathExpression(context, node) {
  let n = node;
  while (n.type === "TSNonNullExpression" || n.type === "TSAsExpression") n = n.expression;
  if (n.type === "ChainExpression") n = n.expression;
  if (n.type === "Identifier") return pathBinding(context, n) === "path";
  if (n.type !== "MemberExpression") return false;
  let root = n;
  while (root.type === "MemberExpression") root = root.object;
  if (root.type !== "Identifier") return false;
  const binding = pathBinding(context, root);
  return binding === "path" || binding === "props";
}

const noPathObjectUse = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A path (a prop, a store or a row argument, or a key of one) is a read, not an object: spreading it, comparing it with `===` or `JSON.stringify`-ing it never sees the data."
    },
    messages: {
      spread:
        "spreading a path copies no data (it is a read, not an object): spread `yield* {{text}}`, or pass the path on as it is.",
      compare:
        "a path is a read, not a value: compare `(yield* {{text}})`, not the path (two paths are never the same object).",
      stringify:
        "`JSON.stringify` of a path gives its description, not its data: stringify `yield* {{text}}`."
    },
    schema: []
  },
  create(context) {
    const text = node => {
      const t = context.sourceCode.getText(node);
      return t.length > 40 ? t.slice(0, 37) + "..." : t;
    };
    const check = (node, messageId) => {
      if (node && isPathExpression(context, node))
        context.report({ node, messageId, data: { text: text(node) } });
    };
    return {
      SpreadElement(node) {
        check(node.argument, "spread");
      },
      JSXSpreadAttribute(node) {
        check(node.argument, "spread");
      },
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        check(node.left, "compare");
        check(node.right, "compare");
      },
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type === "MemberExpression" &&
          !c.computed &&
          c.object.type === "Identifier" &&
          c.object.name === "JSON" &&
          c.property.type === "Identifier" &&
          c.property.name === "stringify"
        )
          check(node.arguments[0], "stringify");
      }
    };
  }
};

export const rules = {
  "no-throw": noThrow,
  "no-read-in-view-body": noReadInViewBody,
  "yield-in-jsx-hole": yieldInJsxHole,
  "read-before-attempt": readBeforeAttempt,
  "no-unyielded-write": noUnyieldedWrite,
  "no-foreign-reactive": noForeignReactive,
  "no-dollar-block": noDollarBlock,
  "no-path-object-use": noPathObjectUse,
  "typed-props-key": typedPropsKey
};

const plugin = {
  meta: { name: "@solidjs/eslint-plugin-blocks", version: "0.0.0" },
  rules,
  configs: {}
};

/** `recommended`: every rule as an error (flat config). */
plugin.configs.recommended = {
  plugins: { "@solidjs/blocks": plugin },
  rules: Object.fromEntries(Object.keys(rules).map(name => [`@solidjs/blocks/${name}`, "error"]))
};

export default plugin;
