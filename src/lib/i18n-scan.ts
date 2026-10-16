/**
 * Gap #15 / §16 - i18n string extraction.
 *
 * A pure, parse-light analyser over source-file *text*. It helps a reviewer
 * find the English strings that still need to move into the five-locale
 * catalogue (`src/lib/i18n.ts`), propose a stable camelCase key for each, roll
 * a batch of files up into a report, merge new keys into a catalogue without
 * disturbing order, and diff two catalogue revisions per locale.
 *
 * Everything here is deterministic and side-effect free: no filesystem, no
 * `Date`, no randomness, and no dependency on a real parser. The analyser is
 * intentionally **conservative** - it would rather miss an ambiguous single
 * word than flag a `className`, a URL, a CSS unit, or a string that already
 * flows through `t(locale, key)`.
 *
 * Public API:
 *   findHardcodedStrings(source, { filePath, catalogKeys? })  - per-file hits
 *   suggestKey(text, { surface? })                            - stable key
 *   buildExtractionReport(files, { catalogKeys? })            - report + totals
 *   mergeIntoCatalog(catalog, entries, locales)               - append + guard
 *   diffCatalog(a, b)                                         - per-locale delta
 */

/** One user-facing string the analyser believes is hard-coded. */
export interface HardcodedString {
  /** The normalised (trimmed, single-spaced) string. */
  text: string;
  /** 1-based line where the string starts. */
  line: number;
  /** Whether it came from a JSX text node or a quoted attribute. */
  kind: "text" | "attribute";
  /** The attribute name when `kind === "attribute"`. */
  attribute?: string;
}

export interface ScanOptions {
  /** Path of the file being scanned - used by the report's surface naming. */
  filePath: string;
  /** Strings already known to be catalogue keys; matched values are skipped. */
  catalogKeys?: readonly string[];
}

export interface SuggestKeyOptions {
  /** Optional namespace prefix, e.g. `"database"` → `databaseOpenSidePeek`. */
  surface?: string;
}

export interface SourceFile {
  path: string;
  source: string;
}

export interface FoundString {
  text: string;
  line: number;
  suggestion: string;
}

export interface FileReport {
  file: string;
  found: FoundString[];
  existingKeysUsed: string[];
  /** Fraction of translatable strings already routed through `t()` (0..1). */
  coverage: number;
}

export interface ExtractionReport {
  files: FileReport[];
  totals: {
    found: number;
    existingKeysUsed: number;
    coverage: number;
  };
}

/** One proposed catalogue entry: a key plus its per-locale values. */
export interface CatalogEntry {
  key: string;
  values: Record<string, string>;
}

/** locale → key → translation. Order within a locale block is meaningful. */
export type Catalog = Record<string, Record<string, string>>;

export interface MergeResult {
  /** A new catalogue with the fresh keys appended; the input is untouched. */
  catalog: Catalog;
  /** Keys actually appended, in insertion order. */
  added: string[];
  /** Keys skipped because they already existed, in first-seen order. */
  duplicates: string[];
}

export interface CatalogDiff {
  /** Keys present in `a` but absent from `b`. */
  missing: string[];
  /** Keys present in `b` but absent from `a`. */
  extra: string[];
}

/**
 * Attributes whose quoted values are shown to a user. Everything else -
 * `className`, `data-*`, `aria-*`, `href`, event handlers, arbitrary props -
 * is treated as technical and never flagged.
 */
const USER_FACING_ATTRIBUTES: ReadonlySet<string> = new Set([
  "title",
  "placeholder",
  "label",
  "alt",
  "caption",
  "description",
  "tooltip",
  "subtitle",
  "heading",
  "message",
  "helpertext",
  "emptytext",
  "confirmlabel",
  "cancellabel",
  "buttonlabel",
]);

/** JSX tags and fragments, used to bracket text nodes. */
const JSX_TAG_RE = /<\/?[A-Za-z][^<>]*\/?>|<>|<\/>/g;

