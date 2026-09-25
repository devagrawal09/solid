// Node resolve hook for the measurement script: the driver's server output
// keeps the authored extensionless relative imports (`./buy`), which vitest
// resolves and plain Node does not. Try the `.js` sibling.
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await next(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL) throw error;
      const base = new URL(specifier, context.parentURL);
      for (const ext of [".js", ".mjs"]) {
        const candidate = fileURLToPath(base) + ext;
        try {
          await fs.stat(candidate);
          return next(pathToFileURL(candidate).href, context);
        } catch {
          // try the next extension
        }
      }
      throw error;
    }
  }
  return next(specifier, context);
}
