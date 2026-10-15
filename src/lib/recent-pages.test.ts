import { describe, expect, it } from "vitest";
import {
  clearRecent,
  DEFAULT_HALF_LIFE_MS,
  MAX_RECENT_PAGES,
  mergeRecent,
  recentPages,
  recencyScore,
  recordVisit,
  removePage,
  type RecentPage,
} from "./recent-pages";

/**
 * Recently viewed pages — the pure, deterministic core behind the sidebar
 * "Recent" section.
 *
 * Red-first: `src/lib/recent-pages.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helper lands.
 * Every function takes the clock as an argument (`now`), so the ordering
 * assertions are reproducible without mocking `Date.now`.
 */

/** A one-minute half-life keeps the decay arithmetic readable. */
const H = 60_000;
const T = 1_700_000_000_000;

const p = (pageId: string, visitedAt: number): RecentPage => ({ pageId, visitedAt });
const ids = (list: readonly RecentPage[]): string[] => list.map((entry) => entry.pageId);

describe("recordVisit", () => {
  it("puts a brand-new page at the front and stamps the visit", () => {
    const next = recordVisit([p("a", T)], "b", T + 1);
    expect(ids(next)).toEqual(["b", "a"]);
    expect(next[0]).toEqual(p("b", T + 1));
  });

  it("starts from an empty list", () => {
    expect(recordVisit([], "a", T)).toEqual([p("a", T)]);
  });

  it("moves a re-visited page to the front without duplicating it", () => {
    const next = recordVisit([p("a", T), p("b", T), p("c", T)], "b", T + 5);
    expect(ids(next)).toEqual(["b", "a", "c"]);
    expect(next).toHaveLength(3);
  });

  it("re-stamps the visit time on a repeat visit", () => {
    const [first] = recordVisit([p("a", T)], "a", T + 99);
    expect(first.visitedAt).toBe(T + 99);
  });

  it("caps the list at MAX_RECENT_PAGES, dropping the oldest tail", () => {
    const full = Array.from({ length: MAX_RECENT_PAGES }, (_, i) =>
      p(`p${i}`, T - i),
    );
    const next = recordVisit(full, "fresh", T + 1);
    expect(next).toHaveLength(MAX_RECENT_PAGES);
    expect(next[0].pageId).toBe("fresh");
    expect(ids(next)).not.toContain(`p${MAX_RECENT_PAGES - 1}`);
  });

  it("trims the page id and ignores a blank one", () => {
    expect(recordVisit([], "  a  ", T)[0].pageId).toBe("a");
    const unchanged = recordVisit([p("a", T)], "   ", T + 1);
    expect(unchanged).toEqual([p("a", T)]);
  });

  it("coerces a non-finite clock to 0 instead of poisoning the list", () => {
    expect(recordVisit([], "a", Number.NaN)[0].visitedAt).toBe(0);
  });

  it("returns a fresh array and never mutates its input", () => {
    const list = [p("a", T), p("b", T)];
    const snapshot = list.map((entry) => ({ ...entry }));
    const next = recordVisit(list, "a", T + 1);
    expect(next).not.toBe(list);
    expect(list).toEqual(snapshot);
  });
});

