/**
 * Formula result caching (matrix `:328`, open question O22.1) — a pure,
 * dependency-aware value cache keyed by `(expression, property values)`.
 *
 * A formula result is a function of the expression text and the values of the
 * properties it reads. This module keeps that contract explicit:
 *
 *  - `dependenciesOf` runs a small lexical scan (not the evaluator's parser) and
 *    returns the distinct property names an expression references — either
 *    through the canonical `prop("Name")` call or as a bare identifier (the
 *    engine resolves those against the row scope too).
 *  - `formulaCacheKey` builds a stable key from the expression plus *only* the
 *    values of the properties it depends on, so unrelated properties on the
 *    same row never cost a cache hit.
 *  - `getCached` / `setCached` read and write results; every write returns a new
 *    cache and never mutates the one it was given.
 *  - `invalidateByProperty(property)` drops exactly the entries that depend on a
 *    property and `invalidateAll` empties the cache — neither leaves stale
 *    bookkeeping behind.
 *
 * `undefined` is a legal cached value; use `hasCached` to tell a hit apart from
 * a miss. Property identities are compared case-insensitively (mirroring the
 * engine's `prop()` lookup) and values must be JSON-serializable.
 */

/** Row values the cache keys against: property name → value. */
export type PropertyValues = Record<string, unknown>;

/** One cached result plus the dependency set that produced it. */
export type CacheEntry<T> = {
  /** The expression the result was computed from. */
  readonly expression: string;
  /** The cached result. */
  readonly value: T;
  /** Property names the expression reads (see `dependenciesOf`). */
  readonly dependencies: readonly string[];
};

/**
 * An immutable cache value. `dependents` is the derived inverted index from a
 * lowercased property name to the keys of the entries that reference it.
 */
