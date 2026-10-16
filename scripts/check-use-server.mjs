// Guards a Next.js rule that unit tests cannot catch:
//
//   A "use server" file can only export async functions.
//
// Exporting a runtime value (const/let/var/class/enum) from a module that
// starts with "use server" makes Next.js throw at import time
// ("found number" / "found string" / "found object"), which 500s EVERY route
// that transitively imports the file. `tsc`, `eslint` and `vitest` all stay
// green, so this class of break reaches production unless a live check runs.
//
// This script statically scans `src/` for "use server" modules and fails if any
// runtime export is not an async function. `export type` / `export interface`
// are erased at compile time and are allowed; `export { x }` re-exports are
// resolved against a local async declaration when possible, otherwise reported
// for manual triage.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "src";
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
  }
})(root);

const problems = [];
let scanned = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const stripped = source.replace(/^\uFEFF/, "").trimStart();
  const isServerActionFile =
    stripped.startsWith('"use server"') ||
    stripped.startsWith("'use server'") ||
    /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(stripped);
  if (!isServerActionFile) continue;
  scanned += 1;

  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const text = line.trim();

    // Erased at compile time -> always fine.
    if (/^export\s+(type|interface)\b/.test(text)) return;

    // Runtime value exports from a "use server" module are illegal.
    if (/^export\s+(const|let|var|class|enum)\b/.test(text)) {
      problems.push({ file, line: index + 1, text });
      return;
    }

    if (/^export\s+(async\s+)?function\b/.test(text) && !/^export\s+async\s+function\b/.test(text)) {
      problems.push({ file, line: index + 1, text: `${text}  (sync function — must be async)` });
      return;
    }

    if (/^export\s+default\b/.test(text)) {
      problems.push({ file, line: index + 1, text: `${text}  (default export — must be an async function)` });
      return;
    }

    // `export { a, b }` / `export { a } from "./x"` need manual triage unless
    // every local name resolves to an async function declaration.
    const named = text.match(/^export\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?\s*;?$/);
    if (named) {
      const names = named[1]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      const unresolved = names.filter(
        (name) => !new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).test(source),
      );
      if (unresolved.length > 0) {
        problems.push({
          file,
          line: index + 1,
          text: `${text}  (unverifiable re-export: ${unresolved.join(", ")})`,
        });
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`FAIL  "use server" files may only export async functions (${problems.length} problem(s))`);
  for (const p of problems) console.error(`      ${p.file}:${p.line}  ${p.text}`);
  console.error("");
  console.error('Move runtime values/types-with-values into a normal module (e.g. src/lib/*) and import them.');
  process.exit(1);
}

console.log(`PASS  ${scanned} "use server" file(s) export only async functions`);