describe("recentPages", () => {
  it("ranks the most recently visited page first", () => {
    const list = [p("old", T), p("mid", T + 10), p("new", T + 20)];
    expect(ids(recentPages(list, { limit: 10, now: T + 20 }))).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("still orders by recency with no half-life supplied", () => {
    const list = [p("a", T), p("b", T + 5)];
    expect(ids(recentPages(list, { limit: 10, now: T + 5 }))).toEqual(["b", "a"]);
  });

  it("respects the limit, flooring a fractional one", () => {
    const list = [p("a", T), p("b", T + 1), p("c", T + 2)];
    expect(ids(recentPages(list, { limit: 2.9, now: T + 2 }))).toEqual(["c", "b"]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(recentPages([p("a", T)], { limit: 0, now: T })).toEqual([]);
    expect(recentPages([p("a", T)], { limit: -5, now: T })).toEqual([]);
  });

  it("treats a non-finite limit as unbounded", () => {
    const list = [p("a", T), p("b", T + 1)];
    expect(ids(recentPages(list, { limit: Number.POSITIVE_INFINITY, now: T + 1 }))).toEqual(
      ["b", "a"],
    );
  });

  it("dedupes by page id, keeping the most recent visit", () => {
    const list = [p("a", T), p("a", T + 50), p("b", T + 10)];
    expect(ids(recentPages(list, { limit: 10, now: T + 50 }))).toEqual(["a", "b"]);
  });

  it("breaks identical timestamps by page id ascending", () => {
    const list = [p("z", T), p("a", T), p("m", T)];
    expect(ids(recentPages(list, { limit: 10, now: T }))).toEqual(["a", "m", "z"]);
  });

  it("drops malformed entries instead of throwing", () => {
    const list = [p("a", T), p("", T), { pageId: "b", visitedAt: Number.NaN }];
    const out = recentPages(list, { limit: 10, now: T });
    expect(ids(out)).toEqual(["a", "b"]);
    expect(out[1].visitedAt).toBe(0);
  });

  it("returns an empty list for empty input and never mutates its input", () => {
    expect(recentPages([], { limit: 10, now: T })).toEqual([]);
    const list = [p("a", T), p("b", T + 1)];
    const snapshot = list.map((entry) => ({ ...entry }));
    recentPages(list, { limit: 1, now: T + 1 });
    expect(list).toEqual(snapshot);
  });
});

describe("recencyScore", () => {
  it("scores a page seen right now at 1", () => {
    expect(recencyScore(p("a", T), { now: T, halfLifeMs: H })).toBe(1);
  });

  it("halves the score for each half-life of age", () => {
    expect(recencyScore(p("a", T), { now: T + H, halfLifeMs: H })).toBe(0.5);
    expect(recencyScore(p("a", T), { now: T + 2 * H, halfLifeMs: H })).toBe(0.25);
  });

  it("clamps a future timestamp to 1 (a page cannot be aged negatively)", () => {
    expect(recencyScore(p("a", T + H), { now: T, halfLifeMs: H })).toBe(1);
  });

  it("falls back to no decay for a non-positive or non-finite half-life", () => {
    expect(recencyScore(p("a", T), { now: T + 10 * H, halfLifeMs: 0 })).toBe(1);
    expect(recencyScore(p("a", T), { now: T + 10 * H })).toBe(1);
  });

  it("scores an unscorable entry at 0", () => {
    expect(recencyScore({ pageId: "a", visitedAt: Number.NaN }, { now: T })).toBe(0);
  });
});

describe("clearRecent", () => {
  it("returns an empty list", () => {
    expect(clearRecent()).toEqual([]);
  });
});

describe("removePage", () => {
  it("removes the matching page and ignores unknown ids", () => {
    const list = [p("a", T), p("b", T + 1), p("c", T + 2)];
    expect(ids(removePage(list, "b"))).toEqual(["a", "c"]);
    expect(ids(removePage(list, "ghost"))).toEqual(["a", "b", "c"]);
  });

  it("trims its argument and is a no-op for a blank id", () => {
    const list = [p("a", T), p("b", T + 1)];
    expect(ids(removePage(list, " a "))).toEqual(["b"]);
    expect(removePage(list, "  ")).toEqual(list);
  });

  it("returns a fresh array without mutating its input", () => {
    const list = [p("a", T)];
    const next = removePage(list, "a");
    expect(next).toEqual([]);
    expect(next).not.toBe(list);
    expect(list).toEqual([p("a", T)]);
  });
});

describe("mergeRecent", () => {
  it("unions two lists, newest first", () => {
    const a = [p("a", T), p("c", T + 30)];
    const b = [p("b", T + 10), p("d", T + 20)];
    expect(ids(mergeRecent(a, b))).toEqual(["c", "d", "b", "a"]);
  });

  it("keeps the more recent timestamp for a shared page", () => {
    const merged = mergeRecent([p("a", T)], [p("a", T + 100)]);
    expect(merged).toEqual([p("a", T + 100)]);
  });

  it("breaks timestamp ties by page id ascending", () => {
    expect(ids(mergeRecent([p("z", T)], [p("a", T)]))).toEqual(["a", "z"]);
  });

  it("caps the merged list at MAX_RECENT_PAGES", () => {
    const a = Array.from({ length: MAX_RECENT_PAGES }, (_, i) => p(`a${i}`, T + i * 2));
    const b = Array.from({ length: MAX_RECENT_PAGES }, (_, i) => p(`b${i}`, T + i * 2 + 1));
    expect(mergeRecent(a, b)).toHaveLength(MAX_RECENT_PAGES);
  });

  it("does not mutate either input", () => {
    const a = [p("a", T)];
    const b = [p("b", T + 1)];
    const out = mergeRecent(a, b);
    expect(out).not.toBe(a);
    expect(out).not.toBe(b);
    expect(a).toEqual([p("a", T)]);
    expect(b).toEqual([p("b", T + 1)]);
    expect(DEFAULT_HALF_LIFE_MS).toBeGreaterThan(0);
  });
});
