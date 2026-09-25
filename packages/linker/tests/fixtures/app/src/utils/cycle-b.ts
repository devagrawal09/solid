import { LIMIT } from "../features/stats";
import { strip } from "./cycle-a";

// A cold module importing `LIMIT`: the export cannot move to a residue
// module (this importer is not generated), so the fixed point pins it.
export function collapse(text: string): string {
  return strip(text).replace(/\s+/g, " ").slice(0, LIMIT);
}
