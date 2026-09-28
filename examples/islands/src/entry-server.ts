// Server entry: `app.tsx` is compiled to string templates, so rendering is a
// function call — no owner tree, no hydration keys, nothing serialized
// beyond what the islands' client code reads.
import { App } from "./app";
import { thread } from "./data";

export async function render(): Promise<string> {
  return (App as any)({ thread });
}
