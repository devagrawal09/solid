// A large, cold-only helper reached from the lazy route's handler.
export function heavyReport(rows: number) {
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) lines.push(`row ${i}: ${(i * 31) % 17}`);
  return lines.join("\n");
}
