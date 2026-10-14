import { describe, expect, it } from "vitest";
import {
  filterCandidates,
  highlightRanges,
  rankCandidates,
  splitByKind,
  type Candidate,
} from "./mention-candidates";

/**
 * F6 — `@`-mention candidate ranking (red-first).
 *
 * `src/lib/mention-candidates.ts` did not exist when this file was written, so
 * the whole suite fails on the missing module until the helpers land. They are
 * the pure picker layer above the raw candidate rows: narrow the list to what
 * the query matches while dropping the page itself and ids already mentioned
 * (`filterCandidates`), order what survives so prefix hits and recent items
 * float to the top (`rankCandidates`), turn a title + query into highlight
 * spans for the row renderer (`highlightRanges`), and group the result into the
 * pages/people sections the menu draws (`splitByKind`).
 *
 * Everything is plain rows in / plain rows out: no DB, no DOM, and the caller's
 * arrays and objects are never mutated. Ranking is deterministic — the input
 * order breaks ties.
 */

const cand = (id: string, title: string, kind: Candidate["kind"] = "page", extra: Partial<Candidate> = {}): Candidate => ({
  id,
  title,
  kind,
  ...extra,
});

/** A mixed page/user pool reused across the suites. */
const pool: Candidate[] = [
  cand("p1", "Roadmap", "page"),
  cand("p2", "Product roadmap", "page"),
  cand("p3", "Team offsite", "page", { subtitle: "Travel", recent: true }),
  cand("u1", "Ada Lovelace", "user"),
  cand("u2", "Alan Turing", "user", { recent: true }),
];

