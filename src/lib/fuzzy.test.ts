import { describe, expect, it } from "vitest";
import {
  filterByType,
  firstIndex,
  fuzzyFilter,
  fuzzyMatch,
  highlightSnippet,
  lastIndex,
  nextIndex,
  parseTypeScope,
  prevIndex,
} from "./fuzzy";

/**
 * B43 — command palette fuzzy matcher (red-first).
 *
 * The palette must rank a word-start hit above a scattered one, treat an
 * empty query as "everything, in order", and drop non-matches entirely.
 * These are the three behaviours the UI keyboard-nav depends on.
 */
describe("fuzzyMatch", () => {
  it("returns null when a query character is missing or out of order", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
    expect(fuzzyMatch("cb", "abc")).toBeNull();
    expect(fuzzyMatch("page", "pap e") ?? null).toBeNull();
  });

  it("matches an empty (or whitespace-only) query with a neutral score", () => {
    expect(fuzzyMatch("", "New page")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("   ", "New page")).toEqual({ score: 0, indices: [] });
  });

  it("matches case-insensitively and records the matched indices", () => {
    expect(fuzzyMatch("NP", "New page")).toEqual({ score: expect.any(Number), indices: [0, 4] });
    expect(fuzzyMatch("PAGE", "page")).toEqual({ score: expect.any(Number), indices: [0, 1, 2, 3] });
    expect(fuzzyMatch("page", "Page")).not.toBeNull();
  });

  it("scores a word-start hit above the same letters mid-word", () => {
    const wordStart = fuzzyMatch("ed", "Editor");
    const midWord = fuzzyMatch("ed", "Seedbed");
    expect(wordStart).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(wordStart!.score).toBeGreaterThan(midWord!.score);
  });

  it("scores a consecutive prefix above the same query scattered further in", () => {
    const prefix = fuzzyMatch("doc", "Document");
    const scattered = fuzzyMatch("doc", "Deep ocean cargo");
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix!.score).toBeGreaterThan(scattered!.score);
  });

  it("scores an exact full-string match above a longer string it prefixes", () => {
    const exact = fuzzyMatch("page", "page");
    const prefix = fuzzyMatch("page", "page title");
    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(exact!.score).toBeGreaterThan(prefix!.score);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Editor", "Seedbed", "Login wall"];

  it("returns every item in original order for an empty query", () => {
    const result = fuzzyFilter(["b", "a", "c"], "", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["b", "a", "c"]);
    expect(result.every((entry) => entry.score === 0)).toBe(true);
    expect(result.every((entry) => entry.indices.length === 0)).toBe(true);
  });

  it("drops items that do not match the query", () => {
    expect(fuzzyFilter(items, "ed", (item) => item).map((entry) => entry.item)).toEqual([
      "Editor",
      "Seedbed",
    ]);
    expect(fuzzyFilter(items, "zzz", (item) => item)).toEqual([]);
  });

  it("orders matches by descending score", () => {
    const result = fuzzyFilter(["Seedbed", "Editor"], "ed", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["Editor", "Seedbed"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("keeps equal-score ties in their original relative order", () => {
    const result = fuzzyFilter(["ab", "ab"], "ab", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["ab", "ab"]);
  });
});

/**
 * §11 Search filters / Search by type — a type scope narrows a result list
 * to one item type without touching scores or ordering, and a leading
 * `type:<value>` token in the query parses into that scope.
 */
describe("filterByType", () => {
  type Item = { id: string; type: string };
  const items: Item[] = [
    { id: "product roadmap", type: "page" },
    { id: "customer tracker", type: "database" },
    { id: "launch checklist", type: "page" },
    { id: "release checklist", type: "database" },
    { id: "login bug", type: "ticket" },
    { id: "pricing note", type: "comment" },
  ];
  const typeOf = (item: Item) => item.type;

  it("keeps only items of the requested type, preserving their order", () => {
    expect(filterByType(items, "page", typeOf).map((item) => item.id)).toEqual([
      "product roadmap",
      "launch checklist",
    ]);
    expect(filterByType(items, "database", typeOf).map((item) => item.id)).toEqual([
      "customer tracker",
      "release checklist",
    ]);
  });

  it("compares types case-insensitively and trims whitespace", () => {
    expect(filterByType(items, "  PAGE ", typeOf).map((item) => item.id)).toEqual([
      "product roadmap",
      "launch checklist",
    ]);
    expect(filterByType(items, "Ticket", typeOf).map((item) => item.id)).toEqual(["login bug"]);
  });

  it("returns an empty array when nothing has that type", () => {
    expect(filterByType(items, "wiki", typeOf)).toEqual([]);
    const pagesOnly = items.filter((item) => item.type === "page");
    expect(filterByType(pagesOnly, "database", typeOf)).toEqual([]);
  });

  it("never mutates the input array", () => {
    const snapshot = [...items];
    filterByType(items, "page", typeOf);
    expect(items).toEqual(snapshot);
  });

  it("composes with parseTypeScope + fuzzyFilter to narrow a ranked list", () => {
    const scope = parseTypeScope("type:page checklist");
    expect(scope).toEqual({ type: "page", query: " checklist" });
    const narrowed = filterByType(items, scope.type!, typeOf);
    expect(fuzzyFilter(narrowed, scope.query, (item) => item.id).map((entry) => entry.item.id)).toEqual([
      "launch checklist",
    ]);
    // Without a scope both checklist items survive the same query.
    const unscoped = fuzzyFilter(items, scope.query, (item) => item.id)
      .map((entry) => entry.item.id)
      .sort();
    expect(unscoped).toEqual(["launch checklist", "release checklist"]);
  });
});

describe("parseTypeScope", () => {
  it("extracts a leading type: token and returns the remaining query", () => {
    expect(parseTypeScope("type:page roadmap")).toEqual({ type: "page", query: " roadmap" });
    expect(parseTypeScope("  type:database   ")).toEqual({ type: "database", query: "   " });
  });

  it("normalises plural and mixed-case scope values", () => {
    expect(parseTypeScope("type:Pages invoice")).toEqual({ type: "page", query: " invoice" });
    expect(parseTypeScope("TYPE:Comments")).toEqual({ type: "comment", query: "" });
    expect(parseTypeScope("type : Tickets")).toEqual({ type: "ticket", query: "" });
  });

  it("leaves queries without a usable scope untouched", () => {
    expect(parseTypeScope("roadmap")).toEqual({ type: null, query: "roadmap" });
    expect(parseTypeScope("")).toEqual({ type: null, query: "" });
    expect(parseTypeScope("type:")).toEqual({ type: null, query: "type:" });
    expect(parseTypeScope("type:wiki page")).toEqual({ type: null, query: "type:wiki page" });
    expect(parseTypeScope("typo:page")).toEqual({ type: null, query: "typo:page" });
  });

  it("only reads a leading token as a scope", () => {
    expect(parseTypeScope("roadmap type:page")).toEqual({
      type: null,
      query: "roadmap type:page",
    });
  });
});

/**
 * §11 Search keyboard nav — ArrowDown/ArrowUp step through the results and
 * wrap at the ends, Home/End jump to the first/last row, and empty or
 * out-of-range lists stay safe (nothing to navigate ⇒ index 0).
 */
describe("keyboard navigation helpers", () => {
  it("steps down and wraps past the last result", () => {
    expect(nextIndex(3, 0)).toBe(1);
    expect(nextIndex(3, 1)).toBe(2);
    expect(nextIndex(3, 2)).toBe(0);
  });

  it("steps up and wraps back from the first result", () => {
    expect(prevIndex(3, 2)).toBe(1);
    expect(prevIndex(3, 1)).toBe(0);
    expect(prevIndex(3, 0)).toBe(2);
  });

  it("jumps to the first/last result for Home/End", () => {
    expect(firstIndex(4)).toBe(0);
    expect(lastIndex(4)).toBe(3);
    expect(firstIndex(0)).toBe(0);
    expect(lastIndex(0)).toBe(0);
  });

  it("clamps an out-of-range cursor before stepping", () => {
    expect(nextIndex(3, 99)).toBe(0);
    expect(prevIndex(3, -4)).toBe(2);
  });

  it("stays put with a single result", () => {
    expect(nextIndex(1, 0)).toBe(0);
    expect(prevIndex(1, 0)).toBe(0);
  });

  it("returns 0 for an empty result list", () => {
    expect(nextIndex(0, 0)).toBe(0);
    expect(prevIndex(0, 0)).toBe(0);
    expect(nextIndex(0, 5)).toBe(0);
  });

  it("clamps instead of wrapping when wrap is disabled", () => {
    expect(nextIndex(3, 2, { wrap: false })).toBe(2);
    expect(prevIndex(3, 0, { wrap: false })).toBe(0);
    expect(nextIndex(3, 0, { wrap: false })).toBe(1);
    expect(prevIndex(3, 2, { wrap: false })).toBe(1);
  });
});

/**
 * §11 Search preview snippets — a snippet is the matched region plus
 * `radius` chars of context on each side, with offsets relative to the
 * returned excerpt so callers can highlight without re-running the matcher.
 */
describe("highlightSnippet", () => {
  const text = "The quick brown fox jumps over the lazy dog";

  it("returns the match with radius chars of context and relative offsets", () => {
    expect(highlightSnippet(text, "brown", 5)).toEqual({
      text: "uick brown fox ",
      start: 5,
      matchStart: 5,
      matchEnd: 10,
      indices: [5, 6, 7, 8, 9],
    });
  });

  it("clamps the window at the start of the text", () => {
    expect(highlightSnippet(text, "the", 5)).toEqual({
      text: "The quic",
      start: 0,
      matchStart: 0,
      matchEnd: 3,
      indices: [0, 1, 2],
    });
  });

  it("clamps the window at the end of the text", () => {
    expect(highlightSnippet(text, "dog", 5)).toEqual({
      text: "lazy dog",
      start: 35,
      matchStart: 5,
      matchEnd: 8,
      indices: [5, 6, 7],
    });
  });

  it("keeps every offset for a scattered fuzzy match", () => {
    expect(highlightSnippet(text, "qw", 3)).toEqual({
      text: "he quick brown f",
      start: 1,
      matchStart: 3,
      matchEnd: 13,
      indices: [3, 12],
    });
  });

  it("returns the bare match when radius is 0 or negative", () => {
    const bare = {
      text: "brown",
      start: 10,
      matchStart: 0,
      matchEnd: 5,
      indices: [0, 1, 2, 3, 4],
    };
    expect(highlightSnippet(text, "brown", 0)).toEqual(bare);
    expect(highlightSnippet(text, "brown", -4)).toEqual(bare);
  });

  it("truncates fractional radii so offsets stay integral", () => {
    expect(highlightSnippet(text, "brown", 2.7)).toEqual({
      text: "k brown f",
      start: 8,
      matchStart: 2,
      matchEnd: 7,
      indices: [2, 3, 4, 5, 6],
    });
  });

  it("returns null when the query is empty or does not match", () => {
    expect(highlightSnippet(text, "", 5)).toBeNull();
    expect(highlightSnippet(text, "   ", 5)).toBeNull();
    expect(highlightSnippet(text, "zzz", 5)).toBeNull();
    expect(highlightSnippet("", "page", 5)).toBeNull();
  });
});
