import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES,
  CONVERSION_GROUPS,
  allowedTargets,
  canConvert,
  convertBlock,
  isBlockType,
  type BlockType,
  type ConvertibleBlock,
} from "./block-conversion";

/**
 * "Turn into" block conversions (docs/FEATURE_MATRIX.md §"Turn into").
 *
 * Red-first: the graph, the identity rule and the attribute mapping are product
 * decisions pinned here. Every text-like block shares one inline content model,
 * so the menu lets any block turn into any *other* block; `convertBlock`
 * preserves the text and marks verbatim and maps only the target's own
 * attributes.
 */

/** A rich paragraph used to prove content/mark preservation. */
const rich = (): ConvertibleBlock => ({
  type: "paragraph",
  content: [
    { type: "text", text: "Hello ", marks: [{ type: "bold" }] },
    {
      type: "text",
      text: "world",
      marks: [{ type: "link", attrs: { href: "https://example.test" } }],
    },
  ],
});

describe("BLOCK_TYPES / isBlockType", () => {
  it("lists the fifteen convertible types in canonical order", () => {
    expect(BLOCK_TYPES).toEqual([
      "paragraph",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "bulletedList",
      "numberedList",
      "todoList",
      "toggle",
      "quote",
      "pullQuote",
      "callout",
      "code",
    ]);
    expect(new Set(BLOCK_TYPES).size).toBe(BLOCK_TYPES.length);
  });

  it("recognises known types and rejects everything else", () => {
    expect(isBlockType("paragraph")).toBe(true);
    expect(isBlockType("code")).toBe(true);
    expect(isBlockType("h4")).toBe(true);
    expect(isBlockType("h7")).toBe(false);
    expect(isBlockType("")).toBe(false);
    expect(isBlockType(42)).toBe(false);
    expect(isBlockType(undefined)).toBe(false);
  });
});

describe("canConvert — complete graph minus identity", () => {
  it("allows any distinct pair of known types", () => {
    expect(canConvert("paragraph", "h2")).toBe(true);
    expect(canConvert("h3", "pullQuote")).toBe(true);
    expect(canConvert("code", "todoList")).toBe(true);
    expect(canConvert("callout", "quote")).toBe(true);
  });

  it("forbids converting a block into its own type", () => {
    for (const type of BLOCK_TYPES) expect(canConvert(type, type)).toBe(false);
  });

  it("rejects unknown types on either side", () => {
    expect(canConvert("paragraph", "h4")).toBe(true);
    expect(canConvert("paragraph", "h7")).toBe(false);
    expect(canConvert("nope", "quote")).toBe(false);
    expect(canConvert("", "code")).toBe(false);
  });

  it("is symmetric across every ordered pair", () => {
    for (const from of BLOCK_TYPES) {
      for (const to of BLOCK_TYPES) {
        expect(canConvert(from, to)).toBe(canConvert(to, from));
      }
    }
  });
});

describe("allowedTargets — canonical order, never self", () => {
  it("returns every other type in BLOCK_TYPES order", () => {
    expect(allowedTargets("paragraph")).toEqual([
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "bulletedList",
      "numberedList",
      "todoList",
      "toggle",
      "quote",
      "pullQuote",
      "callout",
      "code",
    ]);
    expect(allowedTargets("code")).toEqual(BLOCK_TYPES.slice(0, -1));
  });

  it("never includes the source type and returns a fresh array", () => {
    for (const type of BLOCK_TYPES) {
      const targets = allowedTargets(type);
      expect(targets).not.toContain(type);
      expect(targets).toHaveLength(BLOCK_TYPES.length - 1);
    }
    expect(allowedTargets("quote")).not.toBe(allowedTargets("quote"));
  });

  it("returns [] for an unknown source", () => {
    expect(allowedTargets("h7")).toEqual([]);
    expect(allowedTargets("")).toEqual([]);
  });
});

describe("CONVERSION_GROUPS", () => {
  it("covers every block type exactly once, in order", () => {
    const grouped = CONVERSION_GROUPS.flatMap((group) => group.types);
    expect(grouped).toEqual([...BLOCK_TYPES]);
    expect(CONVERSION_GROUPS.map((group) => group.id)).toEqual(["text", "lists", "blocks"]);
  });

  it("is frozen so the menu cannot drift", () => {
    expect(Object.isFrozen(CONVERSION_GROUPS)).toBe(true);
    for (const group of CONVERSION_GROUPS) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.types)).toBe(true);
    }
  });
});

