/**
 * @solidjs/eslint-plugin-blocks — the strict rules of @solidjs/blocks that
 * TypeScript cannot express. Everything else is a type error.
 *
 *   no-throw               a block raises typed failures: `yield* raise(e)`
 *   no-read-outside-hole   a JSX view reads only inside JSX (else it re-renders whole)
 *   yield-in-jsx-hole      every `yield*` in JSX is in a position the transform turns into a hole
 *   read-before-attempt    a $memo reads before its first `attempt`
 *   no-unyielded-write     a setter call writes only as `yield* setX(v)`
 *   no-foreign-reactive    no reactive state from plain Solid, the router or another library
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

const noReadOutsideHole = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A JSX view reads only inside JSX: a read in a statement makes the view re-render as a whole."
    },
    messages: {
      read: "this view re-renders as a whole; move the read into JSX or a $memo.",
      child: "a child view is rendered by a hole: write `{yield* Child(props)}` inside JSX."
    },
    schema: []
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (!node.delegate) return;
        const kind = kindAt(node);
        if (kind !== "view") return;
        if (jsxPosition(node)) return;
        // Every `yield*` of a view belongs in JSX — a read, and also a child
        // view (`{yield* Child(props)}`), which only a hole can render.
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

const noUnyieldedWrite = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A block setter writes only when its receipt is delegated to: `yield* setX(v)`, in an $event or an $effect."
    },
    messages: {
      unyielded:
        "`{{name}}(…)` writes nothing until it is delegated to: `yield* {{name}}(…)`, in an $event or an $effect."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        const p = node.parent;
        if (p && p.type === "YieldExpression" && p.delegate && p.argument === node) return;
        if (!isBlockSetter(context, node.callee)) return;
        context.report({ node, messageId: "unyielded", data: { name: node.callee.name } });
      }
    };
  }
};

const ROUTE_PROPS = "the route component's props (`yield* props.location…`, `yield* props.params…`)";
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
        "`{{name}}` from \"{{source}}\" is reactive state blocks cannot see: blocks read and write only with `yield*`.{{hint}}"
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
          const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
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

export const rules = {
  "no-throw": noThrow,
  "no-read-outside-hole": noReadOutsideHole,
  "yield-in-jsx-hole": yieldInJsxHole,
  "read-before-attempt": readBeforeAttempt,
  "no-unyielded-write": noUnyieldedWrite,
  "no-foreign-reactive": noForeignReactive,
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
