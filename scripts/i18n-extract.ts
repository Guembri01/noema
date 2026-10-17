/**
 * i18n extraction workflow — the production caller for `src/lib/i18n-scan.ts`.
 *
 *   node_modules/.bin/tsx scripts/i18n-extract.ts            # scan all of src/
 *   node_modules/.bin/tsx scripts/i18n-extract.ts --top 15   # more files listed
 *
 * the i18n key inserter owns the WRITE side (it splices hand-authored keys
 * into the five locale blocks). This companion owns the READ side: it walks
 * `src/`, runs the conservative `i18n-scan` analyser, prints the real coverage
 * each file/locale reaches, proposes catalogue keys for the strings still
 * hard-coded, merges those proposals against the live catalogue
 * (`mergeIntoCatalog`) and reports the per-locale delta (`diffCatalog`) —
 * without touching `src/lib/i18n.ts`. It is the evidence behind the coverage
 * numbers; the i18n key inserter is what actually applies a change.
 *
 * Pure helpers are exported so `scripts/i18n-extract.test.mjs` can pin them
 * without a filesystem or a full repo scan. `import.meta.url` guards the CLI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildExtractionReport,
  diffCatalog,
  mergeIntoCatalog,
  type Catalog,
  type CatalogEntry,
  type CatalogDiff,
  type ExtractionReport,
  type FileReport,
  type SourceFile,
} from "../src/lib/i18n-scan";
import { heapify, heapSize, pop } from "../src/lib/heap";
import { normalizeLanguageTag } from "../src/lib/language-tag";

/** The five locales the catalogue ships. */
export const DEFAULT_LOCALES = ["en", "fr", "es", "de", "ar"] as const;

/** A proposed key plus the file/line that produced it. */
export type ExtractionProposal = {
  key: string;
  text: string;
  file: string;
  line: number;
};

/** The whole workflow result: scan + proposals + merge + diff + hot files. */
export type ExtractionWorkflow = {
  report: ExtractionReport;
  proposals: ExtractionProposal[];
  added: string[];
  duplicates: string[];
  diff: Record<string, CatalogDiff>;
  topFiles: FileReport[];
};

