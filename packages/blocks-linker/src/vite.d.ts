import type { LinkerOptions } from "./index.js";
/** The blocks type linker as a Vite plugin (dev: watch and update; build: fail when stale). */
export default function solidLink(options?: LinkerOptions & { log?: boolean }): any;
export { solidLink };