export type FormulaCache<T = unknown> = {
  readonly entries: ReadonlyMap<string, CacheEntry<T>>;
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Bare words the engine resolves itself — never property references. */
const RESERVED_IDENTIFIERS = new Set(["true", "false", "now", "today"]);

/** A lexical token: enough structure to find references, nothing more. */
type ScanToken =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

/**
 * Split an expression into identifiers, string literals and single-character
 * punctuation; whitespace is dropped. Deliberately smaller than the engine's
 * tokenizer — it tolerates malformed input (e.g. an unterminated string) rather
 * than throwing.
 */
function scan(expression: string): ScanToken[] {
  const tokens: ScanToken[] = [];
  let i = 0;
  while (i < expression.length) {
    const char = expression[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      let value = "";
      while (j < expression.length && expression[j] !== quote) {
        if (expression[j] === "\\" && j + 1 < expression.length) {
          value += expression[j + 1];
          j += 2;
          continue;
        }
        value += expression[j];
        j += 1;
      }
      tokens.push({ kind: "string", value });
      i = j < expression.length ? j + 1 : j;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i + 1;
      while (j < expression.length && /[A-Za-z0-9_]/.test(expression[j])) j += 1;
      tokens.push({ kind: "ident", value: expression.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: char });
    i += 1;
  }
  return tokens;
}

/**
 * The distinct property names an expression references, sorted
 * case-insensitively (ties keep the spelling the expression used first).
 *
 * Both reference forms are recognised: the canonical `prop("Name")` call and
 * bare identifiers (`Estimate * 2`), which the engine also resolves against the
 * row scope. Function calls and reserved bare words (`true`, `false`, `now`,
 * `today`) are not references, and text inside string literals is ignored. The
 * scan is an over-approximation: a bare name that turns out to be unrelated only
 * ever causes extra invalidation, never a stale hit.
 */
export function dependenciesOf(expression: string): string[] {
  const tokens = scan(expression);
  const names = new Map<string, string>(); // lowercased → first-seen spelling
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "ident") continue;
    const next = tokens[i + 1];
    const isCall = next !== undefined && next.kind === "punct" && next.value === "(";
    if (isCall) {
      if (token.value.toLowerCase() !== "prop") continue;
      const argument = tokens[i + 2];
      if (argument === undefined || argument.kind !== "string" || argument.value.length === 0) {
        continue;
      }
      const argumentLower = argument.value.toLowerCase();
      if (!names.has(argumentLower)) names.set(argumentLower, argument.value);
      continue;
    }
    const lower = token.value.toLowerCase();
    if (RESERVED_IDENTIFIERS.has(lower)) continue;
    if (!names.has(lower)) names.set(lower, token.value);
  }
  return [...names.values()].sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** The key in `values` matching `name` case-insensitively, or `undefined`. */
function findValueKey(values: PropertyValues, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(values).find((key) => key.toLowerCase() === lower);
}

/** Build the stable key from a known dependency list (avoids a second scan). */
function keyFor(
  expression: string,
  dependencies: readonly string[],
  values: PropertyValues,
): string {
  const relevant = dependencies.map((dependency) => {
    const key = findValueKey(values, dependency);
    return key === undefined ? [dependency, 0] : [dependency, 1, values[key]];
  });
  return JSON.stringify([expression, relevant]);
}

/**
 * A stable key for `(expression, values)`. Only the values of the properties the
 * expression depends on are folded in, so an unrelated property on the row can
 * never change the key. A missing value is encoded distinctly from a present
 * `undefined` one.
 */
export function formulaCacheKey(expression: string, values: PropertyValues = {}): string {
  return keyFor(expression, dependenciesOf(expression), values);
}

/** An empty cache. */
export function createFormulaCache<T = unknown>(): FormulaCache<T> {
  return { entries: new Map<string, CacheEntry<T>>(), dependents: new Map<string, Set<string>>() };
}

/** Number of cached results. */
export function cacheSize<T>(cache: FormulaCache<T>): number {
  return cache.entries.size;
}

/** Register `key` under `property` in an inverted index. */
function addDependent(
  dependents: Map<string, Set<string>>,
  property: string,
  key: string,
): void {
  const lower = property.toLowerCase();
  const bucket = dependents.get(lower);
  if (bucket) bucket.add(key);
  else dependents.set(lower, new Set([key]));
}

/** Remove `key` from `property`'s bucket, dropping the bucket once it is empty. */
function dropDependent(
  dependents: Map<string, Set<string>>,
  property: string,
  key: string,
): void {
  const lower = property.toLowerCase();
  const bucket = dependents.get(lower);
  if (!bucket) return;
  bucket.delete(key);
  if (bucket.size === 0) dependents.delete(lower);
}

/**
 * Store `value` for `(expression, values)` and return a new cache. Re-setting an
 * existing key replaces its value; the cache argument is never mutated.
 */
export function setCached<T>(
  cache: FormulaCache<T>,
  expression: string,
  values: PropertyValues,
  value: T,
): FormulaCache<T> {
  const dependencies = dependenciesOf(expression);
  const key = keyFor(expression, dependencies, values);
  const entries = new Map(cache.entries);
  const previous = entries.get(key);
  entries.set(key, { expression, value, dependencies });
  const dependents = new Map<string, Set<string>>();
  for (const [property, bucket] of cache.dependents) dependents.set(property, new Set(bucket));
  if (previous) {
    for (const dependency of previous.dependencies) dropDependent(dependents, dependency, key);
  }
  for (const dependency of dependencies) addDependent(dependents, dependency, key);
  return { entries, dependents };
}

/** The cached value for `(expression, values)`, or `undefined` on a miss. */
export function getCached<T>(
  cache: FormulaCache<T>,
  expression: string,
  values: PropertyValues = {},
): T | undefined {
  return cache.entries.get(keyFor(expression, dependenciesOf(expression), values))?.value;
}

/** Whether `(expression, values)` is cached — tells a cached `undefined` from a miss. */
export function hasCached<T>(
  cache: FormulaCache<T>,
  expression: string,
  values: PropertyValues = {},
): boolean {
  return cache.entries.has(keyFor(expression, dependenciesOf(expression), values));
}

/**
 * Drop every entry whose expression references `property` (matched
 * case-insensitively, surrounding whitespace ignored). Returns the same cache
 * unchanged when nothing depends on it.
 */
export function invalidateByProperty<T>(
  cache: FormulaCache<T>,
  property: string,
): FormulaCache<T> {
  const keys = cache.dependents.get(property.trim().toLowerCase());
  if (!keys || keys.size === 0) return cache;
  const entries = new Map(cache.entries);
  const dependents = new Map<string, Set<string>>();
  for (const [property, bucket] of cache.dependents) dependents.set(property, new Set(bucket));
  for (const key of keys) {
    const entry = entries.get(key);
    entries.delete(key);
    if (!entry) continue;
    for (const dependency of entry.dependencies) dropDependent(dependents, dependency, key);
  }
  return { entries, dependents };
}

/** Discard every cached result. */
export function invalidateAll<T>(cache: FormulaCache<T>): FormulaCache<T> {
  if (cache.entries.size === 0 && cache.dependents.size === 0) return cache;
  return createFormulaCache<T>();
}
