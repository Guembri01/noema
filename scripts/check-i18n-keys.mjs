#!/usr/bin/env node
/**
 * i18n key gate: every `t(locale, "key")` must exist in the catalogue.
 *
 * Why this exists: during a parallel refactor several components were changed to
 * call `t(locale, "someNewKey")` before the key was added to `src/lib/i18n.ts`.
 * The type system does catch it — but as a wall of
 * `Argument of type '"x"' is not assignable to parameter of type '"y" | … 1080
 * more …'`, one error per call site, which is hard to read and easy to attribute
 * to the wrong file. This turns that into one line per missing key, naming the
 * files that reference it, and exits non-zero.
 *
 * The catalogue's `en` block is the source of truth (the `Dict` type is derived
 * from it), so keys are collected from there.
 *
 *   npm run check:i18n
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

const i18nFile = join(SRC, "lib", "i18n.ts");
const i18n = readFileSync(i18nFile, "utf8");

// Keys of the `en` block: from `const en = {` to the matching closing `};`.
const enStart = i18n.indexOf("const en = {");
if (enStart < 0) {
  console.error("could not find the `en` catalogue block in src/lib/i18n.ts");
  process.exit(1);
}
const enEnd = i18n.indexOf("\n};", enStart);
const enBlock = i18n.slice(enStart, enEnd);
const catalogue = new Set([...enBlock.matchAll(/^\s{2}(\w+):\s/gm)].map((m) => m[1]));

if (catalogue.size < 100) {
  console.error(`only ${catalogue.size} keys parsed — the catalogue shape changed?`);
  process.exit(1);
}

/**
 * `t(locale, "key")` — literals only.
 *
 * Two guards keep this honest:
 *  · the first argument must *look like a locale* (`locale`, `lang`, or one of the
 *    five tags). Without that, a test helper named `t(id, parentId, position)`
 *    matches and reports fixture strings like `"ghost"` as missing keys.
 *  · test files are skipped: the gate is about the app's copy, and tests are
 *    type-checked against the same `Dict` anyway.
 */
const CALL = /\bt\(\s*([^,()]+?)\s*,\s*"([A-Za-z0-9_]+)"/g;
const looksLikeLocale = (first) =>
  /\b(?:locale|lang)\b/.test(first) || /^"(?:en|fr|es|de|ar)"$/.test(first.trim());

const missing = new Map();
let referenced = 0;
for (const file of walk(SRC)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  if (/\.test\.tsx?$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, index) => {
    // Comments explain rules; they are not call sites.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const match of line.matchAll(CALL)) {
      if (!looksLikeLocale(match[1])) continue;
      referenced += 1;
      const key = match[2];
      if (catalogue.has(key)) continue;
      const list = missing.get(key) ?? [];
      list.push(`${rel(file)}:${index + 1}`);
      missing.set(key, list);
    }
  });
}

console.log(`i18n key gate — ${catalogue.size} keys in the catalogue · ${referenced} literal call sites\n`);

if (missing.size === 0) {
  console.log("  ok    every referenced key exists");
  console.log("\n0 missing key(s).");
  process.exit(0);
}

for (const [key, sites] of [...missing.entries()].sort()) {
  console.log(`  MISSING  ${key}`);
  for (const site of sites.slice(0, 4)) console.log(`           referenced by ${site}`);
  if (sites.length > 4) console.log(`           …and ${sites.length - 4} more`);
}

console.error(
  [
    "",
    `${missing.size} key(s) referenced but not in the catalogue.`,
    "",
    "Add them to src/lib/i18n.ts in ALL FIVE locale blocks, at the same position",
    "(right after each block's `chat:` line) and in the same order — the `Dict`",
    "type and src/lib/i18n.test.ts enforce parity across locales.",
  ].join("\n"),
);
process.exit(1);
