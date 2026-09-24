/**
 * Scenario 2 model — "keep the selection valid when the list is filtered".
 *
 *   broken — `selectedId` is a signal, and a cross-file effect writes it
 *            whenever the current choice is filtered out. The write is
 *            conditional and transformed (`ids[0]`, not the compute output),
 *            so it is NOT the identity-copy shape the engine can call
 *            derivable on sight: it is a real relay, and the verdict is
 *            earned from the cause chain alone.
 *   fixed  — `selectedId` is a memo of `chosen` and `visibleIds`. Same rule,
 *            no second write, so every reader sees it in the same flush.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { DEFAULT_ID, type Catalog } from "./catalog";
import type { Variant } from "../../lab/engine";

export interface Selection {
  selectedId: () => string;
  select(id: string): void;
}

export function createSelection(variant: Variant, catalog: Catalog): Selection {
  if (variant === "broken") {
    const [selectedId, setSelectedId] = createSignal(DEFAULT_ID, { name: "selectedId" });
    // ── the defect ──────────────────────────────────────────────────────
    // Derived state kept in sync by an effect. `untrack` keeps `selectedId`
    // out of the dependency set, so this is not a self-feeding cycle — it is
    // a relay: one write of `query` reaches every reader of both `query` and
    // `selectedId` twice, and the first of those frames is inconsistent.
    createEffect(
      catalog.visibleIds,
      ids => {
        if (!ids.includes(untrack(selectedId))) setSelectedId(ids[0] ?? "");
      },
      { name: "syncSelection" }
    );
    return { selectedId, select: id => setSelectedId(id) };
  }

  const [chosen, setChosen] = createSignal(DEFAULT_ID, { name: "chosen" });
  const selectedId = createMemo(
    () => {
      const ids = catalog.visibleIds();
      const pick = chosen();
      return ids.includes(pick) ? pick : (ids[0] ?? "");
    },
    { name: "selectedId" }
  );
  return { selectedId, select: id => setChosen(id) };
}
