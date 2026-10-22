#!/usr/bin/env node
/**
 * Route bundle budget.
 *
 * Next's build table is useful, but it is not machine-readable and it rounds.
 * This script reads `.next/app-build-manifest.json`, gzips every file the route
 * owns, and fails when the total grows past the budget in
 * `scripts/bundle-budget.json`.
 *
 * It is deliberately dependency-free: `node:zlib` is the same compressor a CDN
 * uses closely enough for a regression gate, and a new dev dependency for a
 * number we already have on disk is not worth the supply-chain surface.
 *
 * Usage:
 *   node scripts/bundle-budget.mjs
 *   node scripts/bundle-budget.mjs --route "/w/[slug]/[pageId]/page"
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".next", "app-build-manifest.json");
const BUDGETS = join(ROOT, "scripts", "bundle-budget.json");
const DEFAULT_ROUTE = "/w/[slug]/[pageId]/page";

/** Sum unique chunk rows; a file listed twice is one download, not two. */
export function summarizeChunks(rows) {
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, row);
  }
  const unique = [...byFile.values()];
  return {
    files: unique.length,
    raw: unique.reduce((sum, row) => sum + row.raw, 0),
    gzip: unique.reduce((sum, row) => sum + row.gzip, 0),
  };
}

/** Equality passes: the budget is a ceiling, not a target. */
export function evaluateBudget(actualGzip, budgetGzip) {
  const overBy = Math.max(0, actualGzip - budgetGzip);
  return { ok: overBy === 0, overBy };
}

/** Build the row list for a route from the app-build manifest. */
export function chunkRows(manifest, routeKey, readSizes) {
  const files = manifest?.pages?.[routeKey];
  if (!files) {
    throw new Error(
      `route ${routeKey} is not in .next/app-build-manifest.json; run npm run build first`,
    );
  }
  return files.map((file) => ({ file, ...readSizes(file) }));
}

function readSizes(file) {
  const absolute = join(ROOT, ".next", file);
  if (!existsSync(absolute)) {
    throw new Error(`manifest points at a missing chunk: ${file}`);
  }
  const bytes = readFileSync(absolute);
  return { raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error("bundle budget: .next/app-build-manifest.json is missing.");
    console.error("Run `npm run build` first.");
    process.exit(2);
  }

  const routeKey = argValue("--route", DEFAULT_ROUTE);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const budgets = JSON.parse(readFileSync(BUDGETS, "utf8"));
  const configured = budgets?.routes?.[routeKey];
  if (!configured) {
    console.error(`bundle budget: no budget configured for ${routeKey}`);
    process.exit(2);
  }

  const rows = chunkRows(manifest, routeKey, readSizes);
  const summary = summarizeChunks(rows);
  const result = evaluateBudget(summary.gzip, configured.budgetGzipBytes);

  console.log(`route   ${routeKey}`);
  console.log(`chunks  ${summary.files}`);
  console.log(`raw     ${summary.raw.toLocaleString()} bytes`);
  console.log(`gzip    ${summary.gzip.toLocaleString()} bytes`);
  console.log(`budget  ${configured.budgetGzipBytes.toLocaleString()} bytes`);
  console.log(`headroom ${(configured.budgetGzipBytes - summary.gzip).toLocaleString()} bytes`);
  console.log("");
  console.log("largest chunks:");
  for (const row of [...rows]
    .sort((a, b) => b.gzip - a.gzip)
    .slice(0, 12)) {
    console.log(
      `${String(row.gzip).padStart(8)} gzip  ${String(row.raw).padStart(9)} raw  ${row.file}`,
    );
  }

  if (!result.ok) {
    console.error(`\nbundle budget exceeded by ${result.overBy.toLocaleString()} gzip bytes.`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("bundle-budget.mjs")) {
  main();
}
