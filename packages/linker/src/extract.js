// Cold event-domain extraction (slice 3): turn an analysis into module
// rewrites.
//
// For each hot module with extracted blocks:
//
//   const submit = $(function* (e) { e.preventDefault(); …rest… });
//
// becomes a hot shell created at the same place (same owner, same error
// boundary):
//
//   const submit = __solid_coldEvent(__solid_cold_dX, "k…", () => [a, b],
//     e => { e.preventDefault(); }, ["currentTarget", "key", "type"]);
//
// and the body moves to a cold block module (same directory, so relative
// imports resolve unchanged):
//
//   import { $ as __solid_$ } from "solid-js";
//   import { validate } from "./validate";
//   export default __solid_env => __solid_$(function* (e) {
//     const [a, b] = __solid_env(); …rest…
//   });
//
// Cold-only module-level statements move to a per-module residue module;
// import specifiers used only by extracted code are dropped from the hot
// module (the declaration stays as a bare import when its target has
// effects or is unknown). Each domain is a virtual module re-exporting its
// blocks' factories, emitted as one chunk. Every generated module carries a
// hires source map back to the authored file.
import path from "node:path";
import MagicString from "magic-string";
import { sourceHash } from "./load.js";

export const DOMAIN_PREFIX = "virtual:solid-cold-domain/";
export const DOMAIN_ID_PREFIX = "\0solid-cold-domain:";
const RUNTIME_SOURCES = ["solid-js", "@solidjs/signals"];

function blockModuleId(moduleId, blockId) {
  const ext = path.extname(moduleId);
  return moduleId.slice(0, -ext.length) + `__solid_cold_${blockId}` + ext;
}

function residueModuleId(moduleId) {
  const ext = path.extname(moduleId);
  return moduleId.slice(0, -ext.length) + "__solid_residue" + ext;
}

export function blockExportKey(key) {
  return "k" + sourceHash(key).slice(7, 17);
}

function specifierText(imported, local) {
  if (imported === "default") return { default: local };
  if (imported === "*") return { namespace: local };
  return { named: imported === local ? local : `${imported} as ${local}` };
}

function importLines(entries) {
  // entries: [{ source, imported, local }]
  const bySource = new Map();
  for (const entry of entries) {
    let list = bySource.get(entry.source);
    if (!list) bySource.set(entry.source, (list = []));
    if (!list.some(item => item.local === entry.local)) list.push(entry);
  }
  const lines = [];
  for (const [source, list] of bySource) {
    const named = [];
    const clauses = [];
    for (const entry of list) {
      const spec = specifierText(entry.imported, entry.local);
      if (spec.default) clauses.push(spec.default);
      else if (spec.namespace)
        lines.push(`import * as ${spec.namespace} from ${JSON.stringify(source)};`);
      else named.push(spec.named);
    }
    if (named.length) clauses.push(`{ ${named.join(", ")} }`);
    if (clauses.length) lines.push(`import ${clauses.join(", ")} from ${JSON.stringify(source)};`);
  }
  return lines;
}

/**
 * Build the extraction plan: `{ hot: Map<id, HotPlan>, virtual: Map<id,
 * {code, map}>, domains, chunkOf(id) }`.
 */