/** A single-quoted or double-quoted string on one line. */
const STRING_RE = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** `t(locale, "key")` - the second argument is an already-catalogued key. */
const T_KEY_RE = /(?<![\w$])t\(\s*[^,()]+,\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;

const CSS_UNIT_RE =
  /^[+-]?(\d+|\d*\.\d+)\s*(px|rem|em|ex|ch|vh|vw|vmin|vmax|%|fr|s|ms|deg|rad|turn|pt|pc|cm|mm|in|q)$/i;

const NUMBER_RE = /^[+-]?[\d.,\s]+$/;

const CAMEL_PARTS_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Replace a substring's characters with spaces, keeping newlines. */
function blank(out: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    if (out[i] !== "\n") out[i] = " ";
  }
}

/**
 * Blank comments, template literals and `import`/`export ... from` lines while
 * preserving length (and therefore line numbers). Quoted string contents are
 * deliberately kept - they are the analyser's signal.
 */
function maskSource(source: string): string {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const start = i;
      while (i < n && source[i] !== "\n") i++;
      blank(out, start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i < n) i += 2;
      blank(out, start, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i++;
      while (i < n && source[i] !== "`") {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i < n) i++;
      blank(out, start, i);
      continue;
    }
    i++;
  }
  // Blank `import` / `export ... from` statement lines wholesale.
  let offset = 0;
  for (const line of source.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*(import\b|(export\b[^;]*\bfrom\b))/.test(line)) {
      for (let j = lineStart; j < lineStart + line.length; j++) out[j] = " ";
    }
  }
  return out.join("");
}

