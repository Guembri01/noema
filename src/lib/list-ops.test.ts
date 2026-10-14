import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LEVEL,
  indentItem,
  mergeWithPrevious,
  normalizeLevels,
  outdentItem,
  splitItem,
  type ListItem,
} from "@/lib/list-ops";

/**
 * List item operations — the pure kernel behind indentation, Enter (split) and
 * Backspace-at-start (merge with previous) on bulleted / numbered / to-do
 * lists.
 *
 * Red-first: `src/lib/list-ops.ts` did not exist when this file was written, so
 * the whole suite fails on the missing module until the engine lands.
 * Everything here is pure data in / data out — no DB, no routes, no React — and
 * every operation must leave its input array and items untouched.
 */

type Item = ListItem & { checked?: boolean };

const item = (
  id: string,
  level: number,
  text: string,
  checked?: boolean,
): Item => (checked === undefined ? { id, level, text } : { id, level, text, checked });

const levels = (items: readonly ListItem[]): number[] => items.map((row) => row.level);
const texts = (items: readonly ListItem[]): string[] => items.map((row) => row.text);

const list = (): Item[] => [
  item("a", 0, "alpha", true),
  item("b", 0, "bravo"),
  item("c", 1, "charlie"),
];

describe("list-ops: indentItem", () => {
  it("raises the item's level by one, leaving the rest and the input untouched", () => {
    const items = list();
    const next = indentItem(items, "b");
    expect(levels(next)).toEqual([0, 1, 1]);
    expect(next).not.toBe(items);
    expect(items).toEqual(list());
  });

  it("preserves the item's id and extra fields", () => {
    const next = indentItem(list(), "a");
    expect(next[0]).toEqual({ id: "a", level: 1, text: "alpha", checked: true });
  });

  it("is a no-op at the default level cap", () => {
    const items = [item("a", DEFAULT_MAX_LEVEL, "at the cap")];
    expect(indentItem(items, "a")).toBe(items);
  });

  it("is a no-op at a custom level cap", () => {
    const items = [item("a", 2, "two")];
    expect(indentItem(items, "a", { maxLevel: 2 })).toBe(items);
  });

  it("ignores an unknown id", () => {
    const items = list();
    expect(indentItem(items, "ghost")).toBe(items);
  });
});

describe("list-ops: outdentItem", () => {
  it("lowers the item's level by one and leaves the input untouched", () => {
    const items = list();
    const next = outdentItem(items, "c");
    expect(levels(next)).toEqual([0, 0, 0]);
    expect(items).toEqual(list());
  });

  it("is a no-op at level 0", () => {
    const items = list();
    expect(outdentItem(items, "a")).toBe(items);
  });

  it("repairs an out-of-range negative level up to 0", () => {
    const items = [item("a", -3, "bad")];
    const next = outdentItem(items, "a");
    expect(levels(next)).toEqual([0]);
  });

  it("ignores an unknown id", () => {
    const items = list();
    expect(outdentItem(items, "ghost")).toBe(items);
  });
});

describe("list-ops: splitItem", () => {
  it("splits the text, keeping the id on the prefix and minting a fresh suffix id", () => {
    const items = [item("a", 0, "hello world")];
    const next = splitItem(items, "a", 5);
    expect(texts(next)).toEqual(["hello", " world"]);
    expect(next[1]?.id).toBe("a:split");
    expect(next[1]?.level).toBe(0);
    expect(items[0]?.text).toBe("hello world");
  });

  it("clamps an offset past the end to the text length", () => {
    expect(texts(splitItem([item("a", 0, "hi")], "a", 99))).toEqual(["hi", ""]);
  });

  it("clamps a negative offset to the start", () => {
    expect(texts(splitItem([item("a", 0, "hi")], "a", -4))).toEqual(["", "hi"]);
  });

  it("truncates a fractional offset", () => {
    expect(texts(splitItem([item("a", 0, "abcd")], "a", 2.9))).toEqual(["ab", "cd"]);
  });

  it("mints a unique id when the split id is already taken", () => {
    const items = [item("a", 0, "xy"), item("a:split", 0, "taken")];
    const next = splitItem(items, "a", 1);
    expect(next[1]?.id).toBe("a:split-2");
    expect(new Set(next.map((row) => row.id)).size).toBe(next.length);
  });

  it("carries level and extra fields onto both halves", () => {
    const next = splitItem([item("a", 2, "todo item", true)], "a", 4);
    expect(next).toEqual([
      { id: "a", level: 2, text: "todo", checked: true },
      { id: "a:split", level: 2, text: " item", checked: true },
    ]);
  });

  it("ignores an unknown id", () => {
    const items = list();
    expect(splitItem(items, "ghost", 1)).toBe(items);
  });
});

describe("list-ops: mergeWithPrevious", () => {
  it("appends the item's text to the previous item and drops it", () => {
    const items = list();
    const next = mergeWithPrevious(items, "b");
    expect(next.map((row) => row.id)).toEqual(["a", "c"]);
    expect(next[0]?.text).toBe("alphabravo");
    expect(items).toEqual(list());
  });

  it("keeps the previous item's id, level and extra fields", () => {
    const next = mergeWithPrevious(list(), "b");
    expect(next[0]).toEqual({ id: "a", level: 0, text: "alphabravo", checked: true });
  });

  it("is a no-op for the first item (nothing to merge into)", () => {
    const items = list();
    expect(mergeWithPrevious(items, "a")).toBe(items);
  });

  it("ignores an unknown id", () => {
    const items = list();
    expect(mergeWithPrevious(items, "ghost")).toBe(items);
  });
});

describe("list-ops: normalizeLevels", () => {
  it("caps a jump deeper than one level at previous + 1", () => {
    const next = normalizeLevels([item("a", 0, "a"), item("b", 4, "b")]);
    expect(levels(next)).toEqual([0, 1]);
  });

  it("forces the first item to the top level", () => {
    expect(levels(normalizeLevels([item("a", 3, "a")]))).toEqual([0]);
  });

  it("clamps negative levels to 0", () => {
    const next = normalizeLevels([item("a", 0, "a"), item("b", -2, "b")]);
    expect(levels(next)).toEqual([0, 0]);
  });

  it("treats a well-formed chain as a no-op (same reference)", () => {
    const items = [
      item("a", 0, "a"),
      item("b", 1, "b"),
      item("c", 2, "c"),
      item("d", 1, "d"),
      item("e", 2, "e"),
    ];
    expect(normalizeLevels(items)).toBe(items);
  });

  it("is idempotent on an already-normalized list", () => {
    const once = normalizeLevels([item("a", 0, "a"), item("b", 3, "b")]);
    expect(levels(once)).toEqual([0, 1]);
    expect(normalizeLevels(once)).toBe(once);
  });

  it("never mutates the input", () => {
    const items = [item("a", 0, "a"), item("b", 5, "b")];
    const snapshot = JSON.stringify(items);
    normalizeLevels(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