export function planExtraction(
  analysis,
  { prefetch = "idle", runtimeModule = "@solidjs/linker/runtime", domainDir = null } = {}
) {
  const { info, candidates, moved, domains, labelOf, resolveImportBinding, evaluatedHot } =
    analysis;
  const virtual = new Map();
  const hot = new Map();
  const chunkOf = new Map();
  const domainOfBlock = new Map();
  for (const domain of domains) for (const key of domain.blocks) domainOfBlock.set(key, domain);

  const movedNames = id => new Set((moved.get(id) ?? []).flatMap(statement => statement.bindings));

  /**
   * How generated code imports an import binding `local` of module `id`:
   * from its original source, or from the residue module when the declaring
   * binding moved there.
   */
  function importFor(id, local) {
    const entry = info.get(id);
    const found = entry.importSpecifiers.get(local);
    const linked = resolveImportBinding(id, local);
    if (linked?.module && linked.binding && movedNames(linked.module).has(linked.binding)) {
      return { source: residueModuleId(linked.module), imported: linked.binding, local };
    }
    return { source: found.declaration.source, imported: found.specifier.imported, local };
  }

  const hotPlan = id => {
    let plan = hot.get(id);
    if (!plan) {
      plan = {
        id,
        blocks: [],
        domains: new Set(),
        residue: moved.get(id) ?? [],
        residueExports: new Set()
      };
      hot.set(id, plan);
    }
    return plan;
  };

  // Cold block modules.
  for (const candidate of candidates.values()) {
    const { module: id, block } = candidate;
    const record = info.get(id).record;
    const domain = domainOfBlock.get(candidate.key);
    const exportKey = blockExportKey(candidate.key);
    const blockId = blockModuleId(id, block.id);
    const movedHere = movedNames(id);
    const env = [];
    const imports = [];
    for (const capture of block.body.captures) {
      if (capture.scope === "global") continue;
      if (capture.scope === "import") imports.push(importFor(id, capture.name));
      else if (capture.scope === "module" && movedHere.has(capture.name)) {
        imports.push({ source: residueModuleId(id), imported: capture.name, local: capture.name });
      } else env.push(capture.name);
    }
    const header = [
      `import { $ as __solid_$ } from ${JSON.stringify(runtimeSourceOf(record))};`,
      ...importLines(
        imports.map(entry => ({ ...entry, source: relativeSource(blockId, entry.source) }))
      )
    ].join("\n");
    const text = record.text;
    const ms = new MagicString(text);
    const fn = block.body.span;
    if (fn.start > 0) ms.remove(0, fn.start);
    if (fn.end < text.length) ms.remove(fn.end, text.length);
    for (const statement of candidate.prelude) ms.remove(statement.span.start, statement.span.end);
    if (env.length)
      ms.appendLeft(block.body.bodySpan.start + 1, ` const [${env.join(", ")}] = __solid_env();`);
    ms.prepend(`${header}\nexport default (__solid_env) => __solid_$(`);
    ms.append(");\n");
    virtual.set(blockId, {
      code: ms.toString(),
      map: ms.generateMap({ source: record.id, includeContent: true, hires: true }),
      kind: "block",
      domain: domain.id
    });
    chunkOf.set(blockId, domain.id);
    const plan = hotPlan(id);
    plan.domains.add(domain.id);
    plan.blocks.push({ candidate, exportKey, env, domain: domain.id });
  }

  // Residue modules.
  for (const [id, statements] of moved) {
    const record = info.get(id).record;
    const entry = info.get(id);
    const residueId = residueModuleId(id);
    const movedHere = movedNames(id);
    const refs = new Set();
    for (const statement of statements) for (const name of statement.refs.keys()) refs.add(name);
    const imports = [];
    const plan = hotPlan(id);
    for (const name of refs) {
      if (movedHere.has(name) || !entry.bindings.has(name)) continue;
      const binding = entry.bindings.get(name);
      if (binding.kind === "import") imports.push(importFor(id, name));
      else {
        plan.residueExports.add(name);
        imports.push({ source: id, imported: `__solid_residue_${name}`, local: name });
      }
    }
    const text = record.text;
    const ms = new MagicString(text);
    const kept = [...statements].sort((a, b) => a.span.start - b.span.start);
    let cursor = 0;
    for (const statement of kept) {
      if (statement.span.start > cursor) ms.remove(cursor, statement.span.start);
      cursor = statement.span.end;
    }
    if (cursor < text.length) ms.remove(cursor, text.length);
    const exported = [];
    for (const statement of kept) {
      const statementText = text.slice(statement.span.start, statement.span.end);
      if (!/^export\b/.test(statementText)) exported.push(...statement.bindings);
      ms.appendLeft(statement.span.end, "\n");
    }
    ms.prepend(
      importLines(
        imports.map(entry => ({ ...entry, source: relativeSource(residueId, entry.source) }))
      ).join("\n") + "\n"
    );
    if (exported.length) ms.append(`export { ${exported.join(", ")} };\n`);
    virtual.set(residueId, {
      code: ms.toString(),
      map: ms.generateMap({ source: record.id, includeContent: true, hires: true }),
      kind: "residue"
    });
  }

  // Domain modules.
  const domainIds = new Map();
  const domainOfId = new Map();
  for (const domain of domains) {
    const lines = domain.blocks.map(key => {
      const candidate = candidates.get(key);
      return `export { default as ${blockExportKey(key)} } from ${JSON.stringify(blockModuleId(candidate.module, candidate.block.id))};`;
    });
    const id = domainDir
      ? path.join(domainDir, `cold-${domain.id}.js`)
      : DOMAIN_ID_PREFIX + domain.id;
    virtual.set(id, {
      code: lines.join("\n") + "\n",
      map: null,
      kind: "domain",
      domain: domain.id
    });
    chunkOf.set(id, domain.id);
    domainIds.set(domain.id, id);
    domainOfId.set(id, domain.id);
  }

  // Hot module rewrites.
  for (const plan of hot.values()) {
    plan.transform = code =>
      transformHot(plan, code, { info, labelOf, evaluatedHot, prefetch, runtimeModule });
  }

  return { hot, virtual, chunkOf, domains, domainIds, domainOfId };
}

function runtimeSourceOf(record) {
  for (const declaration of record.behavior.imports) {
    if (RUNTIME_SOURCES.includes(declaration.source)) return declaration.source;
  }
  return "solid-js";
}

