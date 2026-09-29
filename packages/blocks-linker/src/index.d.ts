export interface LinkerOptions {
  /** Project root (default: cwd). */
  root?: string;
  /** Source directories under the root (default `["src"]`). */
  dirs?: string[];
  /** The generated file (default `"src/solid-props.gen.d.ts"`). */
  out?: string;
  /** Module prefixes resolved to directories (e.g. `{ "~": "src" }`). */
  alias?: Record<string, string>;
  /** Modules whose exports have callers beyond the project: their components stay open. */
  publicModules?: string[];
  /** Override the per-module analysis (default: `@solidjs/compiler`'s `summarizeBlocks`). */
  summarize?: (code: string, filename: string) => unknown;
}
export interface LinkerDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
}
export interface Linker {
  root: string;
  out: string;
  scan(): Linker;
  update(file: string): boolean;
  generate(): { text: string; diagnostics: LinkerDiagnostic[]; solved: unknown };
  write(): { changed: boolean; text: string; diagnostics: LinkerDiagnostic[] };
  check(): {
    stale: boolean;
    expected: string;
    current: string | null;
    diagnostics: LinkerDiagnostic[];
  };
  modules: Map<string, unknown>;
}
export function createLinker(options?: LinkerOptions): Linker;
