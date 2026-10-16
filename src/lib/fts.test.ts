import { describe, expect, it } from "vitest";
import {
  buildSearchSql,
  highlightRanks,
  mergeRanked,
  parseHeadline,
  planSearch,
  toTsQuery,
  trigramFallback,
  TRIGRAM_THRESHOLD,
  type RankedInput,
  type SearchRow,
} from "./fts";

/**
 * Postgres full-text search query builder (gap #8, spec §11): the pure SQL
 * layer behind the FTS path — sanitising user input into a `to_tsquery`
 * expression, composing a deterministic ranked/`ts_headline` query, the
 * `pg_trgm` typo tier, headline parsing, and plan/merge helpers.
 *
 * Red-first: these assertions pin the contract before the implementation.
 */
describe("toTsQuery", () => {
  it("lowercases tokens, ANDs them, and prefixes the last one", () => {
    expect(toTsQuery("Hello World")).toBe("hello & world:*");
  });

  it("strips to_tsquery operators instead of passing them through", () => {
    expect(toTsQuery("foo & bar | baz ! qux")).toBe("foo & bar & baz & qux:*");
  });

  it("strips parentheses, colons and stars from the input", () => {
    expect(toTsQuery("(foo:* | bar)")).toBe("foo & bar:*");
  });

  it("turns a quoted phrase into a <-> adjacency chain", () => {
    expect(toTsQuery('"quarterly roadmap" plan')).toBe(
      "quarterly <-> roadmap & plan:*",
    );
  });

  it("applies the prefix star to the last word of a trailing phrase", () => {
    expect(toTsQuery('plan "quarterly roadmap"')).toBe(
      "plan & quarterly <-> roadmap:*",
    );
  });

  it("collapses a single-word phrase and still prefixes it", () => {
    expect(toTsQuery('"roadmap"')).toBe("roadmap:*");
  });

  it("treats an unterminated quote as a phrase running to the end", () => {
    expect(toTsQuery('"quarterly roadmap')).toBe("quarterly <-> roadmap:*");
  });

  it("returns an empty string for empty or punctuation-only input", () => {
    expect(toTsQuery("")).toBe("");
    expect(toTsQuery("   ")).toBe("");
    expect(toTsQuery("!!! --- ... ;;")).toBe("");
  });

  it("keeps unicode letters and digits", () => {
    expect(toTsQuery("Café Múnich 2026")).toBe("café & múnich & 2026:*");
  });

  it("is injection-safe: quotes and SQL punctuation never survive", () => {
    const tsquery = toTsQuery("'; DROP TABLE pages; --");
    expect(tsquery).toBe("drop & table & pages:*");
    expect(tsquery).not.toMatch(/['|!<>()]/);
  });

  it("bounds the number of terms so a huge query stays cheap", () => {
    const query = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const tsquery = toTsQuery(query);
    expect(tsquery.split(" & ").length).toBeLessThanOrEqual(16);
  });
});

describe("buildSearchSql", () => {
  const scope = { workspaceId: "ws1" };

  it("returns an empty fragment for a blank query", () => {
    expect(buildSearchSql({ query: "   ", scope })).toEqual({ text: "", params: [] });
  });

  it("matches with to_tsvector @@ to_tsquery and ranks with ts_rank_cd", () => {
    const { text } = buildSearchSql({ query: "roadmap", scope });
    expect(text).toContain(
      `to_tsvector('english', coalesce(p."searchText", p."title")) @@ to_tsquery('english', $1)`,
    );
    expect(text).toContain("ts_rank_cd(");
    expect(text).toContain("ts_headline(");
    expect(text).toContain(`ORDER BY "rank" DESC, p."updatedAt" DESC, p."id" ASC`);
    expect(text.indexOf("@@ to_tsquery")).toBeLessThan(text.indexOf("ORDER BY"));
  });

  it("binds the sanitised tsquery, workspace and a default limit", () => {
    const { text, params } = buildSearchSql({ query: "Roadmap Release", scope });
    expect(params).toEqual(["roadmap & release:*", "ws1", 50]);
    expect(text).toContain("LIMIT $3");
  });

  it("adds an ANY() scope predicate for guest-visible page ids", () => {
    const { text, params } = buildSearchSql({
      query: "roadmap",
      scope: { workspaceId: "ws1", visiblePageIds: ["p1", "p2"] },
    });
    expect(text).toContain(`AND p."id" = ANY($3)`);
    expect(params[2]).toEqual(["p1", "p2"]);
  });

  it("still scopes an empty visible set (matches nothing)", () => {
    const { text, params } = buildSearchSql({
      query: "roadmap",
      scope: { workspaceId: "ws1", visiblePageIds: [] },
    });
    expect(text).toContain(`AND p."id" = ANY($3)`);
    expect(params[2]).toEqual([]);
  });

  it("adds a keyset cursor predicate after the scope and before LIMIT", () => {
    const { text, params } = buildSearchSql({
      query: "roadmap",
      scope: { workspaceId: "ws1", visiblePageIds: ["p1"] },
      limit: 10,
      cursor: { rank: 0.7, updatedAt: "2025-01-01T00:00:00.000Z", id: "p9" },
    });
    expect(text).toContain(`($4, $5, $6)`);
    expect(text).toContain("LIMIT $7");
    expect(params).toEqual([
      "roadmap:*",
      "ws1",
      ["p1"],
      0.7,
      "2025-01-01T00:00:00.000Z",
      "p9",
      10,
    ]);
  });

  it("clamps and defaults the limit to a safe window", () => {
    expect(buildSearchSql({ query: "a", scope, limit: 0 }).params.at(-1)).toBe(50);
    expect(buildSearchSql({ query: "a", scope, limit: 9999 }).params.at(-1)).toBe(200);
    expect(buildSearchSql({ query: "a", scope, limit: 12 }).params.at(-1)).toBe(12);
  });

  it("is deterministic and never interpolates raw user input", () => {
    const options = { query: "a'); DROP TABLE pages --", scope };
    const first = buildSearchSql(options);
    const second = buildSearchSql(options);
    expect(first).toEqual(second);
    expect(first.text).not.toContain("DROP TABLE");
    expect(first.text).not.toContain("';");
    expect(first.params[0] as string).not.toMatch(/[';]/);
  });
});

describe("trigramFallback", () => {
  it("produces a pg_trgm similarity clause for typo tolerance", () => {
    const { text, params } = trigramFallback("Noetbook");
    expect(text).toContain("similarity(");
    expect(text).toContain(String(TRIGRAM_THRESHOLD));
    expect(params).toEqual(["noetbook"]);
  });

  it("normalises case and collapsed whitespace in the bound value", () => {
    const { params } = trigramFallback("  Quarterly   Roadmap  ");
    expect(params).toEqual(["quarterly roadmap"]);
  });

  it("returns an empty fragment for a blank input", () => {
    expect(trigramFallback("   ")).toEqual({ text: "", params: [] });
  });
});

describe("parseHeadline", () => {
  it("removes ts_headline markers and collects the matches in order", () => {
    expect(parseHeadline("foo <b>bar</b> baz")).toEqual({
      text: "foo bar baz",
      matches: ["bar"],
    });
    expect(parseHeadline("<b>a</b> x <b>b</b>")).toEqual({
      text: "a x b",
      matches: ["a", "b"],
    });
  });

  it("returns no matches for unmarked text", () => {
    expect(parseHeadline("plain snippet")).toEqual({
      text: "plain snippet",
      matches: [],
    });
  });

  it("drops empty marker spans", () => {
    expect(parseHeadline("x<b></b>y")).toEqual({ text: "xy", matches: [] });
  });

  it("leaves an unmatched opening marker as literal text", () => {
    expect(parseHeadline("a <b> literal")).toEqual({
      text: "a <b> literal",
      matches: [],
    });
    expect(parseHeadline("<b>unclosed")).toEqual({
      text: "<b>unclosed",
      matches: [],
    });
  });

  it("handles empty input", () => {
    expect(parseHeadline("")).toEqual({ text: "", matches: [] });
  });
});

describe("highlightRanks", () => {
  const rows: SearchRow[] = [
    { id: "b", snippet: "plain", rank: 2 },
    { id: "a", snippet: "hit <b>roadmap</b> here", rank: 4 },
  ];

  it("sorts by rank and normalises each score against the top rank", () => {
    const ranked = highlightRanks(rows);
    expect(ranked.map((row) => row.id)).toEqual(["a", "b"]);
    expect(ranked[0].score).toBe(1);
    expect(ranked[1].score).toBeCloseTo(0.5, 10);
  });

  it("parses each snippet into a headline with matches", () => {
    const ranked = highlightRanks(rows);
    expect(ranked[0].headline).toEqual({
      text: "hit roadmap here",
      matches: ["roadmap"],
    });
  });

  it("guards against non-positive and non-finite ranks", () => {
    const ranked = highlightRanks([
      { id: "x", snippet: "s", rank: 0 },
      { id: "y", snippet: "s", rank: Number.NaN },
    ]);
    expect(ranked.every((row) => row.score === 0)).toBe(true);
  });

  it("does not mutate the input rows", () => {
    const input: SearchRow[] = [{ id: "a", snippet: "s", rank: 3 }];
    const snapshot = JSON.stringify(input);
    highlightRanks(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("planSearch", () => {
  it("returns the none plan for a blank query", () => {
    expect(planSearch({ query: "  ", hasIndex: true, estimatedRows: 10 })).toEqual({
      strategy: "none",
      prefix: false,
      reason: "empty-query",
    });
  });

  it("uses the FTS path when a GIN index exists", () => {
    const plan = planSearch({ query: "roadmap", hasIndex: true, estimatedRows: 5_000_000 });
    expect(plan.strategy).toBe("fts");
    expect(plan.prefix).toBe(true);
  });

  it("falls back to ILIKE on a small un-indexed table", () => {
    expect(planSearch({ query: "roadmap", hasIndex: false, estimatedRows: 200 }).strategy).toBe(
      "ilike",
    );
  });

  it("uses the trigram tier on a large un-indexed table", () => {
    const plan = planSearch({ query: "roadmap", hasIndex: false, estimatedRows: 500_000 });
    expect(plan.strategy).toBe("trigram");
    expect(plan.prefix).toBe(false);
  });

  it("treats a missing or non-finite row estimate as small", () => {
    expect(planSearch({ query: "roadmap", hasIndex: false, estimatedRows: Number.NaN }).strategy).toBe(
      "ilike",
    );
    expect(planSearch({ query: "roadmap", hasIndex: false, estimatedRows: -5 }).strategy).toBe(
      "ilike",
    );
  });
});

describe("mergeRanked", () => {
  const exact: RankedInput[] = [
    { id: "a", rank: 10 },
    { id: "b", rank: 4, updatedAt: 100 },
  ];
  const prefix: RankedInput[] = [
    { id: "c", rank: 9 },
    { id: "d", rank: 1 },
  ];

  it("blends prefix hits at a fixed discount and orders by score", () => {
    const merged = mergeRanked(exact, prefix);
    expect(merged.map((hit) => hit.id)).toEqual(["a", "c", "b", "d"]);
    expect(merged.find((hit) => hit.id === "c")!.score).toBeCloseTo(4.5, 10);
    expect(merged.find((hit) => hit.id === "c")!.source).toBe("prefix");
    expect(merged.find((hit) => hit.id === "a")!.source).toBe("exact");
  });

  it("deduplicates by id, letting the exact hit win", () => {
    const merged = mergeRanked(
      [{ id: "a", rank: 5 }],
      [{ id: "a", rank: 99 }, { id: "b", rank: 8 }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((hit) => hit.id === "a")!.source).toBe("exact");
    expect(merged.find((hit) => hit.id === "a")!.score).toBe(5);
  });

  it("honours an explicit discount", () => {
    const merged = mergeRanked([{ id: "a", rank: 2 }], [{ id: "b", rank: 2 }], {
      discount: 1,
    });
    // Equal scores fall through to the id tie-break.
    expect(merged.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(merged.find((hit) => hit.id === "b")!.score).toBe(2);
  });

  it("breaks score ties by recency then id", () => {
    const merged = mergeRanked(
      [
        { id: "old", rank: 3, updatedAt: 1 },
        { id: "new", rank: 3, updatedAt: 2 },
        { id: "b", rank: 3 },
        { id: "a", rank: 3 },
      ],
      [],
    );
    expect(merged.map((hit) => hit.id)).toEqual(["new", "old", "a", "b"]);
  });

  it("returns the prefix hits when there are no exact hits", () => {
    const merged = mergeRanked([], [{ id: "x", rank: 4 }, { id: "y", rank: 2 }]);
    expect(merged.map((hit) => hit.id)).toEqual(["x", "y"]);
  });

  it("does not mutate the input arrays", () => {
    const a: RankedInput[] = [{ id: "a", rank: 1 }];
    const b: RankedInput[] = [{ id: "b", rank: 1 }];
    const snapshot = JSON.stringify([a, b]);
    mergeRanked(a, b);
    expect(JSON.stringify([a, b])).toBe(snapshot);
  });
});