describe("convertBlock — content, marks and attribute mapping", () => {
  it("preserves the inline text and marks verbatim", () => {
    const block = rich();
    const result = convertBlock(block, "quote");
    expect(result?.type).toBe("quote");
    expect(result?.content).toEqual(block.content);
  });

  it("deep-clones content so the source is never aliased or mutated", () => {
    const block = rich();
    const result = convertBlock(block, "h2");
    expect(result?.content).not.toBe(block.content);
    expect(result?.content?.[0]).not.toBe(block.content?.[0]);
    expect(result?.content?.[0]?.marks?.[0]).not.toBe(block.content?.[0]?.marks?.[0]);

    (result?.content?.[0] as { text: string }).text = "changed";
    expect(block.content?.[0]?.text).toBe("Hello ");
  });

  it("maps the target heading level and carries no stale attrs", () => {
    const todo: ConvertibleBlock = { type: "todoList", attrs: { checked: true } };
    expect(convertBlock(todo, "h1")?.attrs).toEqual({ level: 1 });
    expect(convertBlock(todo, "h2")?.attrs).toEqual({ level: 2 });
    expect(convertBlock(todo, "h3")?.attrs).toEqual({ level: 3 });
    expect(convertBlock(todo, "h4")?.attrs).toEqual({ level: 4 });
    expect(convertBlock(todo, "h5")?.attrs).toEqual({ level: 5 });
    expect(convertBlock(todo, "h6")?.attrs).toEqual({ level: 6 });
  });

  it("recomputes the heading level when heading-to-heading", () => {
    const h1: ConvertibleBlock = { type: "h1", attrs: { level: 1 } };
    expect(convertBlock(h1, "h3")?.attrs).toEqual({ level: 3 });
  });

  it("defaults a to-do to unchecked and preserves a checked box", () => {
    expect(convertBlock({ type: "paragraph" }, "todoList")?.attrs).toEqual({ checked: false });
    const checked: ConvertibleBlock = { type: "todoList", attrs: { checked: true } };
    expect(convertBlock(checked, "todoList")?.attrs).toEqual({ checked: true });
  });

  it("drops checked when the target is not a to-do", () => {
    const checked: ConvertibleBlock = { type: "todoList", attrs: { checked: true } };
    const quote = convertBlock(checked, "quote");
    expect(quote?.attrs ?? {}).toEqual({});
    expect(canConvert("todoList", "quote")).toBe(true);
  });

  it("uses the default callout icon and preserves a custom one", () => {
    expect(convertBlock({ type: "paragraph" }, "callout")?.attrs).toEqual({ emoji: "💡" });
    const callout: ConvertibleBlock = { type: "callout", attrs: { emoji: "🔥" } };
    expect(convertBlock(callout, "callout")?.attrs).toEqual({ emoji: "🔥" });
  });

  it("preserves a code language and defaults a new code block to plain text", () => {
    const code: ConvertibleBlock = { type: "code", attrs: { language: "typescript" } };
    expect(convertBlock(code, "code")?.attrs).toEqual({ language: "typescript" });
    expect(convertBlock({ type: "paragraph" }, "code")?.attrs).toEqual({ language: "" });
  });

  it("defaults a toggle to open and preserves a collapsed one", () => {
    expect(convertBlock({ type: "paragraph" }, "toggle")?.attrs).toEqual({ open: true });
    const closed: ConvertibleBlock = { type: "toggle", attrs: { open: false } };
    expect(convertBlock(closed, "toggle")?.attrs).toEqual({ open: false });
  });

  it("gives attribute-free targets no attrs key", () => {
    expect(convertBlock(rich(), "paragraph")?.attrs).toBeUndefined();
    expect(convertBlock(rich(), "pullQuote")?.attrs).toBeUndefined();
  });

  it("returns null for an unknown target instead of guessing", () => {
    expect(convertBlock(rich(), "h7" as BlockType)).toBeNull();
  });
});
