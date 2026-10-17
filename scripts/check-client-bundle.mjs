#!/usr/bin/env node
/**
 * Client-bundle guard: no client component may (transitively) import a Node
 * built-in.
 *
 * Why this exists, and why a type-check does not cover it:
 * `tsc` is happy with `import { randomInt } from "node:crypto"`, and Turbopack
 * (dev) happily bundles it. **webpack in a production build does not**: it fails
 * with `UnhandledSchemeError: Reading from "node:crypto" is not handled by
 * plugins`. The result was a repo where every page worked in `next dev`, all
 * 11k+ tests passed, and `next build` — for the site version *and* the desktop
 * payload — failed. Only a real build caught it; this script catches it in a
 * second, in CI, with a file and a line.
 *
 * Rules modelled:
 *  · `"use client"` marks the entry points.
 *  · `"use server"` modules are skipped: importing one from a client component is
 *    exactly how Next intends server code to be reached (it becomes a reference).
 *  · only *static* relative/alias imports are followed; a dynamic `import()` of a
 *    server-only module inside an effect is fine (it is a separate chunk).
 *
 * Usage:
 *   node scripts/check-client-bundle.mjs          # report + exit code
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
/** Built-ins that must never appear in a browser bundle. */
const NODE_BUILTIN = /^node:/;

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Resolve a static import specifier to a file on disk, or null. */
const resolveSpecifier = (fromFile, specifier) => {
  let base;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = normalize(join(dirname(fromFile), specifier));
  else return null;
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const candidate = base + suffix;
    if (isFile(candidate)) return candidate;
  }
  return null;
};

const specifiersOf = (source) => {
  const found = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    found.push(match[1]);
  }
  return found;
};

const files = walk(SRC);
const sourceOf = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
const builtinsOf = (file) =>
  [...(sourceOf.get(file)?.matchAll(/["'](node:[^"']+)["']/g) ?? [])].map((m) => m[1]);
const isClientModule = (file) => /^\s*["']use client["']/m.test(sourceOf.get(file) ?? "");
const isServerActionModule = (file) => /^\s*["']use server["']/m.test(sourceOf.get(file) ?? "");

const leaks = [];
for (const entry of files.filter(isClientModule)) {
  const visited = new Set();
  /** @type {{ file: string, path: string[] }[]} */
  const queue = [{ file: entry, path: [] }];
  while (queue.length > 0) {
    const { file, path } = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of specifiersOf(sourceOf.get(file) ?? "")) {
      if (NODE_BUILTIN.test(specifier)) {
        leaks.push({ entry, chain: [...path, `${file.replace(ROOT + "\\", "")} → ${specifier}`] });
        continue;
      }
      const target = resolveSpecifier(file, specifier);
      if (!target) continue;
      if (isServerActionModule(target)) continue; // proxied by Next, never bundled
      const targetBuiltins = builtinsOf(target);
      if (targetBuiltins.length > 0) {
        leaks.push({
          entry,
          chain: [...path, `${target.replace(ROOT + "\\", "").replace(/\\/g, "/")} (${targetBuiltins.join(", ")})`],
        });
        continue;
      }
      queue.push({ file: target, path: [...path, specifier] });
    }
  }
}

const rel = (path) => path.replace(ROOT + "\\", "").replace(/\\/g, "/");
console.log(`Client-bundle guard — ${files.length} modules scanned\n`);

if (leaks.length === 0) {
  console.log("  ok    no client component reaches a Node built-in");
  console.log("\n0 leak(s).");
  process.exit(0);
}

console.log("  FAIL  client components that pull a Node built-in into the browser bundle");
for (const leak of leaks) {
  console.log(`\n    ${rel(leak.entry)}`);
  for (const step of leak.chain) console.log(`      → ${step}`);
}
console.error(
  [
    "",
    `${leaks.length} leak(s).`,
    "",
    "Webpack rejects the `node:` scheme in a production build, so this fails",
    "`next build` (site version and desktop payload alike) even though dev and",
    "`tsc` are happy.",
    "",
    "Fix, in order of preference:",
    "  1. use a web-standard API (`globalThis.crypto`, `TextEncoder`, …) — see",
    "     `src/lib/random.ts` for the pattern;",
    "  2. make the consumer a server component or a `\"use server\"` action;",
    "  3. `import type` only, if you genuinely need just the types.",
  ].join("\n"),
);
process.exit(1);