describe("filterCandidates", () => {
  it("matches the query case-insensitively against the title", () => {
    expect(filterCandidates(pool, "road").map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(filterCandidates(pool, "ROADMAP").map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("matches the query anywhere in a title, not just at the front", () => {
    expect(filterCandidates(pool, "turing").map((c) => c.id)).toEqual(["u2"]);
  });

  it("returns everything (capped) for a blank or whitespace query", () => {
    expect(filterCandidates(pool, "", { limit: 100 }).map((c) => c.id)).toEqual(pool.map((c) => c.id));
    expect(filterCandidates(pool, "   ", { limit: 100 }).map((c) => c.id)).toEqual(pool.map((c) => c.id));
  });

  it("returns [] when nothing matches", () => {
    expect(filterCandidates(pool, "zzz")).toEqual([]);
  });

  it("drops ids in excludeIds — the page itself and ids already mentioned", () => {
    expect(filterCandidates(pool, "a", { excludeIds: ["p1", "u1"], limit: 100 }).map((c) => c.id)).toEqual([
      "p2",
      "p3",
      "u2",
    ]);
  });

  it("accepts any iterable of excluded ids", () => {
    const excluded = new Set(["u1", "u2"]);
    expect(filterCandidates(pool, "", { excludeIds: excluded, limit: 100 }).every((c) => c.kind === "page")).toBe(true);
  });

  it("restricts to the requested kinds when given", () => {
    expect(filterCandidates(pool, "a", { kinds: ["user"], limit: 100 }).map((c) => c.id)).toEqual(["u1", "u2"]);
    expect(filterCandidates(pool, "a", { kinds: ["page"], limit: 100 }).map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("treats an omitted or empty kinds list as no kind restriction", () => {
    expect(filterCandidates(pool, "a", { limit: 100 })).toHaveLength(filterCandidates(pool, "a", { kinds: [], limit: 100 }).length);
    expect(filterCandidates(pool, "a", { kinds: [], limit: 100 })).toHaveLength(5);
  });

  it("combines excludeIds, kinds and the query", () => {
    expect(
      filterCandidates(pool, "a", { excludeIds: ["p1"], kinds: ["page"], limit: 100 }).map((c) => c.id),
    ).toEqual(["p2", "p3"]);
  });

  it("caps the result at limit, defaulting to ten", () => {
    expect(filterCandidates(pool, "", { limit: 2 }).map((c) => c.id)).toEqual(["p1", "p2"]);
    const many = Array.from({ length: 15 }, (_, i) => cand(`x${i}`, `Note ${i}`));
    expect(filterCandidates(many, "", {})).toHaveLength(10);
  });

  it("returns [] for a non-positive limit and preserves input order otherwise", () => {
    expect(filterCandidates(pool, "", { limit: 0 })).toEqual([]);
    expect(filterCandidates(pool, "", { limit: -3 })).toEqual([]);
    const ordered = filterCandidates(pool, "a", { limit: 100 }).map((c) => c.id);
    expect(ordered).toEqual(["p1", "p2", "p3", "u1", "u2"]);
  });

  it("does not mutate the candidate rows", () => {
    const rows = pool.map((c) => ({ ...c }));
    filterCandidates(rows, "road", { excludeIds: ["p1"], kinds: ["page"], limit: 1 });
    expect(rows).toEqual(pool);
  });
});

describe("rankCandidates", () => {
  it("ranks exact, then prefix, then substring matches", () => {
    const rows = [cand("sub", "My roadmap"), cand("pre", "Roadmap draft"), cand("exact", "Roadmap")];
    expect(rankCandidates(rows, "roadmap").map((c) => c.id)).toEqual(["exact", "pre", "sub"]);
  });

  it("ranks a title-word prefix above a mid-word substring", () => {
    const rows = [cand("mid", "Undergrowth"), cand("word", "Growth plan")];
    expect(rankCandidates(rows, "growth").map((c) => c.id)).toEqual(["word", "mid"]);
  });

  it("boosts recent candidates within the same match tier", () => {
    const rows = [cand("old", "Roadmap old"), cand("fresh", "Roadmap fresh", "page", { recent: true })];
    expect(rankCandidates(rows, "roadmap").map((c) => c.id)).toEqual(["fresh", "old"]);
  });

  it("lists recent candidates first when the query is blank", () => {
    const rows = [
      cand("a", "Alpha"),
      cand("b", "Bravo", "page", { recent: true }),
      cand("c", "Charlie", "page", { recent: true }),
    ];
    expect(rankCandidates(rows, "").map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the caller's order as a stable tiebreak for equal tier and recency", () => {
    const rows = [cand("first", "Design spec"), cand("second", "Design doc"), cand("third", "Design notes")];
    expect(rankCandidates(rows, "design").map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic and does not mutate the input", () => {
    const rows = pool.map((c) => ({ ...c }));
    const a = rankCandidates(rows, "a");
    const b = rankCandidates(rows, "a");
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(rows).toEqual(pool);
  });
});

describe("highlightRanges", () => {
  it("locates a single mid-title occurrence with an exclusive end", () => {
    expect(highlightRanges("Product roadmap", "road")).toEqual([{ start: 8, end: 12 }]);
  });

  it("is case-insensitive and matches the typed casing's span in the title", () => {
    expect(highlightRanges("Roadmap", "road")).toEqual([{ start: 0, end: 4 }]);
    expect(highlightRanges("roadmap", "ROAD")).toEqual([{ start: 0, end: 4 }]);
  });

  it("returns every occurrence in order", () => {
    expect(highlightRanges("road by the road", "road")).toEqual([
      { start: 0, end: 4 },
      { start: 12, end: 16 },
    ]);
  });

  it("returns [] for a blank query or no match", () => {
    expect(highlightRanges("Roadmap", "")).toEqual([]);
    expect(highlightRanges("Roadmap", "   ")).toEqual([]);
    expect(highlightRanges("Roadmap", "zzz")).toEqual([]);
  });

  it("does not mutate or slice the title", () => {
    const title = "Roadmap";
    expect(highlightRanges(title, "map")).toEqual([{ start: 4, end: 7 }]);
    expect(title).toBe("Roadmap");
  });
});

describe("splitByKind", () => {
  it("groups pages and users preserving order", () => {
    const { pages, users } = splitByKind(pool);
    expect(pages.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
    expect(users.map((c) => c.id)).toEqual(["u1", "u2"]);
  });

  it("copes with a single kind and an empty list", () => {
    expect(splitByKind([cand("u1", "Ada", "user")])).toEqual({
      pages: [],
      users: [cand("u1", "Ada", "user")],
    });
    expect(splitByKind([])).toEqual({ pages: [], users: [] });
  });

  it("returns fresh arrays and leaves the input untouched", () => {
    const rows = pool.map((c) => ({ ...c }));
    const { pages } = splitByKind(rows);
    expect(pages).not.toBe(rows);
    expect(rows).toEqual(pool);
  });
});