/** A locale tag that survives canonicalisation, or a thrown error. */
export function normalizeLocales(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const canonical = normalizeLanguageTag(code);
    if (canonical === null) throw new Error(`invalid BCP-47 locale tag: ${JSON.stringify(code)}`);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/** Parse the `key: "value"` entries of a single `en`/locale block. */
function parseLocaleBlock(lines: readonly string[], code: string): Record<string, string> {
  const openRe = code === "en" ? /^const en = \{$/ : new RegExp(`^  ${code}: \\{$`);
  const closeRe = code === "en" ? /^\};$/ : /^  \},$/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (openRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error(`catalogue block not found for locale ${code}`);
  let close = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (closeRe.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error(`catalogue block close not found for locale ${code}`);

  const dict: Record<string, string> = {};
  const entryRe = /^\s+([A-Za-z0-9_]+):\s*"(.*)",?\s*$/;
  for (let i = start + 1; i < close; i += 1) {
    const match = entryRe.exec(lines[i]);
    if (!match) continue;
    const [, key, raw] = match;
    let value = raw;
    try {
      value = JSON.parse(`"${raw}"`);
    } catch {
      // A value with an edge-case escape: keep the raw text; only the key matters.
    }
    dict[key] = value;
  }
  return dict;
}

/** Parse the live `@/lib/i18n` catalogue text into a per-locale `Catalog`. */
export function parseCatalog(source: string, locales: readonly string[]): Catalog {
  const lines = source.split(/\r?\n/);
  const catalog: Catalog = {};
  for (const code of locales) catalog[code] = parseLocaleBlock(lines, code);
  return catalog;
}

/** Walk `dir` for user-facing source (`.ts`/`.tsx`, no tests/declarations). */
export function collectSourceFiles(dir: string, root: string = dir): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectSourceFiles(path, root));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
    files.push({ path: relative(root, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8") });
  }
  return files;
}

/**
 * The N files carrying the most un-translated strings, best-first. Uses the
 * immutable heap from `@/lib/heap` as a max-heap so only the requested window
 * is materialised when `limit` is small.
 */
export function topFilesByGaps(report: ExtractionReport, limit: number): FileReport[] {
  if (limit <= 0) return [];
  let heap = heapify(report.files, (a: FileReport, b: FileReport) => {
    if (a.found.length !== b.found.length) return b.found.length - a.found.length;
    return a.file < b.file ? 1 : a.file > b.file ? -1 : 0;
  });
  const top: FileReport[] = [];
  while (top.length < limit && heapSize(heap) > 0) {
    const result = pop(heap);
    heap = result.heap;
    if (result.value) top.push(result.value);
  }
  return top.sort(
    (a, b) => b.found.length - a.found.length || a.file.localeCompare(b.file),
  );
}

/**
 * Run the analyser over `files`, propose a key per hard-coded string, merge the
 * proposals into `catalog` for every locale, diff the merge, and rank files.
 * `catalog` is never mutated (both `mergeIntoCatalog` and `diffCatalog` are pure).
 */
export function buildExtractionWorkflow(args: {
  files: readonly SourceFile[];
  catalog: Catalog;
  locales: readonly string[];
  top?: number;
}): ExtractionWorkflow {
  const known = new Set<string>();
  for (const dict of Object.values(args.catalog)) {
    for (const key of Object.keys(dict)) known.add(key);
  }

  const report = buildExtractionReport(args.files, { catalogKeys: [...known] });
  const proposals: ExtractionProposal[] = [];
  for (const file of report.files) {
    for (const found of file.found) {
      proposals.push({ key: found.suggestion, text: found.text, file: file.file, line: found.line });
    }
  }

  const entries: CatalogEntry[] = proposals.map((proposal) => ({
    key: proposal.key,
    values: { en: proposal.text },
  }));
  const merged = mergeIntoCatalog(args.catalog, entries, args.locales);
  const diff = diffCatalog(args.catalog, merged.catalog);

  return {
    report,
    proposals,
    added: merged.added,
    duplicates: merged.duplicates,
    diff,
    topFiles: topFilesByGaps(report, args.top ?? 10),
  };
}

/** Render a human-readable workflow summary (one block per section). */
export function formatWorkflowReport(workflow: ExtractionWorkflow, locales: readonly string[]): string {
  const { report, proposals, added, duplicates, diff, topFiles } = workflow;
  const coverage = Math.round(report.totals.coverage * 1000) / 10;

  const lines: string[] = [];
  lines.push("=== i18n extraction report ===");
  lines.push(
    `files: ${report.files.length} · hard-coded strings: ${report.totals.found} · ` +
      `existing t() keys: ${report.totals.existingKeysUsed} · coverage: ${coverage}%`,
  );
  lines.push(`proposed new keys: ${proposals.length} · added: ${added.length} · duplicates: ${duplicates.length}`);

  lines.push("");
  lines.push("-- files with the most un-translated strings --");
  for (const file of topFiles) {
    if (file.found.length === 0) continue;
    lines.push(`  ${file.found.length}  ${file.file}  (coverage ${Math.round(file.coverage * 100)}%)`);
  }

  lines.push("");
  lines.push("-- per-locale catalogue delta if the proposals were merged --");
  for (const locale of locales) {
    const delta = diff[locale] ?? { missing: [], extra: [] };
    lines.push(`  ${locale}: +${delta.extra.length} extra, -${delta.missing.length} missing`);
  }

  if (duplicates.length > 0) {
    lines.push("");
    lines.push("-- duplicate keys skipped --");
    lines.push(`  ${duplicates.join(", ")}`);
  }
  return lines.join("\n");
}

/** CLI entry: scan the repo's `src/`, report coverage, change nothing. */
async function main(): Promise<void> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  const topFlag = args.indexOf("--top");
  const top = topFlag >= 0 && args[topFlag + 1] ? Number.parseInt(args[topFlag + 1], 10) : 10;

  const locales = normalizeLocales(DEFAULT_LOCALES);
  const catalog = parseCatalog(readFileSync(join(root, "src/lib/i18n.ts"), "utf8"), locales);
  const files = collectSourceFiles(join(root, "src"), join(root, "src"));
  const workflow = buildExtractionWorkflow({ files, catalog, locales, top });
  console.log(formatWorkflowReport(workflow, locales));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
