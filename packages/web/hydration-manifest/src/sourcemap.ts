// Minimal source map v3 writer for generated hydration entries: each
// generated line may carry segments pointing at a line/column of ONE source
// (the manifest the entry was composed from).

/** A mapping from a generated position to a position in the manifest source. */
export interface EntrySegment {
  /** 0-based generated line. */
  line: number;
  /** 0-based generated column. */
  column: number;
  /** 0-based source line. */
  sourceLine: number;
  /** 0-based source column. */
  sourceColumn: number;
}

export interface EntrySourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += BASE64[digit];
  } while (v > 0);
  return out;
}

export function buildSourceMap(
  file: string,
  source: string,
  sourceContent: string,
  lineCount: number,
  segments: EntrySegment[]
): EntrySourceMap {
  const byLine: EntrySegment[][] = Array.from({ length: lineCount }, () => []);
  for (const s of segments) byLine[s.line].push(s);
  let prevSourceLine = 0;
  let prevSourceColumn = 0;
  const lines = byLine.map(list => {
    list.sort((a, b) => a.column - b.column);
    let prevColumn = 0;
    return list
      .map(s => {
        const out =
          vlq(s.column - prevColumn) +
          vlq(0) +
          vlq(s.sourceLine - prevSourceLine) +
          vlq(s.sourceColumn - prevSourceColumn);
        prevColumn = s.column;
        prevSourceLine = s.sourceLine;
        prevSourceColumn = s.sourceColumn;
        return out;
      })
      .join(",");
  });
  return {
    version: 3,
    file,
    sources: [source],
    sourcesContent: [sourceContent],
    names: [],
    mappings: lines.join(";")
  };
}

function base64(text: string): string {
  // UTF-8 bytes, then standard base64 — no Buffer/btoa, so the module stays
  // environment-neutral.
  const bytes = unescape(encodeURIComponent(text));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : NaN;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out +=
      BASE64[(n >> 18) & 63] +
      BASE64[(n >> 12) & 63] +
      (Number.isNaN(b) ? "=" : BASE64[(n >> 6) & 63]) +
      (Number.isNaN(c) ? "=" : BASE64[n & 63]);
  }
  return out;
}

/** `//# sourceMappingURL=` comment carrying the map inline (base64 data URL). */
export function inlineSourceMapComment(map: EntrySourceMap): string {
  return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64(JSON.stringify(map))}`;
}
