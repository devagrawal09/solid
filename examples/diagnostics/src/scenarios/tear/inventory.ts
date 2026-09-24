/**
 * Scenario 1, file A — the state module.
 *
 * Both exports below type-check, pass review, and produce the right final
 * values. Only one of them is correct *per frame*, and nothing in this file
 * says which: the defect lives in the relationship between the effect here
 * and the reader in `ResultsPanel.tsx`. A compiler cannot see it — it is a
 * property of the runtime graph, not of either file's syntax.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { nodeName } from "../../diagnostics/channel";

export interface Part {
  sku: string;
  name: string;
  bin: string;
}

export const PARTS: Part[] = [
  { sku: "BR-100", name: "Brake caliper", bin: "A1" },
  { sku: "BR-220", name: "Brake pad set", bin: "A2" },
  { sku: "BT-310", name: "Battery tray", bin: "B1" },
  { sku: "BT-410", name: "Belt tensioner", bin: "B2" },
  { sku: "CL-090", name: "Clutch plate", bin: "C1" },
  { sku: "CL-140", name: "Coolant hose", bin: "C2" },
  { sku: "FL-020", name: "Fuel line", bin: "D1" },
  { sku: "FL-450", name: "Flywheel", bin: "D2" }
];

export function matchParts(query: string): Part[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return PARTS;
  return PARTS.filter(
    part => part.name.toLowerCase().includes(needle) || part.sku.toLowerCase().includes(needle)
  );
}

export interface Inventory {
  query: Accessor<string>;
  setQuery: (next: string) => void;
  matches: Accessor<Part[]>;
}

/**
 * BROKEN — the filtered list is kept in a signal and re-synced by an effect.
 *
 * Every value here is eventually right, so tests on final state pass. What is
 * wrong is the *schedule*: the effect only runs after the flush in which
 * `query` changed, so for one frame the screen shows the new query beside the
 * previous query's matches.
 */
export function createRelayedInventory(): Inventory {
  const [query, setQuery] = createSignal("", { name: nodeName("tear", "query") });
  const [matches, setMatches] = createSignal<Part[]>(matchParts(""), {
    name: nodeName("tear", "matches")
  });

  createEffect(
    () => matchParts(query()),
    next => {
      setMatches(next);
    },
    { name: nodeName("tear", "syncMatches") }
  );

  return { query, setQuery, matches };
}

/**
 * FIXED — the same value as a derivation.
 *
 * More correct: `matches` can never disagree with `query`, because it is not
 * a separate fact. More idiomatic: derived state is a memo. More efficient:
 * one flush instead of two, no extra signal, and the memo is lazy — it does
 * not recompute at all while nothing reads it.
 */
export function createDerivedInventory(): Inventory {
  const [query, setQuery] = createSignal("", { name: nodeName("tear", "query") });
  const matches = createMemo(() => matchParts(query()), { name: nodeName("tear", "matches") });
  return { query, setQuery, matches };
}
