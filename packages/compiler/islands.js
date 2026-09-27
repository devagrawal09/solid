"use strict";
// Stage 3 (F, compiler-scoped lazy hydration) — the island linker.
//
// Joins per-module island summaries (`summarizeIslands`) over a module graph
// into the map lazy hydration needs to obey the hydrate-before-write rule
// (documentation/plans/resumability.md): before a handler writes, every
// island that reads what it writes must be hydrated while the state still
// equals the server's.
//
//   linkIslands({ modules, resolve, islands }) → {
//     cells,     // every cell, "module#name"
//     islands,   // island → the cells it may read
//     exports,   // "module#export" → { writes, islands } for exported functions
//     handlers,  // JSX handlers: { module, start, event, writes, islands }
//     onEvent,   // island → islands to hydrate before the first event in it
//                //   is handled: itself plus every handler it contains
//     escaped,   // cells whose setter escaped (see below)
//     escapedRead // cells whose accessor escaped
//   }
//
// Inputs: `modules` maps a module id to its summary; `resolve(fromId,
// source)` returns the module id an import specifier names, or null for a
// module outside the analyzed graph; `islands` maps an island name to
// { module, export } (the island's root component).
//
// Closure: a record reads / writes what its body does, plus what every record
// it calls or contains does — except that reads do not flow out of event
// handlers (they run untracked). The summary over-approximates reads (any
// reference) and writes (any direct setter call); a setter or accessor
// referenced without a call escapes (as do cells the summary cannot name),
// and every record that calls unknown code (a parameter, a member, a module
// outside the graph) is then assumed to write every write-escaped cell and
// read every read-escaped one. The result is sound for code the summaries cover: a handler's
// `islands` is a superset of the islands whose reads its writes can reach.

