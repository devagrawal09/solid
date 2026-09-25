// Used by rendering and by a handler: shared.
export const LIMIT = 40;
export function countWords(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}
