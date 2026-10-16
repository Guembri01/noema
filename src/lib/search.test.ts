import { describe, expect, it } from "vitest";
import { pageSearchText } from "./search";

/**
 * The plain-text mirror is what Postgres full-text search indexes, so it must
 * preserve *every* occurrence of a term: `ts_rank_cd` (see `queries.ts`) scores
 * on term frequency, and de-duplicating tokens here would flatten the ranking.
 */
describe("pageSearchText", () => {
  const doc = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  it("keeps every occurrence of a repeated term (term frequency survives)", () => {
    const mirror = pageSearchText("Zebra", doc("quixotic quixotic quixotic zebra"));
    expect(mirror.match(/quixotic/g)).toHaveLength(3);
  });

  it("includes both the title and the flattened body", () => {
    const mirror = pageSearchText("Release notes", doc("the quarterly roadmap"));
    expect(mirror).toContain("Release notes");
    expect(mirror).toContain("the quarterly roadmap");
  });

  it("collapses whitespace and trims", () => {
    const mirror = pageSearchText("  Spaced  ", doc("a\n\n\nb"));
    expect(mirror).toBe("Spaced a b");
  });
});
