import { describe, expect, it } from "vitest";
import {
  buildPageInfo,
  clampLimit,
  decodeCursor,
  encodeCursor,
  malformedCursorResult,
  paginateSlice,
  type CursorPayload,
  type PaginateResult,
} from "@/lib/cursor-pagination";

type Row = { id: string; rank: number };

const rowKey = (row: Row): CursorPayload => ({ key: row.rank, tiebreaker: row.id });

/** 10 rows, ranks 1..10, ids a..j — a stable fixture for walk tests. */
const ROWS: Row[] = "abcdefghij"
  .split("")
  .map((id, index) => ({ id, rank: index + 1 }));

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a string-keyed payload", () => {
    const payload: CursorPayload = { key: "2026-01-02T00:00:00.000Z", tiebreaker: "row-1" };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("round-trips a numeric key", () => {
    const payload: CursorPayload = { key: 42, tiebreaker: "row-7" };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("emits an opaque base64url token (no +, / or = padding)", () => {
    const token = encodeCursor({ key: "some/value+with", tiebreaker: "x?y" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("produces distinct tokens for distinct payloads", () => {
    expect(encodeCursor({ key: 1, tiebreaker: "a" })).not.toBe(
      encodeCursor({ key: 1, tiebreaker: "b" }),
    );
    expect(encodeCursor({ key: 1, tiebreaker: "a" })).not.toBe(
      encodeCursor({ key: 2, tiebreaker: "a" }),
    );
  });
});

describe("decodeCursor (invalid input never throws)", () => {
  it("returns null for empty / falsy tokens", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(null as unknown as string)).toBeNull();
    expect(decodeCursor(undefined as unknown as string)).toBeNull();
  });

  it("returns null for garbage that is not base64url", () => {
    expect(decodeCursor("not a cursor!!")).toBeNull();
    expect(decodeCursor("!!!!")).toBeNull();
  });

  it("returns null for valid base64 that is not JSON", () => {
    const token = Buffer.from("hello world", "utf8").toString("base64url");
    expect(() => decodeCursor(token)).not.toThrow();
    expect(decodeCursor(token)).toBeNull();
  });

  it("returns null for valid JSON of the wrong shape", () => {
    const asToken = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(decodeCursor(asToken([1, 2]))).toBeNull();
    expect(decodeCursor(asToken("hi"))).toBeNull();
    expect(decodeCursor(asToken(123))).toBeNull();
    expect(decodeCursor(asToken(null))).toBeNull();
    expect(decodeCursor(asToken({ key: "a" }))).toBeNull();
    expect(decodeCursor(asToken({ key: null, tiebreaker: "t" }))).toBeNull();
    expect(decodeCursor(asToken({ key: {}, tiebreaker: "t" }))).toBeNull();
    expect(decodeCursor(asToken({ key: "a", tiebreaker: 3 }))).toBeNull();
    expect(decodeCursor(asToken({ key: "a", tiebreaker: null }))).toBeNull();
  });

  it("drops unknown fields and keeps the validated tuple", () => {
    const token = Buffer.from(
      JSON.stringify({ key: 7, tiebreaker: "z", injected: true }),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(token)).toEqual({ key: 7, tiebreaker: "z" });
  });
});

describe("clampLimit", () => {
  it("applies the default bounds and fallback", () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit(null)).toBe(25);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-10)).toBe(1);
    expect(clampLimit(1000)).toBe(100);
    expect(clampLimit(50)).toBe(50);
  });

  it("honours custom bounds", () => {
    const opts = { min: 5, max: 10, fallback: 7 };
    expect(clampLimit(undefined, opts)).toBe(7);
    expect(clampLimit(1, opts)).toBe(5);
    expect(clampLimit(99, opts)).toBe(10);
    expect(clampLimit(8, opts)).toBe(8);
  });

  it("coerces numeric strings, floors fractions, and falls back on junk", () => {
    expect(clampLimit("42")).toBe(42);
    expect(clampLimit("abc")).toBe(25);
    expect(clampLimit("")).toBe(25);
    expect(clampLimit(Number.NaN)).toBe(25);
    expect(clampLimit(3.9)).toBe(3);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("paginateSlice", () => {
  it("returns the first page descending by default", () => {
    const page = paginateSlice(ROWS, { limit: 3, keyOf: rowKey });
    expect(page.items.map((r) => r.rank)).toEqual([10, 9, 8]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ key: 8, tiebreaker: "h" });
  });

  it("walks every page with no skips or duplicates", () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: PaginateResult<Row> = paginateSlice(ROWS, { limit: 3, cursor, keyOf: rowKey });
      seen.push(...page.items.map((r) => r.rank));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(4);
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(seen).size).toBe(ROWS.length);
  });

  it("honours an exact boundary without re-reading the cursor row", () => {
    const first = paginateSlice(ROWS, { limit: 5, keyOf: rowKey });
    const second = paginateSlice(ROWS, {
      limit: 5,
      cursor: first.nextCursor,
      keyOf: rowKey,
    });
    expect(first.items.map((r) => r.rank)).toEqual([10, 9, 8, 7, 6]);
    expect(second.items.map((r) => r.rank)).toEqual([5, 4, 3, 2, 1]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("reports hasMore=false and a null cursor on the last page", () => {
    const page = paginateSlice(ROWS, { limit: 100, keyOf: rowKey });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("orders equal keys by a stable tiebreaker", () => {
    const tied: Row[] = [
      { id: "b", rank: 5 },
      { id: "a", rank: 5 },
      { id: "c", rank: 5 },
    ];
    const asc = paginateSlice(tied, { limit: 2, direction: "asc", keyOf: rowKey });
    expect(asc.items.map((r) => r.id)).toEqual(["a", "b"]);
    const rest = paginateSlice(tied, {
      limit: 2,
      direction: "asc",
      cursor: asc.nextCursor,
      keyOf: rowKey,
    });
    expect(rest.items.map((r) => r.id)).toEqual(["c"]);
    expect(rest.hasMore).toBe(false);
  });

  it("supports ascending direction", () => {
    const page = paginateSlice(ROWS, { limit: 3, direction: "asc", keyOf: rowKey });
    expect(page.items.map((r) => r.rank)).toEqual([1, 2, 3]);
    const next = paginateSlice(ROWS, {
      limit: 3,
      direction: "asc",
      cursor: page.nextCursor,
      keyOf: rowKey,
    });
    expect(next.items.map((r) => r.rank)).toEqual([4, 5, 6]);
  });

  it("returns an empty page for an empty list", () => {
    const page = paginateSlice([], { limit: 25, keyOf: rowKey });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("fails closed to an empty page on a malformed cursor", () => {
    const page = paginateSlice(ROWS, { limit: 3, cursor: "not-a-cursor", keyOf: rowKey });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("clamps the requested limit", () => {
    const page = paginateSlice(ROWS, { limit: 0, keyOf: rowKey });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});

describe("buildPageInfo", () => {
  it("summarises a page for the wire", () => {
    const page = paginateSlice(ROWS, { limit: 3, keyOf: rowKey });
    expect(buildPageInfo(page, 3)).toEqual({
      limit: 3,
      returned: 3,
      hasMore: true,
      nextCursor: page.nextCursor,
    });
  });

  it("normalises a missing cursor to null", () => {
    expect(
      buildPageInfo({ items: [], hasMore: false, nextCursor: undefined as unknown as null }, 25),
    ).toEqual({ limit: 25, returned: 0, hasMore: false, nextCursor: null });
  });
});

describe("malformedCursorResult", () => {
  it("returns the typed invalid_cursor error", () => {
    expect(malformedCursorResult()).toEqual({ ok: false, error: "invalid_cursor" });
    expect(malformedCursorResult()).not.toBe(malformedCursorResult());
  });
});
