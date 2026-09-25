// Linker analysis over one environment's complete graph (see load.js):
//
// 1. Resolve every import binding through re-exports and `export *` to its
//    declaring (module, binding), cross-checked against solid-tsc's resolved
//    identity when typed summaries are present.
// 2. Prove candidate blocks event-only: every site the block value reaches
//    is a DOM event sink — directly, through component props that only bind
//    DOM events (recursively, across modules), or through imports whose
//    every use is such a site. Everything a proof cannot see (escapes,
//    unknown modules, stale or inconsistent metadata, propagation control
//    outside a replayable prelude, event methods, the event object escaping)
//    makes the block `hot` or `unknown`, with reasons.
// 3. Classify to a fixed point. Labels HOT / COLD / UNKNOWN propagate over
//    module-evaluation and binding-reference edges; references that occur
//    only inside extracted bodies are COLD edges. Cold-only bindings of a
//    hot-evaluated module are moved to a residue module unless something
//    pins them (effects, actions, re-exports, importers that are not
//    generated, a shell inside the statement); each pinned binding is
//    re-rooted HOT and propagation re-runs, until nothing changes.
// 4. Cluster extracted blocks into interaction domains.
import path from "node:path";
import { sourceHash } from "./load.js";

const HOT = 1;
const COLD = 2;
const UNKNOWN = 4;

export const LABELS = { HOT, COLD, UNKNOWN };

/** Module-level `unknowns` that hide references (the module's graph is unknowable). */
const OPAQUE_UNKNOWNS = new Set(["eval", "with", "newFunction", "require"]);
/** Event members a replayable prelude may touch. */
const PRELUDE_KINDS = new Set(["preventDefault", "stopPropagation", "stopImmediatePropagation"]);

export function classOf(bits) {
  if (bits & UNKNOWN) return "unknown";
  if (bits & HOT && bits & COLD) return "shared";
  if (bits & HOT) return "hot";
  if (bits & COLD) return "cold";
  return "unused";
}

function within(inner, outer) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Analyze a loaded graph. Options:
 * - `environment`: "client" | "server" (recorded; the analysis is the same,
 *   run independently per graph);
 * - `strict` (default true): candidate blocks require valid typed summaries;
 * - `maxDomainBytes` (default 48 KiB): clustering size cap per domain.
 */
