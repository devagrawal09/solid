/**
 * @solidjs/eslint-plugin-blocks — the strict rules of @solidjs/blocks that
 * TypeScript cannot express. Everything else is a type error.
 *
 *   no-throw               a block raises typed failures: `yield* raise(e)`
 *   no-read-outside-hole   a JSX view reads only inside JSX (else it re-renders whole)
 *   yield-in-jsx-hole      every `yield*` in JSX is in a position the transform turns into a hole
 *   read-before-attempt    a $memo reads before its first `attempt`
 *   no-write-in-reactive   a setup, view, memo or hole block does not call a setter
 *   typed-props-key        exported components name their type-linker key
 */
import {
  REACTIVE,
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
      read: "this view re-renders as a whole; move the read into JSX or a $memo."
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
        // `yield* Child(props)` propagates a child view: not a read.
        if (isCapitalizedCall(node.argument)) return;
        context.report({ node, messageId: "read" });
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

/** Whether an identifier is a setter created by `yield* $signal(…)` / `yield* $store(…)`. */
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
    isCallTo(init.argument, ["$signal", "$store"])
  );
}

const noWriteInReactive = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A setup, view, memo or hole block does not write: writes belong in an $event or an $effect."
    },
    messages: {
      write: "{{kind}} does not write: write in an $event or an $effect."
    },
    schema: []
  },
  create(context) {
    const names = {
      memo: "a $memo",
      view: "a view",
      hole: "a hole block",
      setup: "a setup",
      row: "a row block's setup"
    };
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        const kind = kindAt(node);
        if (!kind || !REACTIVE.has(kind)) return;
        if (!isBlockSetter(context, node.callee)) return;
        context.report({ node, messageId: "write", data: { kind: names[kind] } });
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
  "no-write-in-reactive": noWriteInReactive,
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
