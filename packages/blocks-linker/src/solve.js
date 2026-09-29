/**
 * The graph solve: from per-module summaries (the Rust analysis,
 * `summarizeBlocks`) to each component's prop colors.
 *
 * A color is a set of "may" facts joined over every known render site:
 *   pending  — reading the prop may be pending (a memo that attempts, …)
 *   fails    — the failures reading it may raise (type references, or "unknown")
 *   live     — the prop may change after render (a source is passed)
 *   static   — every caller passes a literal / module constant (a must-fact: AND)
 *   unknown  — some caller passes something the syntax does not show
 * `props.x` passed through takes the caller's own callers' facts: a
 * monotone fixpoint over the graph. Components whose callers cannot all be
 * seen (used as values, exported from public modules) are *open*: they keep
 * their declared (uncolored) type.
 */
import path from "node:path";

export const GLOBAL_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException"
]);

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];

/** The least color: what a component with no callers yet starts from. */
function bottom() {
  return {
    pending: false,
    fails: new Set(),
    failsUnknown: false,
    live: false,
    static: true,
    unknown: false
  };
}
function declared() {
  return {
    pending: false,
    fails: new Set(),
    failsUnknown: false,
    live: true,
    static: false,
    unknown: true
  };
}
function join(a, b) {
  return {
    pending: a.pending || b.pending,
    fails: new Set([...a.fails, ...b.fails]),
    failsUnknown: a.failsUnknown || b.failsUnknown,
    live: a.live || b.live,
    static: a.static && b.static,
    unknown: a.unknown || b.unknown
  };
}
function same(a, b) {
  if (
    a.pending !== b.pending ||
    a.failsUnknown !== b.failsUnknown ||
    a.live !== b.live ||
    a.static !== b.static ||
    a.unknown !== b.unknown ||
    a.fails.size !== b.fails.size
  )
    return false;
  for (const f of a.fails) if (!b.fails.has(f)) return false;
  return true;
}

/**
 * Resolve a module specifier from `fromFile` to a known module id (an
 * absolute path in `modules`), or null.
 */
export function resolveModule(fromFile, specifier, modules, alias = {}) {
  let base = null;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else {
    for (const [prefix, dir] of Object.entries(alias)) {
      if (
        specifier === prefix ||
        specifier.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
      ) {
        base = path.join(dir, specifier.slice(prefix.length));
        break;
      }
    }
  }
  if (!base) return null;
  const stripped = base.replace(/\.(js|jsx|mjs)$/, "");
  const candidates = [
    base,
    ...EXTENSIONS.map(e => stripped + e),
    ...EXTENSIONS.map(e => path.join(base, "index" + e))
  ];
  for (const c of candidates) if (modules.has(c)) return c;
  return null;
}

/**
 * Solve colors for every component.
 * @param {Map<string, object>} modules module id (absolute path) → summary
 * @param {{ alias?: Record<string,string>, isPublic?: (id: string) => boolean }} options
 */
