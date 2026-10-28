/**
 * Display-only cleanup for strings that came out of audit payloads, imported
 * notes or erasure plans. These values are often Markdown fragments; rendering
 * their raw `###` markers or a repeated line as UI text makes a clean report
 * look corrupted.
 *
 * This is deliberately lossy only at the presentation edge:
 *  - leading ATX heading markers (`### `) are removed;
 *  - runs of blank lines collapse to one;
 *  - adjacent duplicate lines are dropped;
 *  - surrounding whitespace is trimmed.
 */

/** Remove Markdown heading markers and duplicate lines from a display string. */
export function cleanDisplayText(value: string): string {
  const lines: string[] = [];
  for (const raw of value.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/^\s{0,3}#{1,6}\s+/, "").trimEnd();
    if (line.trim() === "") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").trim();
}

/** Deduplicate rows by a stable key, preserving first-seen order. */
export function uniqueRows<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}
