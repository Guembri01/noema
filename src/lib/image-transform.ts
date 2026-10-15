/**
 * Image transform URL params — the pure query-string contract behind a
 * resize/format CDN (FEATURE_MATRIX "Image transform").
 *
 * An image block/cover can ask the storage layer for a derived rendition
 * instead of the original bytes: a target width/height, how to fit a box, an
 * output format and a quality. Those knobs travel as **signed-free** query
 * params (`w`,`h`,`fit`,`format`,`q`) — no token/signature is ever appended
 * here, so a transform URL is a plain, cacheable, deterministic string. The
 * actual re-encoding and the signed/private variants are the caller's job;
 * this module only owns the URL shape (LOOP_PLAYBOOK: new logic starts as a
 * lib, so vitest owns it).
 *
 * Contract:
 * - `buildTransformQuery` returns the params in a fixed order (`w`,`h`,`fit`,
 *   `format`,`q`), at most one of each — any transform params already on the
 *   `path` are dropped and replaced, while unrelated params are preserved.
 * - Numbers are rounded and clamped into range; wrong-typed, non-finite,
 *   non-positive and unknown-enum values are silently ignored ("validate
 *   ranges; ignore invalid") rather than throwing or emitting `NaN`.
 * - `parseTransformQuery` is the inverse: it normalises the same way, so
 *   `parse(build(options))` equals the normalised `options`. Duplicate keys
 *   resolve to the first *valid* occurrence.
 * - `stripTransform` removes transform params from any URL and leaves the
 *   path, unrelated params and hash intact. Everything is deterministic and
 *   never mutates its inputs.
 */

/** How a source image fills its target box (CSS `object-fit` vocabulary). */
export type Fit = "cover" | "contain" | "fill";

/** Output encoding; `auto` lets the CDN pick from the `Accept` header. */
export type Format = "webp" | "jpeg" | "png" | "auto";

/** The normalized transform knobs. Every field is optional. */
export type TransformOptions = {
  w?: number;
  h?: number;
  fit?: Fit;
  format?: Format;
  quality?: number;
};

/** Where a transform URL points: an asset root plus the object's path. */
export type TransformTarget = {
  baseUrl: string;
  path: string;
};

/** Smallest accepted dimension; a zero/negative axis is meaningless. */
export const MIN_DIMENSION = 1;

/** Largest accepted dimension — a safety cap so a bad caller can't ask for a
 * multi-gigapixel rendition. Values above this clamp down rather than error. */
export const MAX_DIMENSION = 8192;

/** Lowest accepted quality; below this the encoding is pointless. */
export const MIN_QUALITY = 1;

/** Highest accepted quality (lossless-ish for jpeg/webp). */
export const MAX_QUALITY = 100;

/** Canonical query keys, in the order they are always emitted. */
export const TRANSFORM_PARAM_ORDER = ["w", "h", "fit", "format", "q"] as const;

/** One of the canonical transform keys. */
export type TransformParam = (typeof TRANSFORM_PARAM_ORDER)[number];

const TRANSFORM_PARAMS: ReadonlySet<string> = new Set(TRANSFORM_PARAM_ORDER);

function isFit(value: unknown): value is Fit {
  return value === "cover" || value === "contain" || value === "fill";
}

function isFormat(value: unknown): value is Format {
  return value === "webp" || value === "jpeg" || value === "png" || value === "auto";
}

/** Round a positive dimension to whole pixels and clamp to the max; anything
 * non-finite, non-positive or rounding below the minimum is ignored. */
function normalizeDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_DIMENSION) return undefined;
  return Math.min(rounded, MAX_DIMENSION);
}

/** Round quality to a whole percent and clamp to `1..100`; non-finite or
 * rounding below the minimum is ignored. */
function normalizeQuality(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_QUALITY) return undefined;
  return Math.min(rounded, MAX_QUALITY);
}

/** Validate + clamp an options bag, dropping every unusable field. */
function normalizeOptions(options: TransformOptions): TransformOptions {
  const normalized: TransformOptions = {};
  const w = normalizeDimension(options.w);
  if (w !== undefined) normalized.w = w;
  const h = normalizeDimension(options.h);
  if (h !== undefined) normalized.h = h;
  if (isFit(options.fit)) normalized.fit = options.fit;
  if (isFormat(options.format)) normalized.format = options.format;
  const quality = normalizeQuality(options.quality);
  if (quality !== undefined) normalized.quality = quality;
  return normalized;
}

