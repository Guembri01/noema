import { describe, expect, it } from "vitest";
import {
  MAX_USAGES,
  mergeUsages,
  rankRecent,
  recordUse,
  topRecent,
  type EmojiUsage,
} from "./emoji-frecency";

/**
 * Recently-used emoji ranking (frecency).
 *
 * Red-first: `src/lib/emoji-frecency.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helper lands.
 * The helper is the pure half of the emoji picker's "frequently used" strip:
 * it records a use (count + timestamp) and ranks entries by an exponential
 * recency decay multiplied by the usage count. Every function is handed `now`
 * so the ranking is deterministic and DOM/clock-free.
 */

const HALF_LIFE = 1_000; // 1s half-life keeps the arithmetic obvious.
const NOW = 100_000;

const usage = (
  emoji: string,
  count: number,
  lastUsedAt: number,
): EmojiUsage => ({ emoji, count, lastUsedAt });

const emojis = (list: readonly { emoji: string }[]): string[] =>
  list.map((u) => u.emoji);

describe("recordUse", () => {
  it("adds a new emoji with count 1 stamped at now", () => {
    const next = recordUse([], "🙂", NOW);
    expect(next).toEqual([{ emoji: "🙂", count: 1, lastUsedAt: NOW }]);
  });

  it("increments an existing emoji and restamps it", () => {
    const list = [usage("🙂", 2, 1), usage("🎉", 1, 2)];
    const next = recordUse(list, "🙂", NOW);
    expect(next).toContainEqual({ emoji: "🙂", count: 3, lastUsedAt: NOW });
    expect(next).toContainEqual({ emoji: "🎉", count: 1, lastUsedAt: 2 });
  });

  it("appends a new emoji after the existing ones", () => {
    const list = [usage("🙂", 1, 1), usage("🎉", 1, 2)];
    expect(emojis(recordUse(list, "🚀", NOW))).toEqual(["🙂", "🎉", "🚀"]);
  });

  it("never mutates the input list", () => {
    const list = [usage("🙂", 1, 1)];
    const snapshot = JSON.parse(JSON.stringify(list));
    const next = recordUse(list, "🙂", NOW);
    expect(list).toEqual(snapshot);
    expect(next).not.toBe(list);
    expect(next[0]).not.toBe(list[0]);
  });

  it("ignores an empty emoji, returning a fresh copy", () => {
    const list = [usage("🙂", 1, 1)];
    const next = recordUse(list, "", NOW);
    expect(next).toEqual(list);
    expect(next).not.toBe(list);
  });

  it("caps the list, evicting the least-recently-used entry", () => {
    const list = [usage("a", 1, 1), usage("b", 1, 2), usage("c", 1, 3)];
    const next = recordUse(list, "a", NOW, 2);
    // "a" is restamped to NOW; "b" (oldest) drops out.
    expect(emojis(next)).toEqual(["a", "c"]);
  });

  it("breaks cap eviction ties by count, then emoji", () => {
    const list = [usage("a", 1, 5), usage("b", 3, 5), usage("c", 2, 5)];
    const next = recordUse(list, "d", NOW, 2);
    // All equal lastUsedAt: keep the highest counts (b, d); drop a then c.
    expect(emojis(next)).toEqual(["b", "d"]);
  });

  it("defaults the cap to MAX_USAGES", () => {
    const list = Array.from({ length: MAX_USAGES }, (_, i) =>
      usage(`e${i}`, 1, i),
    );
    const next = recordUse(list, "new", NOW);
    expect(next).toHaveLength(MAX_USAGES);
    expect(next.some((u) => u.emoji === "new" && u.lastUsedAt === NOW)).toBe(true);
    // The oldest stamped entry ("e0") is evicted to make room.
    expect(emojis(next)).not.toContain("e0");
  });
});

