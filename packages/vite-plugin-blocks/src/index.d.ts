import type { NodePath, PluginObj, types } from "@babel/core";
import type { SourceMap } from "magic-string";

/** The positions the rule refuses, by code. */
export declare const REFUSALS: {
  readonly BLOCKS_YIELD_IN_EVENT: string;
  readonly BLOCKS_YIELD_IN_REF: string;
  readonly BLOCKS_YIELD_IN_SPREAD: string;
  readonly BLOCKS_YIELD_IN_SPREAD_CHILD: string;
  readonly BLOCKS_PLAIN_YIELD_IN_JSX: string;
};
export type RefusalCode = keyof typeof REFUSALS;

/** `"@solidjs/blocks"`: where `perform` is imported from unless configured. */
export declare const DEFAULT_BLOCKS_MODULE: string;

export interface Refusal {
  code: RefusalCode;
  /** `[CODE] message (line:column)`, the compiler's format. */
  message: string;
  path: NodePath<types.YieldExpression>;
}

/** Thrown for refused positions: every refusal, one per line of the message. */
export declare class BlocksRuleError extends Error {
  code: RefusalCode;
  refusals: { code: RefusalCode; line: number; column: number }[];
  /** Set by `transform()`, for Vite. */
  id?: string;
  loc?: { file: string; line: number; column: number };
}

/** The rule as one function: the holes it rewrites and the positions it refuses. */
export declare function blocksRule(program: NodePath<types.Program>): {
  holes: NodePath<types.YieldExpression>[];
  refusals: Refusal[];
};

/** Apply the rule to a Babel program in place; throws `BlocksRuleError`. */
export declare function applyBlocksRule(
  program: NodePath<types.Program>,
  t: typeof types,
  blocksModule?: string
): boolean;

export interface BabelPluginBlocksOptions {
  blocksModule?: string;
}

/** The rule as a Babel plugin; run it before the JSX transform. */
export declare function babelPluginBlocks(
  api: typeof import("@babel/core"),
  options?: BabelPluginBlocksOptions
): PluginObj;

export interface TransformOptions {
  /** The module's file name: picks the parser dialect and names the map's source. */
  filename: string;
  /** Where `perform` is imported from (default `"@solidjs/blocks"`). */
  blocksModule?: string;
  /** Produce a source map (default `true`). */
  sourceMap?: boolean;
}

export interface TransformResult {
  code: string;
  map: SourceMap | null;
}

/** The rule applied to source text; `null` when nothing changed. */
export declare function transform(code: string, options: TransformOptions): TransformResult | null;

/** Babel parser plugins for a file name. */
export declare function parserPlugins(filename: string): string[];