/** Serialize normalized options to canonical, already-escaped key/value pairs. */
function paramPairs(options: TransformOptions): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (options.w !== undefined) pairs.push(["w", String(options.w)]);
  if (options.h !== undefined) pairs.push(["h", String(options.h)]);
  if (options.fit !== undefined) pairs.push(["fit", options.fit]);
  if (options.format !== undefined) pairs.push(["format", options.format]);
  if (options.quality !== undefined) pairs.push(["q", String(options.quality)]);
  return pairs;
}

/** Join an asset root and a relative path with exactly one slash. */
function joinBase(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.replace(/^\/+/, "");
  if (base === "") return baseUrl.startsWith("/") ? `/${rel}` : rel;
  return `${base}/${rel}`;
}

/** Split a URL into its path, raw query and hash (`''` when absent). */
function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return { base: withoutHash, query: "", hash };
  return {
    base: withoutHash.slice(0, queryIndex),
    query: withoutHash.slice(queryIndex + 1),
    hash,
  };
}

/** Percent-decode a key/value, tolerating malformed escapes. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type RawPair = { raw: string; key: string; value: string };

/** Split a raw query string into decoded key/value pairs, keeping the raw
 * entry so unrelated params round-trip verbatim. Empty segments are dropped. */
function queryPairs(query: string): RawPair[] {
  if (query === "") return [];
  return query
    .split("&")
    .filter((raw) => raw !== "")
    .map((raw) => {
      const eq = raw.indexOf("=");
      const rawKey = eq < 0 ? raw : raw.slice(0, eq);
      const rawValue = eq < 0 ? "" : raw.slice(eq + 1);
      return { raw, key: safeDecode(rawKey), value: safeDecode(rawValue) };
    });
}

/**
 * Build a signed-free transform URL for `target`, with `options` normalized
 * into canonical order. Transform params already present on `target.path` are
 * replaced (so the result never carries a duplicate), while unrelated params
 * (e.g. a cache-buster `v`) are preserved. Returns `baseUrl`/`path` joined
 * with a single slash, and no `?` when there is nothing to append.
 */
export function buildTransformQuery(options: TransformOptions, target: TransformTarget): string {
  const queryIndex = target.path.indexOf("?");
  const pathname = queryIndex >= 0 ? target.path.slice(0, queryIndex) : target.path;
  const existing = queryIndex >= 0 ? target.path.slice(queryIndex + 1) : "";

  const kept = queryPairs(existing)
    .filter((pair) => !TRANSFORM_PARAMS.has(pair.key))
    .map((pair) => pair.raw);
  const transformed = paramPairs(normalizeOptions(options)).map(([key, value]) => `${key}=${value}`);
  const params = [...kept, ...transformed];

  const base = joinBase(target.baseUrl, pathname);
  return params.length > 0 ? `${base}?${params.join("&")}` : base;
}

/**
 * Parse a URL's transform params into normalised options — the inverse of
 * {@link buildTransformQuery}. Unknown keys and invalid values are ignored;
 * numbers are rounded and clamped; the hash is ignored. When a key repeats,
 * the first *valid* occurrence wins (dedupe). Returns `{}` for a URL with no
 * usable transform params.
 */
export function parseTransformQuery(url: string): TransformOptions {
  const pairs = queryPairs(splitUrl(url).query);
  const result: TransformOptions = {};
  const seen = new Set<string>();

  for (const pair of pairs) {
    if (!TRANSFORM_PARAMS.has(pair.key) || seen.has(pair.key)) continue;

    if (pair.key === "fit") {
      if (isFit(pair.value)) {
        result.fit = pair.value;
        seen.add("fit");
      }
    } else if (pair.key === "format") {
      if (isFormat(pair.value)) {
        result.format = pair.value;
        seen.add("format");
      }
    } else if (pair.key === "q") {
      const quality = normalizeQuality(Number(pair.value));
      if (quality !== undefined) {
        result.quality = quality;
        seen.add("q");
      }
    } else {
      const dimension = normalizeDimension(Number(pair.value));
      if (dimension !== undefined) {
        if (pair.key === "w") result.w = dimension;
        else result.h = dimension;
        seen.add(pair.key);
      }
    }
  }

  return result;
}

/**
 * Remove transform params (`w`,`h`,`fit`,`format`,`q`) from any URL, keeping
 * the path, unrelated params, their original encoding and the hash. Drops the
 * query delimiter when nothing is left, and is idempotent.
 */
export function stripTransform(url: string): string {
  const { base, query, hash } = splitUrl(url);
  const kept = queryPairs(query)
    .filter((pair) => !TRANSFORM_PARAMS.has(pair.key))
    .map((pair) => pair.raw);
  const suffix = kept.length > 0 ? `?${kept.join("&")}` : "";
  return `${base}${suffix}${hash}`;
}