export function solve(modules, options = {}) {
  const alias = options.alias || {};
  const isPublic = options.isPublic || (() => false);
  const rel = file =>
    options.root ? path.relative(options.root, file).split(path.sep).join("/") : file;
  /** component id → info */
  const components = new Map();
  for (const [id, summary] of modules) {
    for (const c of summary.components) {
      components.set(`${id}#${c.local}`, {
        id: `${id}#${c.local}`,
        file: id,
        ...c,
        callers: [],
        open: false,
        why: []
      });
    }
  }

  /** follow a module's export name to a component id */
  function exported(file, name, seen = new Set()) {
    const key = file + "|" + name;
    if (seen.has(key)) return null;
    seen.add(key);
    const summary = modules.get(file);
    if (!summary) return null;
    for (const e of summary.exports) {
      if (e.exported === name) return local(file, e.local, seen);
    }
    for (const r of summary.reexports) {
      if (r.exported === name || r.exported === "*") {
        const target = resolveModule(file, r.source, modules, alias);
        if (target) {
          const found = exported(target, r.exported === "*" ? name : r.imported, seen);
          if (found) return found;
        }
      }
    }
    return null;
  }
  /** a module-local name to a component id (own component, or imported) */
  function local(file, name, seen = new Set()) {
    if (components.has(`${file}#${name}`)) return `${file}#${name}`;
    const summary = modules.get(file);
    if (!summary) return null;
    const imp = summary.imports.find(i => i.local === name);
    if (!imp) return null;
    const target = resolveModule(file, imp.source, modules, alias);
    if (!target) return null;
    return exported(target, imp.imported, seen);
  }

  // callers and escapes
  for (const [file, summary] of modules) {
    for (const site of summary.renders) {
      const target = local(file, site.component);
      if (!target) continue;
      const owner = site.owner ? `${file}#${site.owner}` : null;
      components
        .get(target)
        .callers.push({ file, site, owner: owner && components.has(owner) ? owner : null });
    }
    for (const e of summary.escapes) {
      const target = local(file, e.name);
      if (target) {
        const c = components.get(target);
        c.open = true;
        c.why.push(`used as a value in ${rel(file)}`);
      }
    }
    if (isPublic(file)) {
      for (const e of summary.exports) {
        const target = local(file, e.local);
        if (target) {
          const c = components.get(target);
          c.open = true;
          c.why.push(`exported from public module ${rel(file)} as ${e.exported}`);
        }
      }
    }
  }

  // failures: class names local to a module → type references
  function failRef(file, name) {
    if (name === "*") return null;
    if (GLOBAL_ERRORS.has(name)) return { global: name };
    const summary = modules.get(file);
    const imp = summary.imports.find(i => i.local === name);
    if (imp) {
      const target = resolveModule(file, imp.source, modules, alias);
      if (target) return { file: target, name: imp.imported };
      if (!imp.source.startsWith(".")) return { module: imp.source, name: imp.imported };
      return null;
    }
    if (summary.classes.includes(name)) {
      const e = summary.exports.find(x => x.local === name);
      if (e) return { file, name: e.exported };
    }
    return null;
  }

  const colors = new Map(); // component id → Map<prop, color>
  for (const id of components.keys()) colors.set(id, new Map());

  function propColor(ownerId, name) {
    if (!ownerId) return declared();
    const owner = components.get(ownerId);
    if (owner.open || owner.callers.length === 0) return declared();
    return colors.get(ownerId).get(name) || bottom();
  }

  function colorOf(fact, file, ownerId) {
    switch (fact.k) {
      case "static":
        return { ...bottom() };
      case "value":
      case "live":
        return {
          pending: false,
          fails: new Set(),
          failsUnknown: false,
          live: true,
          static: false,
          unknown: false
        };
      case "prop":
        return propColor(ownerId, fact.name);
      case "memo": {
        let c = {
          pending: fact.pending,
          fails: new Set(),
          failsUnknown: false,
          live: true,
          static: false,
          unknown: false
        };
        for (const f of fact.fails) {
          const ref = failRef(file, f);
          if (ref) c.fails.add(JSON.stringify(ref));
          else c.failsUnknown = true;
        }
        for (const r of fact.reads) {
          const rc = colorOf(r, file, ownerId);
          c = join(c, { ...rc, live: true, static: false });
        }
        return c;
      }
      default:
        return declared();
    }
  }

  // fixpoint
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 100) {
    changed = false;
    rounds++;
    for (const [id, c] of components) {
      if (c.open) continue;
      const props = new Set();
      for (const { site } of c.callers) for (const p of Object.keys(site.props)) props.add(p);
      for (const p of props) {
        let color = null;
        for (const { file, site, owner } of c.callers) {
          const fact = site.props[p];
          const pc = fact ? colorOf(fact, file, owner) : site.spread ? declared() : { ...bottom() };
          color = color ? join(color, pc) : pc;
        }
        const prev = colors.get(id).get(p);
        if (!prev || !same(prev, color)) {
          colors.get(id).set(p, color);
          changed = true;
        }
      }
    }
  }

  // diagnostics
  const diagnostics = [];
  for (const c of components.values()) {
    const cs = colors.get(c.id);
    const colored = [...cs.values()].some(x => x.pending || x.fails.size || x.failsUnknown);
    if (!c.key && colored && !c.open)
      diagnostics.push({
        level: "warning",
        code: "LINK_NO_KEY",
        component: c.id,
        message: `${c.local} (${rel(c.file)}): callers pass pending or failing values, but its props have no linker key; declare TypedProps<…, "${c.local}"> so its view sees them`
      });
  }
  return { components, colors, diagnostics, rounds };
}
