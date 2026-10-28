import { describe, expect, it } from "vitest";
import { searchHref } from "./live-search";

describe("searchHref", () => {
  it("builds a query URL and trims the input", () => {
    expect(searchHref("/w/acme/search", "  roadmap  ")).toBe(
      "/w/acme/search?q=roadmap",
    );
  });

  it("keeps the type filter", () => {
    expect(searchHref("/w/acme/search", "roadmap", "database")).toBe(
      "/w/acme/search?q=roadmap&type=database",
    );
  });

  it("returns the bare path for an empty query", () => {
    expect(searchHref("/w/acme/search", "   ")).toBe("/w/acme/search");
    expect(searchHref("/w/acme/search", "", "page")).toBe(
      "/w/acme/search?type=page",
    );
  });
});
