import { describe, expect, it } from "vitest";
import { buildIndex, rank, refineByRelevance, tokenize, type SearchDoc } from "./search-ranking";

/**
 * Full-text search ranking (docs top gap #8) — pure BM25-style scoring that
 * complements the Postgres `ts_rank` path: index a small set of in-memory
 * docs and order them so a rarer term beats a common one, a title hit beats a
 * body hit, and repeated terms saturate instead of dominating.
 *
 * Red-first: these assertions pin the contract before the implementation.
 */
describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric characters", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(tokenize("  spaced   out  ")).toEqual(["spaced", "out"]);
  });

  it("keeps unicode letters and digits", () => {
    expect(tokenize("Café Múnich 2026")).toEqual(["café", "múnich", "2026"]);
  });

  it("folds simple English plurals to a shared stem", () => {
    expect(tokenize("roadmaps policies boxes classes dishes notes focus analysis")).toEqual([
      "roadmap",
      "policy",
      "box",
      "class",
      "dish",
      "note",
      "focus",
      "analysis",
    ]);
  });

  it("drops stopwords and single-character tokens", () => {
    expect(tokenize("The a of and I to go")).toEqual(["go"]);
  });

  it("returns an empty array for empty or punctuation-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   !!! --- ...   ")).toEqual([]);
  });
});

describe("buildIndex", () => {
  const docs: SearchDoc[] = [
    { id: "a", fields: { title: "Roadmap", body: "quarterly roadmap planning for the team" } },
    { id: "b", fields: { title: "Meeting notes", body: "roadmap discussion roadmap review roadmap" } },
    { id: "c", fields: { title: "Cookbook", body: "recipes for dinner" } },
  ];

  it("counts the docs and averages field lengths", () => {
    const index = buildIndex(docs);
    expect(index.docCount).toBe(3);
    expect(index.avgTitleLength).toBeCloseTo(4 / 3, 5);
    expect(index.avgBodyLength).toBeCloseTo(11 / 3, 5);
  });

  it("tracks per-field document frequency", () => {
    const index = buildIndex(docs);
    expect(index.titleDocFreq.get("roadmap")).toBe(1);
    // "roadmap" appears in the body of both page a and page b.
    expect(index.bodyDocFreq.get("roadmap")).toBe(2);
    expect(index.bodyDocFreq.get("cookbook") ?? 0).toBe(0);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const index = buildIndex([]);
    expect(index.docCount).toBe(0);
    expect(index.avgTitleLength).toBe(0);
    expect(index.avgBodyLength).toBe(0);
    expect(rank(index, "anything")).toEqual([]);
  });
});

