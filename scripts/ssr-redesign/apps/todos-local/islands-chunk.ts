// The lazily imported chunk of client-lazy.ts: activate the island group and
// drain its first flush.
import { flush } from "@solidjs/signals";
import { activate as run } from "./islands";

export function activate(root: HTMLElement) {
  run(root);
  flush();
}
