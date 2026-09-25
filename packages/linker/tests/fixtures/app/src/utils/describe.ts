export function describeSave(index: number, shift: boolean) {
  return `save #${index + 1}${shift ? " (shift)" : ""}`;
}