/** Replace the contents of balanced `{ ... }` containers with spaces. */
function maskBraced(text: string): string {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out.push(" ");
      if (ch === "\\") {
        out.push(" ");
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (depth > 0) {
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        out.push(" ");
        continue;
      }
      if (ch === "{") {
        depth++;
        out.push(" ");
        continue;
      }
      if (ch === "}") {
        depth--;
        out.push(" ");
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }
    if (ch === "{") {
      depth++;
      out.push(" ");
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isUrl(text: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  if (/^(https?:|mailto:|tel:|data:|blob:)/i.test(text)) return true;
  if (/^\/\//.test(text)) return true;
  if (/^\/\S/.test(text)) return true;
  if (/^\.{1,2}\//.test(text)) return true;
  if (/^#/.test(text)) return true;
  if (/^www\./i.test(text)) return true;
  return false;
}

/**
 * The single place that decides whether a string is worth translating. A
 * candidate must read as prose (letters + at least one space) and must not
 * look like a URL, a CSS unit, a number or a code token.
 */
function isUserFacingString(text: string): boolean {
  if (text.length < 2) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (!/\s/.test(text)) return false;
  if (NUMBER_RE.test(text)) return false;
  if (isUrl(text)) return false;
  if (CSS_UNIT_RE.test(text)) return false;
  if (/[{}]/.test(text)) return false;
  if (/[=;]/.test(text)) return false;
  if (/=>|&&|\|\|/.test(text)) return false;
  if (/^[\w-]+$/.test(text)) return false;
  return true;
}

interface TKeyScan {
  keys: string[];
  ranges: Array<[number, number]>;
}

/** Collect the second argument of every `t(...)` call, in order. */
function collectTranslationKeys(masked: string): TKeyScan {
  const keys: string[] = [];
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];
  T_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = T_KEY_RE.exec(masked)) !== null) {
    const value = match[2];
    const keyStart = match.index + match[0].length - value.length - 3;
    const keyEnd = keyStart + value.length + 2;
    ranges.push([keyStart, keyEnd]);
    if (!seen.has(value)) {
      seen.add(value);
      keys.push(value);
    }
    if (match.index === T_KEY_RE.lastIndex) T_KEY_RE.lastIndex++;
  }
  return { keys, ranges };
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/** Every JSX text node, with the absolute offset of its first character. */
function collectTextNodes(masked: string): Array<{ text: string; index: number }> {
  const nodes: Array<{ text: string; index: number }> = [];
  JSX_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  const tags: Array<{ start: number; end: number }> = [];
  while ((match = JSX_TAG_RE.exec(masked)) !== null) {
    tags.push({ start: match.index, end: match.index + match[0].length });
    if (match.index === JSX_TAG_RE.lastIndex) JSX_TAG_RE.lastIndex++;
  }
  for (let t = 1; t < tags.length; t++) {
    const start = tags[t - 1].end;
    const end = tags[t].start;
    if (end <= start) continue;
    const raw = masked.slice(start, end);
    if (raw.includes("<") || raw.includes(">")) continue;
    const stripped = maskBraced(raw);
    if (!/[A-Za-z]/.test(stripped)) continue;
    let firstNonSpace = -1;
    for (let i = 0; i < stripped.length; i++) {
      if (!/\s/.test(stripped[i])) {
        firstNonSpace = i;
        break;
      }
    }
    if (firstNonSpace < 0) continue;
    nodes.push({ text: normalize(stripped), index: start + firstNonSpace });
  }
  return nodes;
}

/**
 * Find the user-facing strings in `source` that are not yet routed through
 * `t(locale, key)` and are not already catalogue keys.
 */
export function findHardcodedStrings(
  source: string,
  options: ScanOptions,
): HardcodedString[] {
  const masked = maskSource(source);
  const catalogKeys = new Set(options.catalogKeys ?? []);
  const { ranges } = collectTranslationKeys(masked);
  const found: Array<HardcodedString & { index: number }> = [];

  // JSX text nodes.
  for (const node of collectTextNodes(masked)) {
    if (!isUserFacingString(node.text)) continue;
    if (catalogKeys.has(node.text)) continue;
    found.push({
      text: node.text,
      line: lineAt(source, node.index),
      kind: "text",
      index: node.index,
    });
  }

  // Quoted user-facing attributes.
  STRING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRING_RE.exec(masked)) !== null) {
    if (match.index === STRING_RE.lastIndex) STRING_RE.lastIndex++;
    const value = match[2];
    const quoteStart = match.index;
    const quoteEnd = match.index + match[0].length;
    if (overlaps(ranges, quoteStart, quoteEnd)) continue;
    const before = masked.slice(Math.max(0, match.index - 80), match.index);
    const attribute = /([A-Za-z_][\w-]*)\s*=\s*$/.exec(before);
    if (!attribute) continue;
    const name = attribute[1];
    if (!USER_FACING_ATTRIBUTES.has(name.toLowerCase())) continue;
    const text = normalize(value);
    if (!isUserFacingString(text)) continue;
    if (catalogKeys.has(text)) continue;
    found.push({
      text,
      line: lineAt(source, quoteStart),
      kind: "attribute",
      attribute: name,
      index: quoteStart,
    });
  }

  found.sort((a, b) => a.index - b.index);
  return found.map(({ index: _index, ...hit }) => hit);
}

/** Split text into camelCase-aware words, honouring digits and acronyms. */
function splitWords(input: string): string[] {
  const cleaned = input.replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (cleaned === "") return [];
  const words: string[] = [];
  for (const token of cleaned.split(/\s+/)) {
    const parts = token.match(CAMEL_PARTS_RE);
    if (parts) words.push(...parts);
    else words.push(token);
  }
  return words;
}

/**
 * Propose a stable camelCase catalogue key for a user-facing string. The
 * result is deterministic and idempotent: feeding it back in yields the same
 * key.
 */
export function suggestKey(text: string, options: SuggestKeyOptions = {}): string {
  const words = [...splitWords(options.surface ?? ""), ...splitWords(text)];
  if (words.length === 0) return "key";
  const first = words[0].toLowerCase();
  const rest = words
    .slice(1)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  const key = first + rest.join("");
  if (/^[A-Za-z]/.test(key)) return key;
  return "key" + key.charAt(0).toUpperCase() + key.slice(1);
}

/** The catalogue surface a file belongs to: its camelCased basename. */
function fileSurface(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return suggestKey(base.replace(/\.[^.]+$/, ""));
}

function coverageOf(existing: number, found: number): number {
  const total = existing + found;
  return total === 0 ? 1 : existing / total;
}

/**
 * Run the analyser over a batch of files and add the per-file suggestion plus
 * a whole-batch total. A file with nothing to translate is 100% covered.
 */
export function buildExtractionReport(
  files: readonly SourceFile[],
  options: { catalogKeys?: readonly string[] } = {},
): ExtractionReport {
  const reports: FileReport[] = [];
  let totalFound = 0;
  let totalExisting = 0;
  for (const file of files) {
    const hits = findHardcodedStrings(file.source, {
      filePath: file.path,
      catalogKeys: options.catalogKeys,
    });
    const { keys: existingKeysUsed } = collectTranslationKeys(maskSource(file.source));
    const surface = fileSurface(file.path);
    const found = hits.map((hit) => ({
      text: hit.text,
      line: hit.line,
      suggestion: suggestKey(hit.text, { surface }),
    }));
    reports.push({
      file: file.path,
      found,
      existingKeysUsed,
      coverage: coverageOf(existingKeysUsed.length, found.length),
    });
    totalFound += found.length;
    totalExisting += existingKeysUsed.length;
  }
  return {
    files: reports,
    totals: {
      found: totalFound,
      existingKeysUsed: totalExisting,
      coverage: coverageOf(totalExisting, totalFound),
    },
  };
}

/**
 * Append new keys to a catalogue for every locale, preserving existing order.
 * A locale that has no translation falls back to English; a key that already
 * exists (or repeats within the batch) is reported as a duplicate and skipped
 * rather than overwriting anything. The input catalogue is never mutated.
 */
export function mergeIntoCatalog(
  catalog: Catalog,
  entries: readonly CatalogEntry[],
  locales: readonly string[],
): MergeResult {
  const result: Catalog = {};
  for (const [locale, dict] of Object.entries(catalog)) {
    result[locale] = { ...dict };
  }
  for (const locale of locales) {
    if (!result[locale]) result[locale] = {};
  }
  const existing = new Set<string>();
  for (const dict of Object.values(result)) {
    for (const key of Object.keys(dict)) existing.add(key);
  }

  const added: string[] = [];
  const duplicates: string[] = [];
  const seenDuplicates = new Set<string>();
  for (const entry of entries) {
    if (existing.has(entry.key)) {
      if (!seenDuplicates.has(entry.key)) {
        seenDuplicates.add(entry.key);
        duplicates.push(entry.key);
      }
      continue;
    }
    const fallback =
      entry.values.en ?? entry.values[locales[0] ?? "en"] ?? entry.key;
    for (const locale of locales) {
      const dict = result[locale] ?? (result[locale] = {});
      dict[entry.key] = entry.values[locale] ?? fallback;
    }
    existing.add(entry.key);
    added.push(entry.key);
  }
  return { catalog: result, added, duplicates };
}

/**
 * Compare two catalogue revisions, reporting the keys each locale is missing
 * (present in `a`, absent from `b`) and the extra keys it gained (present in
 * `b`, absent from `a`). Locales are visited in first-seen order.
 */
export function diffCatalog(a: Catalog, b: Catalog): Record<string, CatalogDiff> {
  const locales: string[] = [];
  for (const locale of Object.keys(a)) locales.push(locale);
  for (const locale of Object.keys(b)) {
    if (!locales.includes(locale)) locales.push(locale);
  }
  const diff: Record<string, CatalogDiff> = {};
  for (const locale of locales) {
    const aKeys = Object.keys(a[locale] ?? {});
    const bKeys = Object.keys(b[locale] ?? {});
    const aSet = new Set(aKeys);
    const bSet = new Set(bKeys);
    diff[locale] = {
      missing: aKeys.filter((key) => !bSet.has(key)),
      extra: bKeys.filter((key) => !aSet.has(key)),
    };
  }
  return diff;
}
