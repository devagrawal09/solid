import { collapse } from "./cycle-b";

export function normalize(text: string): string {
  return collapse(text.trim());
}
export function strip(text: string): string {
  return text.replace(/[^\w\s-]/g, "");
}
