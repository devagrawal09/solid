import { $, createMemo, perform as _$perform } from "solid-js";
import type { Block } from "solid-js";
// The `: Generator<…>` return annotation is dropped with the generator;
// parameter and local annotations survive, and type-only imports are not
// mistaken for the runtime import.
export const total = createMemo($(function(prev: number | undefined) {
	const c: number = _$perform(count);
	return c + (prev ?? 0);
}));
export type Total = Block<number>;
