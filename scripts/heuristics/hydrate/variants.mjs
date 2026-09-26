// Cold-scope hydration oracles: hand edits of the real compiler's hydratable
// DOM output for app.jsx (`node scripts/heuristics/hydrate/bench.mjs
// --print-baseline` shows it). Each edit is what a compiler holding the fact
// "this binding's sources are never written on the client except from event
// handlers / actions that the program does not contain" would emit: the node
// is still claimed (getNextElement / firstChild walk), but no render effect,
// no insert and no memo is created for the binding. The value is already in
// the server HTML.
//
//   baseline      compiler output, verbatim.
//   inert-labels  the label cell's insert (scope effect over label()) is not
//                 created; the label signal itself is still created (making it
//                 a constant is H4, priced separately). id insert and the
//                 selected-class effect stay.
//   inert-all     only the selection binding (isSel memo + class effect) is
//                 created: the label insert and the constant id insert go.
//   inert-all+H4  inert-all, and the never-written label signal is not
//                 created at all (it is a constant: H4 in the main study).
//   floor         each row only claims its <tr>: no signal, memo, effect or
//                 insert. Lower bound; it cannot select (fails the op gate by
//                 design, which also shows the gate catches a broken variant).
//   broken-noid   gate self-test (never timed): inert-labels without the
//                 hydration-id bump; must fail the gate.
//   gather-only   probe, not a candidate: App claims the <table> but not the
//                 rows (no list insert, no Row calls). Prices hydrate() setup,
//                 gatherHydratable's _hk scan and the root render only.
//
// Edits are exact (whitespace-insensitive) replacements that must each match
// once, so a compiler output change fails loudly instead of silently.

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function edit(code, from, to) {
  const re = new RegExp(esc(from.trim()).replace(/\s+/g, "\\s*"), "g");
  const n = (code.match(re) || []).length;
  if (n !== 1) throw new Error(`variant edit matched ${n} times:\n${from}`);
  return code.replace(re, () => to);
}

const LABEL_INSERT = `_$insert(_el$3, _$scope(() => {
			return label();
		}));`;
const ID_INSERT = `_$insert(_el$2, id);`;
const EL3 = `var _el$3 = _el$2.nextSibling;`;
const EL2 = `var _el$2 = _el$.firstChild;`;
const MEMO = `const isSel = createMemo(() => selected() === id);`;
const SIGNAL = `const [label, setLabel] = createSignal("row " + id);
		setters[id] = setLabel;`;
const CLASS_EFFECT = `_$effect(() => _$readShallow(isSel() ? "danger" : ""), (_v$, _$p) => {
			_$className(_el$, _v$, _$p);
		});`;
const LIST_INSERT = `_$insert(_el$5, _$scope(() => {
			return ids.map((i) => _$createComponent(Row, { id: i }));
		}));`;

// Hydration-id parity: every owned node (memo, the label's scope effect)
// consumes one child id of the current owner, and SSR allocated the same ids
// for its holes. An inert binding that owned a node must still consume its id,
// or every later getNextElement key in the row list misses (the gate catches
// this: the template is cloned and effects bind to a detached copy). A compiler
// applying the fact to both outputs could drop the id on both sides instead;
// here the client-only edit keeps the server HTML fixed and bumps the counter.
const IDS = `import { getNextChildId as _$nextId, getOwner as _$getOwner } from "solid-js";\n`;
const SKIP = "_$nextId(_$getOwner());";

export function hydrateVariants(compiled) {
  const baseline = compiled;
  const inertLabels = [
    [LABEL_INSERT, `${SKIP} /* inert: label text claimed from SSR */`],
    [EL3, ""]
  ].reduce((c, [f, t]) => edit(c, f, t), IDS + baseline);
  const inertAll = [
    [ID_INSERT, "/* inert: id text claimed from SSR */"],
    [EL2, ""]
  ].reduce((c, [f, t]) => edit(c, f, t), inertLabels);
  // The same fact also makes the label signal a constant (H4): drop it.
  const inertAllConst = edit(inertAll, SIGNAL, "");
  const floor = [
    [SIGNAL, ""],
    [MEMO, SKIP],
    [CLASS_EFFECT, "/* inert: class claimed from SSR */"]
  ].reduce((c, [f, t]) => edit(c, f, t), inertAll);
  // Gate self-test: inert-labels without the id bump. Must FAIL the gate.
  const brokenNoId = edit(inertLabels, SKIP, "");
  const gatherOnly = edit(baseline, LIST_INSERT, "/* probe: rows left unclaimed */");
  return {
    baseline: { source: baseline, ops: true },
    "inert-labels": { source: inertLabels, ops: true },
    "inert-all": { source: inertAll, ops: true },
    "inert-all+H4": { source: inertAllConst, ops: true },
    floor: { source: floor, ops: false },
    "gather-only": { source: gatherOnly, ops: false },
    "broken-noid": { source: brokenNoId, ops: true, expectFail: true }
  };
}