describe("rankRecent", () => {
  it("returns an empty list for no usages", () => {
    expect(rankRecent([], { now: NOW, halfLifeMs: HALF_LIFE })).toEqual([]);
  });

  it("ranks a higher count first when equally recent", () => {
    const list = [usage("a", 1, NOW), usage("b", 5, NOW)];
    expect(emojis(rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE }))).toEqual([
      "b",
      "a",
    ]);
  });

  it("ranks the more recent entry first when counts are equal", () => {
    const list = [usage("old", 1, NOW - HALF_LIFE), usage("new", 1, NOW)];
    expect(
      emojis(rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE })),
    ).toEqual(["new", "old"]);
  });

  it("applies exponential half-life decay to the score", () => {
    const list = [usage("old", 1, NOW - HALF_LIFE), usage("new", 1, NOW)];
    const ranked = rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE });
    expect(ranked.find((u) => u.emoji === "new")?.score).toBeCloseTo(1, 10);
    expect(ranked.find((u) => u.emoji === "old")?.score).toBeCloseTo(0.5, 10);
  });

  it("multiplies decayed recency by count", () => {
    const list = [usage("twice-old", 2, NOW - HALF_LIFE), usage("once-new", 1, NOW)];
    const ranked = rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE });
    // 2 * 0.5 === 1 * 1 -> a tie, broken toward the more recent entry.
    expect(emojis(ranked)).toEqual(["once-new", "twice-old"]);
    expect(ranked[0].score).toBeCloseTo(1, 10);
    expect(ranked[1].score).toBeCloseTo(1, 10);
  });

  it("ranks purely by count when halfLifeMs is not positive", () => {
    const list = [usage("old-heavy", 3, NOW - HALF_LIFE), usage("new-light", 1, NOW)];
    expect(
      emojis(rankRecent(list, { now: NOW, halfLifeMs: 0 })),
    ).toEqual(["old-heavy", "new-light"]);
  });

  it("breaks full ties deterministically by emoji", () => {
    const list = [usage("c", 1, NOW), usage("a", 1, NOW), usage("b", 1, NOW)];
    expect(emojis(rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE }))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not mutate the input", () => {
    const list = [usage("a", 1, NOW), usage("b", 2, NOW)];
    const snapshot = JSON.parse(JSON.stringify(list));
    rankRecent(list, { now: NOW, halfLifeMs: HALF_LIFE });
    expect(list).toEqual(snapshot);
  });
});

describe("topRecent", () => {
  it("returns the top N in ranked order", () => {
    const list = [usage("a", 1, NOW), usage("b", 5, NOW), usage("c", 3, NOW)];
    expect(
      emojis(topRecent(list, { limit: 2, now: NOW, halfLifeMs: HALF_LIFE })),
    ).toEqual(["b", "c"]);
  });

  it("returns an empty list when limit is 0 or negative", () => {
    const list = [usage("a", 1, NOW)];
    expect(topRecent(list, { limit: 0, now: NOW })).toEqual([]);
    expect(topRecent(list, { limit: -3, now: NOW })).toEqual([]);
  });

  it("floors a fractional limit", () => {
    const list = [usage("a", 1, NOW), usage("b", 2, NOW)];
    expect(emojis(topRecent(list, { limit: 1.9, now: NOW }))).toEqual(["b"]);
  });

  it("caps at the list length", () => {
    const list = [usage("a", 1, NOW)];
    expect(topRecent(list, { limit: 10, now: NOW })).toHaveLength(1);
  });
});

describe("mergeUsages", () => {
  it("sums counts and keeps the latest stamp for shared emoji", () => {
    const a = [usage("🙂", 2, 10), usage("🎉", 1, 5)];
    const b = [usage("🎉", 3, 20), usage("🚀", 1, 7)];
    expect(mergeUsages(a, b)).toEqual([
      { emoji: "🙂", count: 2, lastUsedAt: 10 },
      { emoji: "🎉", count: 4, lastUsedAt: 20 },
      { emoji: "🚀", count: 1, lastUsedAt: 7 },
    ]);
  });

  it("appends emoji unique to the second list, after the first", () => {
    expect(emojis(mergeUsages([usage("a", 1, 1)], [usage("b", 1, 2)]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("treats an empty side as identity", () => {
    const list = [usage("a", 1, 1)];
    expect(mergeUsages(list, [])).toEqual(list);
    expect(mergeUsages([], list)).toEqual(list);
  });

  it("does not mutate either input", () => {
    const a = [usage("a", 1, 1)];
    const b = [usage("a", 2, 9)];
    const snapA = JSON.parse(JSON.stringify(a));
    const snapB = JSON.parse(JSON.stringify(b));
    mergeUsages(a, b);
    expect(a).toEqual(snapA);
    expect(b).toEqual(snapB);
  });
});
