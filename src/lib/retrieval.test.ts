import { describe, expect, it } from "vitest";
import { promptTerms, scorePage, snippetAround } from "./retrieval";

describe("promptTerms", () => {
  it("drops stopwords and instruction words", () => {
    const terms = promptTerms(
      "Please reply with only the launch code mentioned in the quokka programme",
    );
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("reply");
    expect(terms).not.toContain("please");
    expect(terms).not.toContain("code"); // instruction noise
    expect(terms).not.toContain("mentioned");
    expect(terms).toContain("launch");
    expect(terms).toContain("quokka");
    expect(terms).toContain("programme");
  });

  it("keeps at most the limit, in order, without duplicates", () => {
    const terms = promptTerms("alpha beta alpha gamma delta epsilon zeta eta theta", 4);
    expect(terms).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("handles punctuation, accents and empty input", () => {
    expect(promptTerms("Quokka, café — TANGERINE-42!")).toEqual([
      "quokka",
      "café",
      "tangerine-42",
    ]);
    expect(promptTerms("")).toEqual([]);
    expect(promptTerms("a b c")).toEqual([]);
  });
});

describe("scorePage", () => {
  it("weights title matches above body matches", () => {
    const inTitle = scorePage(["quokka"], "Quokka programme", "");
    const inBody = scorePage(["quokka"], "Notes", "the quokka programme");
    expect(inTitle.score).toBeGreaterThan(inBody.score);
    expect(inTitle.matched).toEqual(["quokka"]);
  });

  it("scores zero when nothing matches", () => {
    expect(scorePage(["zebra"], "Notes", "nothing here").score).toBe(0);
  });

  it("caps repeated body hits", () => {
    const many = scorePage(["quokka"], "Notes", "quokka ".repeat(10));
    expect(many.score).toBeLessThanOrEqual(2);
  });
});

describe("snippetAround", () => {
  it("centres the excerpt on the term", () => {
    const text = `${"x".repeat(200)} LAUNCH CODE IS TANGERINE-42 ${"y".repeat(200)}`;
    const snippet = snippetAround(text, "tangerine-42", 20);
    expect(snippet).toContain("TANGERINE-42");
    expect(snippet.length).toBeLessThan(120);
  });

  it("falls back to the head of the text when the term is missing", () => {
    expect(snippetAround("short text", "missing", 5)).toBe("short text");
    expect(snippetAround("", "")).toBe("");
  });
});
