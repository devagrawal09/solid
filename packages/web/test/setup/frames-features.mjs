// Frames client link-time switches in the test configs (frames/src/features.ts;
// documentation/plans/core-runtime-slicing.md, "Frames client switches").
//
//   FRAMES_CENSUS=<file.jsonl>        record, per test, the switchable
//                                     features it touched (markFeature)
//   FRAMES_FEATURES_OFF=A,B           compile frames/src with those switches off
//   FRAMES_FEATURE_SUBSET=<census>    skip the tests the census marked with a
//                                     switched-off feature
//
// scripts/frames-differential.mjs drives the three.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FEATURES_SRC = fileURLToPath(new URL("../../frames/src/features.ts", import.meta.url));

export function framesFeatureSwitches() {
  const off = (process.env.FRAMES_FEATURES_OFF ?? "").split(",").filter(Boolean);
  return {
    name: "frames:feature-switches",
    enforce: "pre",
    load(id) {
      if (!off.length || id.split("?")[0] !== FEATURES_SRC) return null;
      return readFileSync(FEATURES_SRC, "utf8").replace(
        /^export const (\w+) = (.+);$/gm,
        (line, name) => (off.includes(name) ? `export const ${name} = false;` : line)
      );
    }
  };
}

export function framesSetupFiles() {
  if (process.env.FRAMES_CENSUS)
    return [fileURLToPath(new URL("./frames-census.ts", import.meta.url))];
  if (process.env.FRAMES_FEATURE_SUBSET)
    return [fileURLToPath(new URL("./frames-subset.ts", import.meta.url))];
  return [];
}
