import config from "../config";
import { applyBlocksRule } from "./blocks-rule";
import type * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { BabelHubWithMetadata, PluginPass } from "../types";

export default (path: NodePath<t.Program>, state: PluginPass) => {
  const file = (path.hub as unknown as BabelHubWithMetadata).file;
  const parsedMetadata = file.ast.tsrxStyle;
  if (parsedMetadata) {
    file.metadata.css = parsedMetadata.css;
    file.metadata.cssHash = parsedMetadata.cssHash;
    delete file.ast.tsrxStyle;
  }
  const merged = (file.metadata.config = Object.assign({}, config, state.opts));
  const lib = merged.requireImportSource;
  if (lib) {
    const comments = file.ast.comments ?? [];
    let process = false;
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i];
      const pieces = comment.value.split("@jsxImportSource");
      if (pieces.length === 2 && pieces[1].trim() === lib) {
        process = true;
        break;
      }
    }
    if (!process) {
      state.skip = true;
      return;
    }
  }
  // The one block rule, before the JSX transform decides what is dynamic.
  if (file.code == null || file.code.includes("yield")) applyBlocksRule(path, merged.blocksModule);
};
