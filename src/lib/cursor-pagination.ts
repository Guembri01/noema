/**
 * Keyset (cursor) pagination primitives — the pure reference implementation
 * behind "Pagination everywhere" (docs/MISSING_FEATURES.md §9) and the public
 * API's Notion-dialect `page_size` / `start_cursor` contract
 * (docs/specs/integrations-api.md §2.5, R24.1–R24.5).
 *
 * A cursor is an opaque, URL-safe `base64url(JSON)` token over a **sort tuple**
 * `{ key, tiebreaker }`: `key` is the primary sort value (a position, an ISO
 * timestamp, an id, …) and `tiebreaker` disambiguates equal keys so the total
 * order never shifts under writes. Nothing about the token is meaningful to
 * clients — encode/decode it and treat it as opaque.
 *
 * Everything here is pure and in-memory: no DB, no routes, no React. Server
 * code (list queries/routes) is expected to feed rows through `paginateSlice`
 * for reference, or mirror its comparison against the database.
 */

/** A comparable sort value: a number (position, rank) or a string (id, ISO date). */
export type CursorKey = string | number;

/** The decoded sort tuple a cursor carries. */
export type CursorPayload = {
  /** Primary sort value of the row the cursor points at. */
  key: CursorKey;
  /** Deterministic tie-break for equal `key`s (typically the row id). */
  tiebreaker: string;
};

/** Sort direction; descending (newest / largest first) is the default. */
export type Direction = "asc" | "desc";

/** The metadata every page exposes to the wire layer. */
export type PageInfo = {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
};

/** The outcome of `paginateSlice`, generic over the row type. */
export type PaginateResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** Notion-dialect error body for a malformed / foreign cursor (HTTP 400). */
export type CursorError = { ok: false; error: "invalid_cursor" };

type ClampOptions = {
  min?: number;
  max?: number;
  fallback?: number;
};

const isCursorKey = (value: unknown): value is CursorKey =>
  (typeof value === "string") || (typeof value === "number" && Number.isFinite(value));

/**
 * Encode a sort tuple into an opaque base64url token. The JSON is UTF-8 and the
 * `base64url` alphabet is already URL-safe and unpadded, so the token drops
 * cleanly into `?start_cursor=…`.
 */
export function encodeCursor(payload: CursorPayload): string {
  const body = JSON.stringify({ key: payload.key, tiebreaker: payload.tiebreaker });
  return Buffer.from(body, "utf8").toString("base64url");
}

/**
 * Decode a cursor token back into its sort tuple. **Never throws**: an empty,
 * truncated, non-base64, non-JSON or wrong-shaped token simply yields `null`,
 * so callers can map that to `malformedCursorResult()` without a try/catch.
 * Unknown extra fields are ignored and only the validated tuple is returned.
 */
export function decodeCursor(token: string): CursorPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { key, tiebreaker } = parsed as Record<string, unknown>;
  if (!isCursorKey(key)) return null;
  if (typeof tiebreaker !== "string") return null;
  return { key, tiebreaker };
}

/**
 * Clamp a requested page size into `[min, max]`, falling back when the value is
 * missing or not numeric (`undefined`, `null`, `NaN`, `"abc"`, `""`). Fractional
 * values are floored, `±Infinity` clamps to the nearest bound. Defaults mirror
 * the public API: 1..100 with a 25-row fallback (R24.1).
 */
export function clampLimit(limit: unknown, options: ClampOptions = {}): number {
  const min = options.min ?? 1;
  const max = options.max ?? 100;
  const fallback = options.fallback ?? 25;

  const raw = typeof limit === "string" ? limit.trim() : limit;
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return min;

  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/** Compare two sort keys. Numbers compare numerically; anything mixed compares as strings. */
function compareKeys(a: CursorKey, b: CursorKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Total order over sort tuples: primary key, then tiebreaker. */
function comparePayloads(a: CursorPayload, b: CursorPayload): number {
  const byKey = compareKeys(a.key, b.key);
  if (byKey !== 0) return byKey;
  if (a.tiebreaker < b.tiebreaker) return -1;
  if (a.tiebreaker > b.tiebreaker) return 1;
  return 0;
}

/**
 * Slice an in-memory list into one keyset page.
 *
 * Rows are ordered by the tuple from `keyOf` in `direction` (default `"desc"`).
 * When a `cursor` is supplied the page starts at the first row that sorts
 * **strictly after** the cursor tuple in that direction — for `"asc"` the key
 * is strictly greater than the cursor key, for `"desc"` strictly less — so the
 * boundary row itself is never repeated and never skipped. The tiebreaker makes
 * that strict comparison total even when keys collide.
 *
 * `nextCursor` is the encoded tuple of the last emitted row and is `null`
 * exactly when `hasMore` is `false`. A cursor that fails to decode fails
 * closed: an empty page with `hasMore: false` (call `malformedCursorResult()`
 * for the matching 400 body).
 */
export function paginateSlice<T>(
  items: readonly T[],
  options: {
    limit?: number;
    cursor?: string | null;
    keyOf: (item: T) => CursorPayload;
    direction?: Direction;
  },
): PaginateResult<T> {
  const limit = clampLimit(options.limit);
  const direction: Direction = options.direction ?? "desc";
  const sign = direction === "asc" ? 1 : -1;
  const keyOf = options.keyOf;

  let after: readonly T[] = items;
  if (options.cursor !== null && options.cursor !== undefined && options.cursor !== "") {
    const cursor = decodeCursor(options.cursor);
    if (cursor === null) return { items: [], nextCursor: null, hasMore: false };
    after = items.filter((item) => comparePayloads(keyOf(item), cursor) * sign > 0);
  }

  const ordered = [...after].sort((a, b) => comparePayloads(keyOf(a), keyOf(b)) * sign);
  const hasMore = ordered.length > limit;
  const page = hasMore ? ordered.slice(0, limit) : ordered;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null;
  return { items: page, nextCursor, hasMore };
}

/**
 * Turn a page result into the compact metadata block the API returns alongside
 * its item key (`has_more` / `next_cursor` are the cross-boundary equivalents,
 * R24.2). A missing `nextCursor` is normalised to `null`.
 */
export function buildPageInfo<T>(
  page: { items: readonly T[]; hasMore: boolean; nextCursor?: string | null },
  limit: number,
): PageInfo {
  return {
    limit,
    returned: page.items.length,
    hasMore: Boolean(page.hasMore),
    nextCursor: page.nextCursor ?? null,
  };
}

/** The Notion-dialect 400 body for a cursor that is malformed or foreign. */
export function malformedCursorResult(): CursorError {
  return { ok: false, error: "invalid_cursor" };
}