export function analyze(
  graph,
  { environment = "client", strict = true, maxDomainBytes = 48 * 1024, root } = {}
) {
  const started = performance.now();
  const modules = graph.modules;
  const byRel = new Map();
  for (const record of modules.values()) byRel.set(record.rel, record);
  const entryIds = new Set(graph.entries);

  // -- per-module indexes ----------------------------------------------------
  const info = new Map();
  let nonLiteralDynamicImport = null;
  for (const record of modules.values()) {
    const behavior = record.behavior;
    const entry = {
      record,
      bindings: new Map(),
      statements: new Map(),
      effectful: false,
      opaque: record.status !== "ok" || !behavior,
      pinnedStatements: new Set(),
      importSpecifiers: new Map()
    };
    info.set(record.id, entry);
    if (!behavior) continue;
    for (const binding of behavior.bindings) {
      entry.bindings.set(binding.name, binding);
      // Import declarations are rewritten specifier by specifier, never moved.
      if (binding.statement == null || binding.kind === "import") continue;
      let statement = entry.statements.get(binding.statement);
      if (!statement) {
        statement = {
          index: binding.statement,
          span: binding.statementSpan,
          bindings: [],
          refs: new Map(),
          effects: false
        };
        entry.statements.set(binding.statement, statement);
      }
      statement.bindings.push(binding.name);
      statement.effects ||= binding.effects;
      for (const ref of binding.refs) {
        statement.refs.set(ref.name, Math.max(statement.refs.get(ref.name) ?? 0, ref.count));
      }
    }
    entry.effectful =
      behavior.topLevel.effects ||
      behavior.bindings.some(binding => binding.effects && binding.kind !== "import");
    for (const unknown of behavior.unknowns) {
      if (OPAQUE_UNKNOWNS.has(unknown.kind)) entry.opaque = true;
      if (unknown.kind === "dynamicImportNonLiteral") nonLiteralDynamicImport ??= record.rel;
      if (unknown.kind === "importMeta") {
        for (const statement of entry.statements.values()) {
          if (within(unknown.span, statement.span)) entry.pinnedStatements.add(statement.index);
        }
      }
    }
    for (const declaration of behavior.imports) {
      for (const specifier of declaration.specifiers) {
        entry.importSpecifiers.set(specifier.local, { declaration, specifier });
      }
    }
    if (entry.opaque) entry.effectful = true;
  }

  const resolvedId = (record, source) => {
    const target = record.resolved.get(source);
    return target && target.id ? target.id : null;
  };
  const isRuntime = (record, source) => !!record.resolved.get(source)?.runtime;

  // -- export resolution -------------------------------------------------------
  const exportCache = new Map();
  /** → { module, binding } | { module, namespace: true } | { runtime } | { unknown, reason } */
  function resolveExport(id, name, seen = new Set()) {
    const cacheKey = id + "\0" + name;
    if (exportCache.has(cacheKey)) return exportCache.get(cacheKey);
    if (seen.has(cacheKey)) return { unknown: true, reason: "exportCycle" };
    seen.add(cacheKey);
    const record = modules.get(id);
    let result;
    if (!record || !record.behavior) {
      result =
        record?.kind === "runtime"
          ? { runtime: true }
          : { unknown: true, reason: `module:${record?.status ?? "missing"}` };
    } else {
      const exported = record.behavior.exports.find(entry => entry.exported === name);
      if (exported) {
        if (exported.kind === "local") {
          result = { module: id, binding: exported.local ?? "default" };
        } else if (exported.kind === "reexport") {
          const target = resolvedId(record, exported.source);
          result = isRuntime(record, exported.source)
            ? { runtime: true }
            : target
              ? withVia(resolveExport(target, exported.imported, seen), target)
              : { unknown: true, reason: "unresolvedReexport" };
        } else if (exported.kind === "namespace") {
          const target = resolvedId(record, exported.source);
          result = target
            ? { module: target, namespace: true }
            : { unknown: true, reason: "unresolvedNamespace" };
        }
      } else {
        for (const star of record.behavior.exports.filter(entry => entry.kind === "star")) {
          const target = resolvedId(record, star.source);
          if (!target) {
            result = { unknown: true, reason: "unresolvedExportStar" };
            break;
          }
          const found = resolveExport(target, name, seen);
          if (!found.unknown || found.reason !== "missingExport") {
            result = withVia(found, target);
            break;
          }
        }
        result ??= { unknown: true, reason: "missingExport" };
      }
    }
    exportCache.set(cacheKey, result);
    return result;
  }

  function withVia(result, id) {
    return result.module ? { ...result, via: [id, ...(result.via ?? [])] } : result;
  }

  /** Resolve an import binding `local` of module `id`. */
  function resolveImportBinding(id, local) {
    const entry = info.get(id);
    const found = entry.importSpecifiers.get(local);
    if (!found) return null;
    const { declaration, specifier } = found;
    if (isRuntime(entry.record, declaration.source)) return { runtime: true };
    const target = resolvedId(entry.record, declaration.source);
    if (!target) {
      return entry.record.resolved.get(declaration.source)?.external
        ? { runtime: true, external: true }
        : { unknown: true, reason: "unresolvedImport" };
    }
    if (specifier.imported === "*") return { module: target, namespace: true };
    return withVia(resolveExport(target, specifier.imported), target);
  }

  // -- typed identity cross-check ----------------------------------------------
  const identityMismatch = new Set();
  for (const [id, entry] of info) {
    const types = entry.record.types;
    if (!types) continue;
    for (const declaration of types.imports) {
      for (const specifier of declaration.specifiers) {
        const resolvedTyped = specifier.resolved;
        if (!resolvedTyped || resolvedTyped.external) continue;
        const linked = resolveImportBinding(id, specifier.local);
        if (!linked || linked.runtime || linked.namespace) continue;
        if (linked.unknown) {
          identityMismatch.add(id + "\0" + specifier.local);
          continue;
        }
        const target = modules.get(linked.module);
        const binding = info.get(linked.module)?.bindings.get(linked.binding);
        const sameFile = target && typedFileMatches(target, resolvedTyped.file, graph, root);
        const samePosition =
          !binding ||
          resolvedTyped.position == null ||
          binding.span.start === resolvedTyped.position;
        if (!sameFile || !samePosition) identityMismatch.add(id + "\0" + specifier.local);
      }
    }
  }

  // -- event-only proofs ----------------------------------------------------------
  const candidates = new Map();
  const blocksOut = [];
  const componentCache = new Map();

  function findComponent(id, tagName, seen) {
    const entry = info.get(id);
    if (!entry || !entry.record.behavior) return { fail: "componentModuleUnknown" };
    if (tagName.includes(".")) return { fail: "memberComponentTag" };
    const local = entry.record.behavior.components.find(component => component.name === tagName);
    if (local) return { module: id, component: local };
    const linked = resolveImportBinding(id, tagName);
    if (!linked) return { fail: "componentNotFound" };
    if (linked.runtime) return { fail: "runtimeComponent" };
    if (linked.unknown || linked.namespace)
      return { fail: `componentUnresolved:${linked.reason ?? "namespace"}` };
    const target = info.get(linked.module);
    const component = target?.record.behavior?.components.find(c => c.name === linked.binding);
    if (!component) return { fail: "componentNotSummarized" };
    return { module: linked.module, component };
  }

  /** Does prop `prop` of `tagName` (as used in module `id`) only reach DOM event sinks? */
  function propIsEventOnly(id, tagName, prop, seen) {
    const found = findComponent(id, tagName, seen);
    if (found.fail) return { ok: false, reason: found.fail };
    const key = `${found.module}\0${found.component.name}\0${prop}`;
    if (componentCache.has(key)) return componentCache.get(key);
    if (seen.has(key)) return { ok: false, reason: "forwardingCycle" };
    seen.add(key);
    const component = found.component;
    let result;
    if (component.props !== "identifier")
      result = { ok: false, reason: `props:${component.props}` };
    else if (component.propsEscapes.length)
      result = { ok: false, reason: `propsEscape:${component.propsEscapes.join(",")}` };
    else {
      const uses = component.propUses.find(use => use.name === prop)?.uses ?? [];
      if (!uses.length) result = { ok: false, reason: "propUnused" };
      else {
        const events = [];
        result = { ok: true, events };
        for (const use of uses) {
          if (use.startsWith("domEvent:")) events.push(use.slice(9));
          else if (use.startsWith("componentProp:")) {
            const [childTag, childProp] = splitComponentProp(use.slice(14));
            const nested = propIsEventOnly(found.module, childTag, childProp, seen);
            if (!nested.ok) {
              result = { ok: false, reason: `forward:${childTag}.${childProp}:${nested.reason}` };
              break;
            }
            events.push(...nested.events);
          } else {
            result = { ok: false, reason: `propUse:${use}` };
            break;
          }
        }
      }
      // Typed cross-check: the prop must be a branded block (EventBlock).
      const typed = info
        .get(found.module)
        .record.types?.components.find(c => c.name === component.name);
      const typedProp = typed?.props.find(p => p.name === prop);
      if (result.ok && typed && !typedProp?.brands.includes("block")) {
        result = { ok: false, reason: "propNotEventBlock" };
      }
    }
    componentCache.set(key, result);
    return result;
  }

  let importerIndex = null;
  /** Modules importing or re-exporting (id, bindingName), from a one-time index. */
  function exportImporters(id, bindingName) {
    if (!importerIndex) importerIndex = buildImporterIndex();
    return importerIndex.get(id + "\0" + bindingName) ?? [];
  }
  function buildImporterIndex() {
    const index = new Map();
    const push = (key, value) => {
      let list = index.get(key);
      if (!list) index.set(key, (list = []));
      list.push(value);
    };
    for (const [otherId, entry] of info) {
      if (!entry.record.behavior) continue;
      for (const binding of entry.record.behavior.bindings) {
        if (binding.kind !== "import") continue;
        const linked = resolveImportBinding(otherId, binding.name);
        if (!linked?.module) continue;
        if (linked.namespace) {
          for (const exported of info.get(linked.module)?.record.behavior?.exports ?? []) {
            const inner = exported.exported && resolveExport(linked.module, exported.exported);
            if (inner?.module && inner.binding)
              push(inner.module + "\0" + inner.binding, { id: otherId, binding, namespace: true });
          }
        } else if (linked.binding) {
          push(linked.module + "\0" + linked.binding, { id: otherId, binding });
        }
      }
      for (const exported of entry.record.behavior.exports) {
        if (exported.kind !== "reexport") continue;
        const target = resolvedId(entry.record, exported.source);
        if (!target) continue;
        const linked = resolveExport(target, exported.imported);
        if (linked.module && linked.binding)
          push(linked.module + "\0" + linked.binding, { id: otherId, reexport: true });
      }
    }
    return index;
  }

  /** Every site of a block value, proven event-only. */
  function sitesEventOnly(id, sites, seen, bindingName) {
    if (!sites.length) return { ok: false, reason: "noSites" };
    const events = [];
    for (const site of sites) {
      switch (site.kind) {
        case "domEvent":
          events.push(site.event);
          break;
        case "componentProp": {
          const proof = propIsEventOnly(id, site.component, site.prop, seen);
          if (!proof.ok)
            return { ok: false, reason: `forward:${site.component}.${site.prop}:${proof.reason}` };
          events.push(...proof.events);
          break;
        }
        case "exported": {
          if (entryIds.has(id)) return { ok: false, reason: "entryExport" };
          if (nonLiteralDynamicImport)
            return { ok: false, reason: `unknownImporter:${nonLiteralDynamicImport}` };
          const importers = exportImporters(id, bindingName);
          if (!importers.length) return { ok: false, reason: "exportedUnused" };
          for (const importer of importers) {
            if (importer.reexport || importer.namespace)
              return { ok: false, reason: "reexportedOrNamespace" };
            const proof = sitesEventOnly(importer.id, importer.binding.sites ?? [], seen, null);
            if (!proof.ok)
              return {
                ok: false,
                reason: `importer:${info.get(importer.id).record.rel}:${proof.reason}`
              };
            events.push(...proof.events);
          }
          break;
        }
        default:
          return { ok: false, reason: `site:${site.kind}${site.how ? ":" + site.how : ""}` };
      }
    }
    return { ok: true, events };
  }

  for (const [id, entry] of info) {
    const record = entry.record;
    if (record.kind !== "app" || !record.behavior) continue;
    record.behavior.blocks.forEach((block, index) => {
      const key = `${record.rel}#${block.id}`;
      const reasons = [];
      let unknown = false;
      const fail = (reason, isUnknown = false) => {
        reasons.push(reason);
        if (isUnknown) unknown = true;
      };
      if (entry.opaque) fail("moduleOpaque", true);
      if (
        record.behavior.serverFunctions > 0 ||
        record.behavior.directives.includes("use server")
      ) {
        fail("serverFunctionModule", true);
      }
      if (strict && record.typedStatus !== "ok") fail(`types:${record.typedStatus}`, true);
      const typed = record.types?.blocks[index];
      if (typed && typed.id === block.id && !typed.consistent)
        fail(`typeMismatch:${typed.mismatches.join(",")}`, true);
      const body = block.body;
      if (block.opaque || !body) fail("opaqueBody", true);
      // A block created inside another block's body (an inline handler in a
      // JSX block) is fine: its shell is created at the same point. Its
      // parent is never extracted with it (a body that creates blocks is
      // refused below).
      let snapshot = null;
      let prelude = [];
      if (body) {
        for (const [escape, value] of Object.entries(body.escapes))
          if (value) fail(`escape:${escape}`);
        for (const capture of body.captures) {
          if (capture.assigned || capture.mutatedElsewhere) fail(`mutableCapture:${capture.name}`);
          if (capture.scope === "import" && identityMismatch.has(id + "\0" + capture.name)) {
            fail(`identityMismatch:${capture.name}`, true);
          }
        }
        if (body.ops.plainYields.length || body.ops.throws.length) fail("invalidBlockBody");
        if (body.dynamicImports.some(entry => entry.source == null)) fail("dynamicImport", true);
        if (body.nestedBlocks) fail("createsBlocks");
        const event = body.event;
        if (body.input === "<pattern>") fail("eventPatternParam");
        if (!body.bodySpan) fail("expressionBody");
        if (event) {
          prelude = event.prelude.statements;
          const preludeCalls = prelude.filter(statement =>
            PRELUDE_KINDS.has(statement.kind)
          ).length;
          const propagationCalls =
            event.preventDefault + event.stopPropagation + event.stopImmediatePropagation;
          if (propagationCalls > preludeCalls || event.returnValue)
            fail("propagationOutsidePrelude");
          if (event.escapes.length) fail(`eventEscapes:${event.escapes.join(",")}`);
          if (event.methods.length) fail(`eventMethods:${event.methods.join(",")}`);
          if (event.members.includes("<computed>")) fail("eventComputedMember");
          const members = new Set(["type", ...event.members]);
          if (event.currentTarget) members.add("currentTarget");
          if (event.target) members.add("target");
          snapshot = [...members].sort();
          if (
            typed &&
            typed.inputIsEvent === false &&
            body.paramCount > 0 &&
            event &&
            (event.members.length || event.currentTarget || event.target)
          ) {
            fail("inputNotEvent", true);
          }
        }
      }
      const proof = sitesEventOnly(id, block.sites, new Set(), block.name);
      if (!proof.ok) fail(`notEventOnly:${proof.reason}`);
      const result = {
        key,
        module: id,
        rel: record.rel,
        index,
        block,
        typed: typed ?? null,
        events: proof.ok ? [...new Set(proof.events)].sort() : [],
        reasons,
        unknown,
        prelude,
        snapshot
      };
      blocksOut.push(result);
      if (!reasons.length) candidates.set(key, result);
    });
  }

  // -- graph edges -------------------------------------------------------------------
  const bits = new Map();
  const node = (id, name) => (name == null ? `E\0${id}` : `B\0${id}\0${name}`);
  const parseNode = key => {
    const parts = key.split("\0");
    return parts[0] === "E" ? { id: parts[1] } : { id: parts[1], name: parts[2] };
  };
  const lazyRoots = new Set();
  const retained = new Set();
  let demoted = new Set();

  /** Uses of module-scope names inside extracted bodies, per containing statement (-1: top level). */
  function coldUsesByStatement(id) {
    const entry = info.get(id);
    const uses = new Map();
    for (const candidate of candidates.values()) {
      if (candidate.module !== id) continue;
      const statement = containingStatement(entry, candidate.block.span);
      const index = statement ? statement.index : -1;
      let map = uses.get(index);
      if (!map) uses.set(index, (map = new Map()));
      for (const capture of candidate.block.body.captures) {
        if (capture.scope !== "module" && capture.scope !== "import") continue;
        map.set(capture.name, (map.get(capture.name) ?? 0) + capture.uses);
      }
    }
    return uses;
  }

  function containingStatement(entry, span) {
    for (const statement of entry.statements.values())
      if (within(span, statement.span)) return statement;
    return null;
  }

  function propagate() {
    bits.clear();
    lazyRoots.clear();
    // Phase A runs HOT/UNKNOWN to completion from the hot roots; phase B then
    // runs COLD from the extracted bodies. A module already evaluated hot does
    // not pass COLD on through its evaluation edges (its effectful statements
    // and effectful dependencies run hot; cold code does not reference them),
    // so COLD only marks what cold code actually references.
    let phaseB = false;
    const hotEvaluated = new Set();
    const coldUses = new Map();
    for (const id of info.keys()) coldUses.set(id, coldUsesByStatement(id));
    const queue = [];
    const add = (key, value) => {
      const previous = bits.get(key) ?? 0;
      const next = previous | value;
      if (next !== previous) {
        bits.set(key, next);
        queue.push([key, next & ~previous]);
      }
    };
    const addExports = (target, value) => {
      // A dynamic import hands out the whole namespace.
      for (const exported of info.get(target)?.record.behavior?.exports ?? []) {
        if (!exported.exported) continue;
        const inner = resolveExport(target, exported.exported);
        if (inner.module && inner.binding) add(node(inner.module, inner.binding), value);
        for (const via of inner.via ?? []) add(node(via), value);
      }
    };
    // Roots.
    for (const id of graph.entries) {
      add(node(id), HOT);
      const entry = info.get(id);
      for (const exported of entry?.record.behavior?.exports ?? []) {
        if (exported.kind === "local" && exported.local) add(node(id, exported.local), HOT);
      }
    }
    for (const [id, entry] of info) {
      if (entry.record.kind === "runtime") continue;
      if (entry.opaque) add(node(id), UNKNOWN);
      if (nonLiteralDynamicImport && entry.record.behavior) {
        for (const exported of entry.record.behavior.exports) {
          if (exported.kind === "local" && exported.local) add(node(id, exported.local), UNKNOWN);
        }
      }
    }
    for (const key of retained) add(key, HOT);
    for (const [id, entry] of info) {
      for (const binding of entry.bindings.values()) {
        if (binding.kind === "import" && identityMismatch.has(id + "\0" + binding.name))
          add(node(id, binding.name), UNKNOWN);
      }
    }
    const seedCold = () => {
      for (const candidate of candidates.values()) {
        for (const capture of candidate.block.body.captures) {
          if (capture.scope === "module" || capture.scope === "import")
            add(node(candidate.module, capture.name), COLD);
        }
        for (const dynamic of candidate.block.body.dynamicImports) {
          const target =
            dynamic.source && resolvedId(info.get(candidate.module).record, dynamic.source);
          if (target) {
            add(node(target), COLD);
            addExports(target, COLD);
          }
        }
      }
    };

    const statementRefs = (id, statement, value) => {
      const entry = info.get(id);
      const uses = coldUses.get(id).get(statement ? statement.index : -1);
      const refs = statement ? statement.refs : topLevelRefs(entry);
      for (const [name, count] of refs) {
        if (!entry.bindings.has(name)) continue;
        const hotCount = value & UNKNOWN ? count : count - (uses?.get(name) ?? 0);
        // HOT/UNKNOWN only along references outside extracted bodies; COLD
        // along every reference (a cold statement runs whole).
        const carried = (value & COLD) | (hotCount > 0 ? value & (HOT | UNKNOWN) : 0);
        if (carried) add(node(id, name), carried);
      }
      const owner = statement ? statement.bindings : [null];
      for (const dynamic of entry.record.behavior.dynamicImports) {
        if (!owner.includes(dynamic.owner) || !dynamic.source) continue;
        if (insideCandidate(id, dynamic.span)) continue;
        const target = resolvedId(entry.record, dynamic.source);
        if (target) {
          if (value & HOT) lazyRoots.add(target);
          add(node(target), value);
          addExports(target, value);
        }
      }
    };

    const drain = () => {
      while (queue.length) {
        const [key, value] = queue.shift();
        const { id, name } = parseNode(key);
        const entry = info.get(id);
        if (!entry) continue;
        const record = entry.record;
        if (name == null) {
          // Module evaluation.
          if (!record.behavior) continue;
          if (!phaseB) hotEvaluated.add(id);
          const evaluationValue = phaseB && hotEvaluated.has(id) ? value & ~COLD : value;
          if (!evaluationValue) continue;
          for (const statement of entry.statements.values()) {
            if (statement.effects || evaluationValue & UNKNOWN) {
              for (const binding of statement.bindings) add(node(id, binding), evaluationValue);
            }
          }
          statementRefs(id, null, evaluationValue);
          for (const declaration of record.behavior.imports) {
            if (declaration.kind === "type") continue;
            const target = resolvedId(record, declaration.source);
            if (!target) continue;
            const targetInfo = info.get(target);
            if (
              !declaration.specifiers.length ||
              targetInfo?.effectful ||
              evaluationValue & UNKNOWN
            ) {
              add(node(target), evaluationValue);
            }
          }
          for (const exported of record.behavior.exports) {
            if (!exported.source) continue;
            const target = resolvedId(record, exported.source);
            if (target && (info.get(target)?.effectful || evaluationValue & UNKNOWN))
              add(node(target), evaluationValue);
          }
          continue;
        }
        add(node(id), value);
        const binding = entry.bindings.get(name);
        if (!binding) {
          // An anonymous default export or a missing binding: evaluate the module.
          continue;
        }
        if (binding.kind === "import") {
          const linked = resolveImportBinding(id, name);
          if (!linked || linked.runtime) continue;
          if (linked.unknown) continue;
          for (const via of linked.via ?? []) add(node(via), value);
          if (linked.namespace) {
            add(node(linked.module), value);
            addExports(linked.module, value);
            continue;
          }
          add(node(linked.module, linked.binding), value);
          continue;
        }
        const statement = entry.statements.get(binding.statement);
        if (statement) statementRefs(id, statement, value);
      }
    };
    drain();
    phaseB = true;
    seedCold();
    drain();
  }

  function topLevelRefs(entry) {
    const refs = new Map();
    for (const ref of entry.record.behavior.topLevel.refs) refs.set(ref.name, ref.count);
    return refs;
  }

  function insideCandidate(id, span) {
    for (const candidate of candidates.values()) {
      if (candidate.module === id && within(span, candidate.block.span)) return true;
    }
    return false;
  }

  const labelOf = (id, name) => bits.get(node(id, name)) ?? 0;
  const evaluatedHot = id => (labelOf(id) & (HOT | UNKNOWN)) !== 0;

  // -- fixed point -------------------------------------------------------------------------
  let iterations = 0;
  let moved = new Map();
  for (;;) {
    iterations++;
    propagate();
    let changed = false;
    // A candidate whose shell would not be in hot code (its statement is not
    // hot-evaluated) is not extracted.
    for (const [key, candidate] of candidates) {
      const entry = info.get(candidate.module);
      const statement = containingStatement(entry, candidate.block.span);
      const hot = statement
        ? statement.bindings.some(name => labelOf(candidate.module, name) & (HOT | UNKNOWN))
        : evaluatedHot(candidate.module);
      if (!hot) {
        candidates.delete(key);
        candidate.reasons.push("shellNotHot");
        changed = true;
      }
    }
    if (changed) continue;
    moved = new Map();
    for (const [id, entry] of info) {
      if (
        entry.record.kind !== "app" ||
        !entry.record.behavior ||
        !evaluatedHot(id) ||
        entry.opaque
      )
        continue;
      for (const statement of entry.statements.values()) {
        const labels = statement.bindings.map(name => labelOf(id, name));
        if (!labels.some(label => label === COLD)) continue;
        const pin = pinReason(id, entry, statement, labels);
        if (pin) {
          for (const name of statement.bindings) {
            if (labelOf(id, name) === COLD) {
              retained.add(node(id, name));
              changed = true;
            }
          }
          entry.pins ??= new Map();
          for (const name of statement.bindings) entry.pins.set(name, pin);
          continue;
        }
        let list = moved.get(id);
        if (!list) moved.set(id, (list = []));
        list.push(statement);
      }
    }
    if (!changed) break;
  }

  function pinReason(id, entry, statement, labels) {
    if (labels.some(label => label !== COLD)) return "statementShared";
    const text = entry.record.text.slice(statement.span.start, statement.span.end);
    if (/^export\s+default\b/.test(text)) return "defaultExport";
    if (statement.effects) return "effects";
    if (entry.pinnedStatements.has(statement.index)) return "importMeta";
    for (const name of statement.bindings) {
      const binding = entry.bindings.get(name);
      if (binding.action) return "action";
      if (binding.kind === "import") return "import";
      if (binding.exported) {
        for (const importer of exportImporters(id, name)) {
          if (importer.reexport) return "reexported";
          if (importer.namespace) return "namespaceImported";
          if (!evaluatedHot(importer.id)) return `coldImporter:${info.get(importer.id).record.rel}`;
          if (labelOf(importer.id, importer.binding.name) !== COLD) return "hotImporter";
        }
      }
    }
    for (const candidate of candidates.values()) {
      if (candidate.module === id && within(candidate.block.span, statement.span))
        return "containsShell";
    }
    return null;
  }

  // -- clustering -----------------------------------------------------------------------------
  const staticRoots = computeRoots(graph, info, lazyRoots, resolvedId);
  const domains = cluster({
    candidates,
    info,
    moved,
    labelOf,
    staticRoots,
    resolveImportBinding,
    maxDomainBytes,
    modules
  });

  // -- results ------------------------------------------------------------------------------------
  const moduleClasses = [];
  for (const [id, entry] of info) {
    const record = entry.record;
    const evaluation = labelOf(id);
    const cls = record.kind === "runtime" ? "hot" : entry.opaque ? "unknown" : classOf(evaluation);
    moduleClasses.push({
      id,
      module: record.rel,
      kind: record.kind,
      status: record.status,
      typedStatus: record.typedStatus,
      class: cls,
      roots: [...(staticRoots.get(id) ?? [])].map(rootId => modules.get(rootId).rel).sort(),
      residue: (moved.get(id) ?? []).flatMap(statement => statement.bindings).sort()
    });
  }
  moduleClasses.sort((a, b) => (a.module < b.module ? -1 : 1));

  const bindingClasses = [];
  for (const [id, entry] of info) {
    if (entry.record.kind !== "app") continue;
    for (const name of entry.bindings.keys()) {
      const label = labelOf(id, name);
      const cls = classOf(label);
      if (cls === "hot") continue;
      bindingClasses.push({
        module: entry.record.rel,
        name,
        class: cls,
        moved: (moved.get(id) ?? []).some(statement => statement.bindings.includes(name)),
        pin: entry.pins?.get(name) ?? null
      });
    }
  }
  bindingClasses.sort((a, b) =>
    a.module === b.module ? (a.name < b.name ? -1 : 1) : a.module < b.module ? -1 : 1
  );

  const domainOf = new Map();
  for (const domain of domains) for (const key of domain.blocks) domainOf.set(key, domain.id);
  const blocks = blocksOut
    .map(result => ({
      key: result.key,
      module: result.rel,
      id: result.block.id,
      name: result.block.name,
      owner: result.block.owner,
      class: candidates.has(result.key) ? "cold" : result.unknown ? "unknown" : "hot",
      reasons: result.reasons,
      events: result.events,
      domain: domainOf.get(result.key) ?? null,
      prelude: result.prelude.map(statement => statement.kind),
      snapshot: candidates.has(result.key) ? result.snapshot : null
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  return {
    environment,
    graph,
    info,
    candidates,
    moved,
    domains,
    labelOf,
    resolveImportBinding,
    resolveExport,
    evaluatedHot,
    modules: moduleClasses,
    bindings: bindingClasses,
    blocks,
    nonLiteralDynamicImport,
    iterations,
    lazyRoots: [...lazyRoots].map(id => modules.get(id).rel).sort(),
    time: performance.now() - started
  };
}

function typedFileMatches(target, typedFile, graph, root) {
  if (!typedFile) return false;
  if (target.rel === typedFile) return true;
  // Typed paths are relative to the solid-tsc root; compare by suffix.
  return target.rel.endsWith("/" + typedFile) || typedFile.endsWith("/" + target.rel);
}

function splitComponentProp(text) {
  const dot = text.lastIndexOf(".");
  return [text.slice(0, dot), text.slice(dot + 1)];
}

/** For every module, the hot roots (entries, lazy targets) whose static graph contains it. */
function computeRoots(graph, info, lazyRoots, resolvedId) {
  const roots = new Map();
  for (const rootId of [...graph.entries, ...lazyRoots]) {
    const stack = [rootId];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      let set = roots.get(id);
      if (!set) roots.set(id, (set = new Set()));
      set.add(rootId);
      const record = info.get(id)?.record;
      if (!record?.behavior) continue;
      for (const declaration of record.behavior.imports) {
        const target = resolvedId(record, declaration.source);
        if (target) stack.push(target);
      }
      for (const exported of record.behavior.exports) {
        const target = exported.source && resolvedId(record, exported.source);
        if (target) stack.push(target);
      }
    }
  }
  return roots;
}

/**
 * Interaction domains. Blocks are seeded per owning component (a component's
 * handlers are one interaction surface), grouped by the set of hot roots
 * rendering them (a route's cold code never loads with another route's),
 * merged when they share a cold dependency (so a cold helper is not split
 * across chunks), then packed in path order up to `maxDomainBytes` so small
 * surfaces share a chunk instead of producing one chunk per handler.
 */
function cluster({
  candidates,
  info,
  moved,
  labelOf,
  staticRoots,
  resolveImportBinding,
  maxDomainBytes,
  modules
}) {
  const groups = new Map();
  const parent = new Map();
  const find = key => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const seeds = new Map();
  const depOwner = new Map();
  for (const candidate of candidates.values()) {
    const record = modules.get(candidate.module);
    const rootKey = [...(staticRoots.get(candidate.module) ?? [])]
      .map(id => modules.get(id).rel)
      .sort()
      .join("|");
    const seed = `${rootKey}::${record.rel}::${candidate.block.owner ?? "<module>"}`;
    if (!parent.has(seed)) parent.set(seed, seed);
    seeds.set(candidate.key, seed);
    // Cold dependencies: moved bindings and cold-only modules reached from captures.
    for (const dep of coldDependencies(candidate, info, moved, labelOf, resolveImportBinding)) {
      const scoped = `${rootKey}::${dep}`;
      if (depOwner.has(scoped)) union(depOwner.get(scoped), seed);
      else depOwner.set(scoped, seed);
    }
  }
  for (const candidate of candidates.values()) {
    const seed = find(seeds.get(candidate.key));
    let group = groups.get(seed);
    if (!group)
      groups.set(seed, (group = { seed, rootKey: seed.split("::")[0], blocks: [], bytes: 0 }));
    group.blocks.push(candidate.key);
    const span = candidate.block.body.span;
    group.bytes += span.end - span.start;
  }
  const byRoot = new Map();
  for (const group of [...groups.values()].sort((a, b) => (a.seed < b.seed ? -1 : 1))) {
    let list = byRoot.get(group.rootKey);
    if (!list) byRoot.set(group.rootKey, (list = []));
    list.push(group);
  }
  const domains = [];
  for (const [rootKey, list] of [...byRoot].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let current = null;
    for (const group of list) {
      if (!current || current.bytes + group.bytes > maxDomainBytes) {
        current = { rootKey, blocks: [], bytes: 0 };
        domains.push(current);
      }
      current.blocks.push(...group.blocks);
      current.bytes += group.bytes;
    }
  }
  return domains.map(domain => {
    domain.blocks.sort();
    const id = "d" + sourceHash(domain.blocks.join("\n")).slice(7, 15);
    return {
      id,
      roots: domain.rootKey ? domain.rootKey.split("|") : [],
      blocks: domain.blocks,
      bytes: domain.bytes
    };
  });
}

function coldDependencies(candidate, info, moved, labelOf, resolveImportBinding) {
  const deps = [];
  for (const capture of candidate.block.body.captures) {
    if (capture.scope === "module") {
      if (
        (moved.get(candidate.module) ?? []).some(statement =>
          statement.bindings.includes(capture.name)
        )
      ) {
        deps.push(`${candidate.module}#${capture.name}`);
      }
    } else if (capture.scope === "import") {
      const linked = resolveImportBinding(candidate.module, capture.name);
      if (linked?.module && (labelOf(linked.module) & 1) === 0) deps.push(linked.module);
      else if (linked?.module && linked.binding && labelOf(linked.module, linked.binding) === 2) {
        deps.push(`${linked.module}#${linked.binding}`);
      }
    }
  }
  return deps;
}

export { path };