describe("rank", () => {
  const docs: SearchDoc[] = [
    { id: "a", fields: { title: "Roadmap", body: "quarterly roadmap planning for the team" } },
    { id: "b", fields: { title: "Meeting notes", body: "roadmap discussion roadmap review roadmap" } },
    { id: "c", fields: { title: "Cookbook", body: "recipes for dinner" } },
  ];
  const index = buildIndex(docs);

  it("returns only matching docs, each with a positive finite score", () => {
    const results = rank(index, "roadmap");
    expect(results.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(results.every((entry) => entry.score > 0)).toBe(true);
    expect(results.every((entry) => Number.isFinite(entry.score))).toBe(true);
    expect(results.every((entry) => entry.matched.includes("roadmap"))).toBe(true);
  });

  it("returns nothing for an empty query or a query with only stopwords", () => {
    expect(rank(index, "")).toEqual([]);
    expect(rank(index, "   ")).toEqual([]);
    expect(rank(index, "the and of")).toEqual([]);
  });

  it("ignores query terms that appear nowhere (no NaN, no zero-division)", () => {
    const plain = rank(index, "roadmap");
    const withGhost = rank(index, "roadmap zzzznotpresent");
    expect(withGhost.map((entry) => entry.id)).toEqual(plain.map((entry) => entry.id));
    withGhost.forEach((entry, i) => expect(entry.score).toBeCloseTo(plain[i].score, 10));
    expect(rank(index, "zzzznotpresent")).toEqual([]);
  });

  it("saturates term frequency: more occurrences help, but sub-linearly", () => {
    const tfIndex = buildIndex([
      { id: "once", fields: { title: "", body: "term" } },
      { id: "thrice", fields: { title: "", body: "term term term" } },
    ]);
    const results = rank(tfIndex, "term", { titleWeight: 0 });
    const once = results.find((entry) => entry.id === "once");
    const thrice = results.find((entry) => entry.id === "thrice");
    expect(thrice).toBeDefined();
    expect(once).toBeDefined();
    expect(thrice!.score).toBeGreaterThan(once!.score);
    expect(thrice!.score / once!.score).toBeLessThan(3);
  });

  it("normalises by document length: the shorter doc wins at equal term frequency", () => {
    const lengthIndex = buildIndex([
      { id: "short", fields: { title: "", body: "roadmap" } },
      { id: "long", fields: { title: "", body: "roadmap alpha beta gamma delta" } },
    ]);
    const results = rank(lengthIndex, "roadmap", { titleWeight: 0 });
    expect(results.map((entry) => entry.id)).toEqual(["short", "long"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("makes a rarer term dominate a common one via IDF", () => {
    const idfIndex = buildIndex([
      { id: "d1", fields: { title: "", body: "alpha common" } },
      { id: "d2", fields: { title: "", body: "common" } },
      { id: "d3", fields: { title: "", body: "common" } },
      { id: "d4", fields: { title: "", body: "common" } },
    ]);
    const results = rank(idfIndex, "alpha common");
    expect(results[0].id).toBe("d1");
    const d1 = results.find((entry) => entry.id === "d1")!;
    const d2 = results.find((entry) => entry.id === "d2")!;
    expect(d1.score).toBeGreaterThan(d2.score);
    expect(d2.matched).toEqual(["common"]);
    expect(d2.matched).not.toContain("alpha");
  });

  it("adds per-term contributions (multi-term score is the sum)", () => {
    const sumIndex = buildIndex([
      { id: "d1", fields: { title: "", body: "alpha common" } },
      { id: "d2", fields: { title: "", body: "common" } },
      { id: "d3", fields: { title: "", body: "common" } },
    ]);
    const scoreFor = (query: string) =>
      rank(sumIndex, query).find((entry) => entry.id === "d1")!.score;
    const combined = scoreFor("alpha common");
    expect(combined).toBeCloseTo(scoreFor("alpha") + scoreFor("common"), 10);
  });

  it("weights title matches by titleWeight", () => {
    const weightIndex = buildIndex([
      { id: "t", fields: { title: "search", body: "zzz" } },
      { id: "d", fields: { title: "notes", body: "search" } },
    ]);
    expect(rank(weightIndex, "search", { titleWeight: 3 })[0].id).toBe("t");
    expect(rank(weightIndex, "search", { titleWeight: 0 })[0].id).toBe("d");
    // Neutral weight is a tie, broken deterministically by id.
    const neutral = rank(weightIndex, "search", { titleWeight: 1 });
    expect(neutral[0].score).toBeCloseTo(neutral[1].score, 10);
    expect(neutral.map((entry) => entry.id)).toEqual(["d", "t"]);
  });

  it("matches across folded plurals in the query and the index", () => {
    const pluralIndex = buildIndex([
      { id: "x", fields: { title: "", body: "one roadmap here" } },
    ]);
    expect(rank(pluralIndex, "roadmaps").map((entry) => entry.id)).toEqual(["x"]);
  });

  it("deduplicates repeated query terms", () => {
    const single = rank(index, "roadmap");
    const doubled = rank(index, "roadmap roadmap");
    expect(doubled.map((entry) => entry.id)).toEqual(single.map((entry) => entry.id));
    doubled.forEach((entry, i) => expect(entry.score).toBeCloseTo(single[i].score, 10));
  });

  it("caps results at limit, treating a non-positive limit as no cap", () => {
    const all = rank(index, "roadmap");
    expect(all).toHaveLength(2);
    const capped = rank(index, "roadmap", { limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].id).toBe(all[0].id);
    expect(rank(index, "roadmap", { limit: 0 })).toHaveLength(2);
    expect(rank(index, "roadmap", { limit: -3 })).toHaveLength(2);
  });

  it("breaks score ties by recency, then by id for full determinism", () => {
    const recency = buildIndex([
      { id: "x", fields: { title: "", body: "same" }, updatedAt: 100 },
      { id: "y", fields: { title: "", body: "same" }, updatedAt: 200 },
    ]);
    expect(rank(recency, "same").map((entry) => entry.id)).toEqual(["y", "x"]);

    const alpha = buildIndex([
      { id: "b", fields: { title: "", body: "same" } },
      { id: "a", fields: { title: "", body: "same" } },
    ]);
    expect(rank(alpha, "same").map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("boosts fresher docs by recencyBoost, enough to reorder near-ties", () => {
    const boostIndex = buildIndex([
      { id: "old", fields: { title: "", body: "term term" }, updatedAt: 1 },
      { id: "fresh", fields: { title: "", body: "term" }, updatedAt: 2 },
    ]);
    expect(rank(boostIndex, "term", { titleWeight: 0 })[0].id).toBe("old");
    expect(rank(boostIndex, "term", { titleWeight: 0, recencyBoost: 1 })[0].id).toBe("fresh");
  });

  it("does not mutate the input documents or index", () => {
    const input: SearchDoc[] = [
      { id: "a", fields: { title: "Roadmap", body: "quarterly roadmap" } },
    ];
    const snapshot = JSON.stringify(input);
    const snapshotIndex = JSON.stringify(buildIndex(input));
    const built = buildIndex(input);
    rank(built, "roadmap");
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(JSON.stringify(buildIndex(input))).toBe(snapshotIndex);
  });
});

/**
 * The shared refinement pass extracted from the search page, the v1 search
 * API, `search-results.tsx`, and `quick-find.tsx`: re-order already-filtered
 * rows by the same BM25 scorer, title-weighted, while staying lossless — every
 * row comes back and the ones the scorer does not recognise keep their
 * incoming position, after the scored ones.
 */
describe("refineByRelevance", () => {
  it("re-orders by BM25, surfacing a title hit above a body hit", () => {
    const rows = [
      { id: "body", title: "Notes", body: "search" },
      { id: "title", title: "search", body: "unrelated words here" },
    ];
    const ordered = refineByRelevance(rows, "search", { titleWeight: 3 });
    expect(ordered.map((row) => row.id)).toEqual(["title", "body"]);
    // Same objects, merely re-ordered.
    expect(ordered[0]).toBe(rows[1]);
    expect(ordered[1]).toBe(rows[0]);

    // A zero title weight ignores titles, so only the body hit scores and the
    // title-only row falls back to its incoming position.
    expect(refineByRelevance(rows, "search", { titleWeight: 0 }).map((row) => row.id)).toEqual([
      "body",
      "title",
    ]);
  });

  it("is lossless: unmatched rows keep their order and follow the scored ones", () => {
    const rows = [
      { id: "u1", title: "Cookbook", body: "recipes for dinner" },
      { id: "m2", title: "Roadmap", body: "plan" },
      { id: "u2", title: "Travel", body: "flights and hotels" },
      { id: "m1", title: "Roadmap", body: "plan" },
    ];
    const ordered = refineByRelevance(rows, "roadmap", { titleWeight: 3 });
    expect(ordered).toHaveLength(rows.length);
    expect(ordered.map((row) => row.id)).toEqual(["m1", "m2", "u1", "u2"]);
  });

  it("returns the rows unchanged for an empty/stopword query or a short input", () => {
    const rows = [
      { id: "a", title: "Alpha", body: "one" },
      { id: "b", title: "Beta", body: "two" },
    ];
    expect(refineByRelevance(rows, "the and of").map((row) => row.id)).toEqual(["a", "b"]);
    expect(refineByRelevance([], "alpha")).toEqual([]);

    const single = [rows[0]];
    const result = refineByRelevance(single, "alpha");
    expect(result).toEqual(single);
    expect(result).not.toBe(single);
  });

  it("does not mutate the input array or its rows", () => {
    const rows = [
      { id: "body", title: "Notes", body: "search" },
      { id: "title", title: "search", body: "zzz" },
    ];
    const snapshot = JSON.stringify(rows);
    refineByRelevance(rows, "search", { titleWeight: 3 });
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(rows.map((row) => row.id)).toEqual(["body", "title"]);
  });

  it("reads alternate fields through accessor overrides", () => {
    const rows = [
      { key: "b", label: "Notes", snippet: "search" },
      { key: "a", label: "search", snippet: "zzz" },
    ];
    const ordered = refineByRelevance(rows, "search", {
      titleWeight: 3,
      getId: (row) => row.key,
      getTitle: (row) => row.label,
      getBody: (row) => row.snippet,
    });
    expect(ordered.map((row) => row.key)).toEqual(["a", "b"]);
  });

  it("defaults titleWeight to 1 when options are omitted", () => {
    const rows = [
      { id: "body", title: "Notes", body: "search" },
      { id: "title", title: "search", body: "zzz" },
    ];
    expect(refineByRelevance(rows, "search").map((row) => row.id)).toEqual(
      refineByRelevance(rows, "search", { titleWeight: 1 }).map((row) => row.id),
    );
  });
});
