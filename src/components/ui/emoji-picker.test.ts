import { describe, expect, it } from "vitest";
import {
  EMOJI_FRECENCY_NAMESPACE,
  emojiCatalog,
  emojiFrecencyKey,
  filterEmojiCatalog,
  loadEmojiUsages,
  parseEmojiUsages,
  saveEmojiUsages,
  type EmojiStorage,
} from "./emoji-picker";
import { recordUse, topRecent } from "@/lib/emoji-frecency";

/**
 * fix07 — `@/lib/emoji-frecency` had no production importer; it is now the
 * ranking core of the emoji picker's "frequently used" strip. These node tests
 * pin the picker's persistence and the frecency ranking/decay it feeds, without
 * a DOM (the store is injected, so nothing here touches `window`).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_000 * HOUR;

/** An in-memory stand-in for `localStorage`. */
function fakeStorage(): EmojiStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("per-user storage key", () => {
  it("scopes the namespace by user", () => {
    expect(emojiFrecencyKey(EMOJI_FRECENCY_NAMESPACE, "u1")).toBe(
      `${EMOJI_FRECENCY_NAMESPACE}:u1`,
    );
  });

  it("shares the anon bucket for a blank/absent user", () => {
    expect(emojiFrecencyKey("ns")).toBe("ns:anon");
    expect(emojiFrecencyKey("ns", "   ")).toBe("ns:anon");
  });
});

describe("usage persistence", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    const key = emojiFrecencyKey("ns", "u1");
    saveEmojiUsages(key, [{ emoji: "🎉", count: 2, lastUsedAt: 10 }], storage);
    expect(loadEmojiUsages(key, storage)).toEqual([
      { emoji: "🎉", count: 2, lastUsedAt: 10 },
    ]);
  });

  it("drops corrupt JSON, non-arrays and malformed rows", () => {
    expect(parseEmojiUsages(null)).toEqual([]);
    expect(parseEmojiUsages("{not json")).toEqual([]);
    expect(parseEmojiUsages('{"a":1}')).toEqual([]);
    expect(
      parseEmojiUsages(
        JSON.stringify([
          { emoji: "", count: 1, lastUsedAt: 1 },
          { emoji: "a", count: 0, lastUsedAt: 1 },
          { emoji: "b", count: 1, lastUsedAt: "x" },
          { emoji: "c", count: 2, lastUsedAt: 5 },
        ]),
      ),
    ).toEqual([{ emoji: "c", count: 2, lastUsedAt: 5 }]);
  });

  it("folds duplicate rows for one glyph through mergeUsages", () => {
    expect(
      parseEmojiUsages(
        JSON.stringify([
          { emoji: "a", count: 1, lastUsedAt: 1 },
          { emoji: "a", count: 2, lastUsedAt: 3 },
        ]),
      ),
    ).toEqual([{ emoji: "a", count: 3, lastUsedAt: 3 }]);
  });

  it("degrades to nothing when no storage is available", () => {
    expect(loadEmojiUsages("ns:anon", null)).toEqual([]);
    expect(() => saveEmojiUsages("ns:anon", [], null)).not.toThrow();
  });
});

describe("frequently-used ranking (frecency)", () => {
  const key = emojiFrecencyKey("ns", "u1");

  it("records picks, persists them and ranks with exponential decay", () => {
    const storage = fakeStorage();
    let list = loadEmojiUsages(key, storage); // []
    // Two uses of 🎉 two hours back; one recent use of 🚀.
    list = recordUse(list, "🎉", NOW - 2 * HOUR);
    list = recordUse(list, "🎉", NOW - 2 * HOUR);
    list = recordUse(list, "🚀", NOW - 5 * MINUTE);
    saveEmojiUsages(key, list, storage);

    const reloaded = loadEmojiUsages(key, storage);
    // 1-hour half-life: 🚀 ≈ 0.94 beats 🎉 = 2 * 2^-2 = 0.5.
    expect(
      topRecent(reloaded, { now: NOW, halfLifeMs: HOUR, limit: 2 }).map(
        (entry) => entry.emoji,
      ),
    ).toEqual(["🚀", "🎉"]);
    // Without decay the raw count wins — proving decay is what flipped it.
    expect(
      topRecent(reloaded, { now: NOW, halfLifeMs: 0, limit: 2 }).map(
        (entry) => entry.emoji,
      ),
    ).toEqual(["🎉", "🚀"]);
  });

  it("re-seeds from a corrupt persisted list", () => {
    const storage = fakeStorage();
    storage.setItem(key, "{broken");
    const seeded = recordUse(loadEmojiUsages(key, storage), "🎉", NOW);
    expect(seeded).toEqual([{ emoji: "🎉", count: 1, lastUsedAt: NOW }]);
  });
});

describe("catalogue", () => {
  it("exposes unique curated glyphs", () => {
    const catalog = emojiCatalog();
    expect(catalog).toContain("🎉");
    expect(new Set(catalog).size).toBe(catalog.length);
  });

  it("filters by shortcode and keyword aliases", () => {
    expect(filterEmojiCatalog("tada")).toContain("🎉");
    expect(filterEmojiCatalog("party")).toEqual(
      expect.arrayContaining(["🎉", "🥳"]),
    );
    expect(filterEmojiCatalog("")).toEqual(emojiCatalog());
  });
});