function linkIslands({ modules, resolve, islands }) {
  const ids = Object.keys(modules);
  const cellKey = (m, i) => {
    const cells = modules[m].cells;
    const name = cells[i].name;
    const dup = cells.some((c, j) => j !== i && c.name === name);
    return `${m}#${name}${dup ? `~${i}` : ""}`;
  };
  const recordKey = (m, i) => `${m}:${i}`;

  // An exported name → its binding in the defining module (follows
  // `export { x }` of an imported binding through the graph).
  function resolveExport(m, name, seen = new Set()) {
    const summary = modules[m];
    if (!summary || seen.has(`${m}#${name}`)) return null;
    seen.add(`${m}#${name}`);
    const entry = summary.exports.find(e => e.name === name);
    if (!entry) return null;
    if (entry.record !== undefined) return { module: m, binding: { record: entry.record } };
    return resolveLocal(m, entry.local, seen);
  }
  function resolveLocal(m, local, seen = new Set()) {
    const summary = modules[m];
    const binding = summary.bindings[local];
    if (!binding) return null;
    if (!binding.import) return { module: m, binding };
    const imp = summary.imports.find(i => i.local === local);
    const target = imp && resolve(m, imp.source);
    if (target == null || !modules[target]) return null;
    return resolveExport(target, imp.imported, seen);
  }

  // Direct facts per record, with imports resolved. `escaped` / `escapedRead`:
  // cells whose setter / accessor was handed out (or that are opaque).
  const nodes = new Map();
  const escaped = new Set();
  const escapedRead = new Set();
  for (const m of ids) {
    const top = modules[m].escapes;
    for (const c of top.write) escaped.add(cellKey(m, c));
    for (const c of top.read) escapedRead.add(cellKey(m, c));
    modules[m].records.forEach((r, i) => {
      const node = {
        reads: new Set(r.reads.map(c => cellKey(m, c))),
        writes: new Set(r.writes.map(c => cellKey(m, c))),
        edges: [...r.calls, ...r.contains].map(j => recordKey(m, j)),
        unknown: r.unknownCalls
      };
      for (const c of r.escapes) escaped.add(cellKey(m, c));
      for (const c of r.readEscapes) escapedRead.add(cellKey(m, c));
      for (const { local, called, member } of r.imports) {
        const target = resolveLocal(m, local);
        if (!target) {
          if (called) node.unknown = true;
          continue;
        }
        const { module: t, binding: b } = target;
        if (b.read !== undefined) {
          node.reads.add(cellKey(t, b.read));
          if (!called) escapedRead.add(cellKey(t, b.read));
        } else if (b.write !== undefined) {
          node.writes.add(cellKey(t, b.write));
          if (!called) escaped.add(cellKey(t, b.write));
        } else if (b.family !== undefined) {
          // `X[i][0]()` reads a member, `X[i][1](…)` writes one; any other
          // reference hands out the accessors and setters.
          const k = cellKey(t, b.family);
          node.reads.add(k);
          if (member !== "read") node.writes.add(k);
          if (member == null) {
            escaped.add(k);
            escapedRead.add(k);
          }
        } else if (b.record !== undefined) node.edges.push(recordKey(t, b.record));
      }
      nodes.set(recordKey(m, i), node);
    });
  }

  // Transitive closure (fixpoint; the graphs are small). Reads do not flow
  // out of event handlers: a handler runs untracked, so what it reads (and
  // any unknown code it calls) is not a subscription of the island that
  // contains it. Writes, unknown calls for writes, and reachability follow
  // every edge.
  const handlerKeys = new Set();
  for (const m of ids) for (const h of modules[m].handlers) handlerKeys.add(recordKey(m, h.record));
  const closed = new Map();
  for (const [k, n] of nodes)
    closed.set(k, {
      reads: new Set(n.reads),
      writes: new Set(n.writes),
      unknownRead: n.unknown,
      unknownWrite: n.unknown,
      reach: new Set([k])
    });
  const size = c =>
    c.reads.size +
    c.writes.size +
    c.reach.size +
    (c.unknownRead ? 1 : 0) +
    (c.unknownWrite ? 1 : 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [k, n] of nodes) {
      const c = closed.get(k);
      for (const e of n.edges) {
        const d = closed.get(e);
        if (!d) continue;
        const before = size(c);
        if (!handlerKeys.has(e)) {
          for (const x of d.reads) c.reads.add(x);
          c.unknownRead ||= d.unknownRead;
        }
        for (const x of d.writes) c.writes.add(x);
        for (const x of d.reach) c.reach.add(x);
        c.unknownWrite ||= d.unknownWrite;
        if (size(c) !== before) changed = true;
      }
    }
  }
  for (const c of closed.values()) {
    if (c.unknownWrite) for (const x of escaped) c.writes.add(x);
    if (c.unknownRead) for (const x of escapedRead) c.reads.add(x);
  }

  // Islands.
  const islandReads = {};
  const islandRoot = {};
  for (const [name, { module: m, export: e }] of Object.entries(islands)) {
    const target = resolveExport(m, e);
    if (!target || target.binding.record === undefined)
      throw new Error(`island "${name}": ${m}#${e} is not a function the summaries cover`);
    islandRoot[name] = recordKey(target.module, target.binding.record);
    islandReads[name] = closed.get(islandRoot[name]).reads;
  }
  const affected = writes =>
    Object.keys(islands).filter(name => [...writes].some(w => islandReads[name].has(w)));

  const exportsOut = {};
  for (const m of ids)
    for (const e of modules[m].exports) {
      const target = resolveExport(m, e.name);
      if (!target || target.binding.record === undefined) continue;
      const c = closed.get(recordKey(target.module, target.binding.record));
      exportsOut[`${m}#${e.name}`] = { writes: [...c.writes].sort(), islands: affected(c.writes) };
    }
  const handlers = [];
  for (const m of ids)
    for (const h of modules[m].handlers) {
      const key = recordKey(m, h.record);
      const c = closed.get(key);
      handlers.push({
        module: m,
        start: h.start,
        event: h.event,
        key,
        writes: [...c.writes].sort(),
        islands: affected(c.writes)
      });
    }
  const onEvent = {};
  for (const name of Object.keys(islands)) {
    const reach = closed.get(islandRoot[name]).reach;
    const set = new Set([name]);
    for (const h of handlers) if (reach.has(h.key)) for (const i of h.islands) set.add(i);
    onEvent[name] = Object.keys(islands).filter(i => set.has(i));
  }

  const cells = [];
  for (const m of ids) modules[m].cells.forEach((_, i) => cells.push(cellKey(m, i)));
  return {
    cells,
    islands: Object.fromEntries(Object.entries(islandReads).map(([k, v]) => [k, [...v].sort()])),
    exports: exportsOut,
    handlers: handlers.map(({ key, ...h }) => h),
    onEvent,
    escaped: [...escaped].sort(),
    escapedRead: [...escapedRead].sort()
  };
}

module.exports = { linkIslands };
