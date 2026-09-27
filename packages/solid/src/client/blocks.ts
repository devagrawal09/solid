// Generator blocks v2 constructors that create primitives, re-exported with
// lazy registration of the hydration-aware primitives (see
// ensureBlockPrimitives in hydration.ts). Each constructor registers before it
// builds its operation, so every primitive a block creates — at setup, in an
// effect half — is the hydration-aware one, exactly as with the former
// module-scope registration. What changes is only WHEN registration happens:
// an app that never calls a block constructor never references the block
// primitives, so the store (and the block API's primitive table) shakes out.
import {
  $effect as signals$effect,
  $memo as signals$memo,
  $signal as signals$signal,
  $store as signals$store,
  effectBlock as signalsEffectBlock
} from "@solidjs/signals";
import { ensureBlockPrimitives } from "./hydration.js";

export const $signal: typeof signals$signal = ((...args: [any, any?]) => {
  ensureBlockPrimitives();
  return signals$signal(...args);
}) as typeof signals$signal;

export const $store: typeof signals$store = ((...args: [any, any?]) => {
  ensureBlockPrimitives();
  return (signals$store as any)(...args);
}) as typeof signals$store;

export const $memo: typeof signals$memo = ((...args: [any, any?]) => {
  ensureBlockPrimitives();
  return (signals$memo as any)(...args);
}) as typeof signals$memo;

export const $effect: typeof signals$effect = ((...args: [any, any?]) => {
  ensureBlockPrimitives();
  return (signals$effect as any)(...args);
}) as typeof signals$effect;

export const effectBlock: typeof signalsEffectBlock = (body: unknown, compute?: unknown) => {
  ensureBlockPrimitives();
  return signalsEffectBlock(body, compute);
};
