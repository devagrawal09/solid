/**
 * Scenario 2 model — the filterable list half. Identical in both variants:
 * the only thing that changes is how the selection tracks it (`selection.ts`).
 */
import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";

export interface Row {
  id: string;
  name: string;
  role: string;
}

export const ROWS: readonly Row[] = [
  { id: "ada", name: "Ada Lovelace", role: "Analytical Engine" },
  { id: "alan", name: "Alan Turing", role: "Computability" },
  { id: "grace", name: "Grace Hopper", role: "Compilers" },
  { id: "linus", name: "Linus Torvalds", role: "Kernels" },
  { id: "margaret", name: "Margaret Hamilton", role: "Flight software" },
  { id: "barbara", name: "Barbara Liskov", role: "Abstraction" },
  { id: "dennis", name: "Dennis Ritchie", role: "Systems languages" },
  { id: "ken", name: "Ken Thompson", role: "Operating systems" }
];

export const DEFAULT_ID = "ada";

export interface Catalog {
  query: Accessor<string>;
  setQuery: Setter<string>;
  visibleIds: Accessor<string[]>;
  rowById(id: string): Row | undefined;
}

export function createCatalog(): Catalog {
  const [query, setQuery] = createSignal("", { name: "query" });
  const visibleIds = createMemo(
    () => {
      const needle = query().trim().toLowerCase();
      return ROWS.filter(row => row.name.toLowerCase().includes(needle)).map(row => row.id);
    },
    { name: "visibleIds" }
  );
  return { query, setQuery, visibleIds, rowById: id => ROWS.find(row => row.id === id) };
}