/** Specifier from a generated module to `source` (absolute ids become relative). */
function relativeSource(fromId, source) {
  if (!path.isAbsolute(source)) return source;
  let relativePath = path.relative(path.dirname(fromId), source).split(path.sep).join("/");
  if (!relativePath.startsWith(".")) relativePath = "./" + relativePath;
  return relativePath;
}

function transformHot(plan, code, { info, labelOf, prefetch, runtimeModule }) {
  const entry = info.get(plan.id);
  const record = entry.record;
  if (code !== record.text) {
    // Something rewrote the module before this plugin: the analysis no
    // longer describes it. Leave it untouched (the blocks stay hot).
    return null;
  }
  const ms = new MagicString(code);
  const HOT_OR_UNKNOWN = 1 | 4;

  // Imports: drop specifiers only extracted/moved code used.
  let insertAt = 0;
  for (const declaration of record.behavior.imports) {
    insertAt = Math.max(insertAt, declaration.span.end);
    if (declaration.kind === "type" || !declaration.specifiers.length) continue;
    const kept = [];
    let dropped = false;
    for (const specifier of declaration.specifiers) {
      const label = labelOf(plan.id, specifier.local);
      if (specifier.type || !specifier.used || label & HOT_OR_UNKNOWN || label === 0)
        kept.push(specifier);
      else dropped = true;
    }
    if (!dropped) continue;
    const target = record.resolved.get(declaration.source);
    const targetInfo = target?.id ? info.get(target.id) : null;
    const keepEvaluation =
      !targetInfo || targetInfo.effectful || targetInfo.opaque || labelOf(target.id) & 4;
    let replacement;
    if (kept.length) {
      replacement = importLines(
        kept.map(specifier => ({
          source: declaration.source,
          imported: specifier.imported,
          local: specifier.local
        }))
      ).join("\n");
      const types = kept.filter(specifier => specifier.type);
      if (types.length) {
        // Re-emit type-only specifiers verbatim as a separate type import.
        replacement = importLines(
          kept
            .filter(specifier => !specifier.type)
            .map(specifier => ({
              source: declaration.source,
              imported: specifier.imported,
              local: specifier.local
            }))
        ).join("\n");
        replacement += `\nimport type { ${types.map(t => (t.imported === t.local ? t.local : `${t.imported} as ${t.local}`)).join(", ")} } from ${JSON.stringify(declaration.source)};`;
      }
    } else {
      replacement = keepEvaluation ? `import ${JSON.stringify(declaration.source)};` : "";
    }
    ms.overwrite(
      declaration.span.start,
      declaration.span.end,
      replacement || "/* cold-only import extracted */"
    );
  }

  // Shells.
  for (const { candidate, exportKey, env, domain } of plan.blocks) {
    const body = candidate.block.body;
    const param = body.input ?? "__solid_event";
    let prelude = "null";
    if (candidate.prelude.length) {
      const statements = candidate.prelude.map(statement => {
        const text = code.slice(statement.span.start, statement.span.end);
        return statement.kind === "guardReturn"
          ? text.replace(/\breturn\s*;?/, "return false;")
          : text;
      });
      prelude = `(${param}) => { ${statements.join(" ")} }`;
    }
    const snapshot =
      body.paramCount > 0 && candidate.snapshot ? JSON.stringify(candidate.snapshot) : "null";
    ms.overwrite(
      candidate.block.span.start,
      candidate.block.span.end,
      `__solid_coldEvent(__solid_cold_${domain}, ${JSON.stringify(exportKey)}, () => [${env.join(", ")}], ${prelude}, ${snapshot})`
    );
  }

  // Residue statements leave the hot module.
  for (const statement of plan.residue) ms.remove(statement.span.start, statement.span.end);

  const domainLines = [...plan.domains]
    .sort()
    .map(
      domain =>
        `const __solid_cold_${domain} = __solid_coldDomain(${JSON.stringify(domain)}, () => import(${JSON.stringify(DOMAIN_PREFIX + domain)}), ${JSON.stringify({ prefetch })});`
    );
  const header = [];
  if (plan.blocks.length) {
    header.push(
      `import { coldEvent as __solid_coldEvent, coldDomain as __solid_coldDomain } from ${JSON.stringify(runtimeModule)};`,
      ...domainLines
    );
  }
  if (header.length) {
    if (insertAt > 0) ms.appendLeft(insertAt, "\n" + header.join("\n"));
    else ms.prepend(header.join("\n") + "\n");
  }
  if (plan.residueExports.size) {
    ms.append(
      `\nexport { ${[...plan.residueExports].map(name => `${name} as __solid_residue_${name}`).join(", ")} };\n`
    );
  }
  return {
    code: ms.toString(),
    map: ms.generateMap({ source: record.id, includeContent: true, hires: true })
  };
}
