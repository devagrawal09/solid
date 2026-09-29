/**
 * Scenario 1 model — pagination over a fixed catalogue.
 *
 * Owner-scoped factory (the shape `examples/todos/src/todos.ts` uses): no
 * module-level reactive state, so the card can be remounted per variant and
 * the tests mount exactly what the app renders.
 *
 * The only difference between the variants is WHERE the clamp lives:
 *
 *   broken — `page` is a raw signal. Nothing stops it exceeding `pageCount`,
 *            so `Pager` adds an effect that corrects it after the fact. That
 *            effect reads `page` and writes `page`: a feedback edge.
 *   fixed  — `page` is a memo of the raw request and the bound. The invalid
 *            state is unrepresentable, and no effect exists to correct it.
 */
// Twin note: the interface types are `SourceAccessor` (what `createSignal` /
// `createMemo` return) instead of `Accessor`, so blocks can `yield*` them; a
// plain `Accessor<T>` is not iterable at the type level.
import { createMemo, createSignal, type SourceAccessor, type Setter } from "solid-js";
import type { Variant } from "../../lab/engine";

export const ITEM_COUNT = 57;
export const PAGE_SIZES = [10, 25] as const;

export interface Pagination {
  page: SourceAccessor<number>;
  setPage: Setter<number>;
  pageSize: SourceAccessor<number>;
  setPageSize: Setter<number>;
  pageCount: SourceAccessor<number>;
}

export function createPagination(variant: Variant): Pagination {
  const [pageSize, setPageSize] = createSignal<number>(PAGE_SIZES[0], { name: "pageSize" });
  const pageCount = createMemo(() => Math.ceil(ITEM_COUNT / pageSize()), { name: "pageCount" });

  if (variant === "broken") {
    const [page, setPage] = createSignal(1, { name: "page" });
    return { page, setPage, pageSize, setPageSize, pageCount };
  }

  // The fix: `page` is derived, so it can never be out of range and nothing
  // has to write it back. `rawPage` holds only what the user asked for.
  const [rawPage, setRawPage] = createSignal(1, { name: "rawPage" });
  const page = createMemo(() => Math.min(rawPage(), pageCount()), { name: "page" });
  return { page, setPage: setRawPage, pageSize, setPageSize, pageCount };
}
