import { describe, expect, it } from "vitest";
import {
  allocateIds,
  formatUniqueId,
  hasUniqueId,
  isValidPrefix,
  nextNumbers,
  parseUniqueId,
} from "@/lib/unique-id";
import type { ParsedUniqueId, UniqueIdConfig, UniqueIdParseError } from "@/lib/unique-id";

/** Assert a parse returned a specific error without losing type narrowing. */
function expectParseError(result: ParsedUniqueId, error: UniqueIdParseError) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(error);
}

describe("formatUniqueId", () => {
  it("zero-pads to the default width of 4", () => {
    expect(formatUniqueId({ prefix: "PROJ" }, 1)).toBe("PROJ-0001");
    expect(formatUniqueId({ prefix: "PROJ" }, 42)).toBe("PROJ-0042");
  });

  it("honours custom separator, zeroPad and startAt", () => {
    expect(formatUniqueId({ prefix: "T", zeroPad: 2, separator: "_" }, 7)).toBe("T_07");
    expect(formatUniqueId({ prefix: "AB", zeroPad: 6, separator: "." }, 3)).toBe("AB.000003");
  });

  it("crosses 10000 without truncating", () => {
    expect(formatUniqueId({ prefix: "PROJ" }, 10_000)).toBe("PROJ-10000");
    expect(formatUniqueId({ prefix: "PROJ" }, 123_456)).toBe("PROJ-123456");
  });

  it("rejects numbers that are not positive integers", () => {
    expect(() => formatUniqueId({ prefix: "A" }, 0)).toThrow();
    expect(() => formatUniqueId({ prefix: "A" }, 1.5)).toThrow();
    expect(() => formatUniqueId({ prefix: "A" }, Number.NaN)).toThrow();
  });
});

describe("parseUniqueId", () => {
  it("parses a canonical id", () => {
    const result = parseUniqueId("PROJ-0042", { prefix: "PROJ" });
    expect(result).toEqual({ ok: true, number: 42 });
  });

  it("round-trips formatUniqueId, including across 10000", () => {
    const config: UniqueIdConfig = { prefix: "PROJ" };
    for (const n of [1, 42, 9999, 10_000]) {
      const parsed = parseUniqueId(formatUniqueId(config, n), config);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.number).toBe(n);
    }
  });

  it("matches the prefix case-insensitively", () => {
    const result = parseUniqueId("proj-0042", { prefix: "PROJ" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.number).toBe(42);
    expect(parseUniqueId("PROJ-0042", { prefix: "proj" }).ok).toBe(true);
  });

  it("rejects a mismatched prefix", () => {
    expectParseError(parseUniqueId("TASK-0042", { prefix: "PROJ" }), "wrong_prefix");
    expectParseError(parseUniqueId("PRO-0042", { prefix: "PROJ" }), "wrong_prefix");
  });

  it("rejects a mismatched separator", () => {
    expectParseError(parseUniqueId("PROJ:0042", { prefix: "PROJ" }), "wrong_separator");
    expectParseError(parseUniqueId("PROJ_0042", { prefix: "PROJ" }), "wrong_separator");
    expectParseError(parseUniqueId("PROJ0042", { prefix: "PROJ" }), "wrong_separator");
    // Custom separator is exact: the default dash no longer matches.
    expectParseError(parseUniqueId("PROJ-0042", { prefix: "PROJ", separator: ":" }), "wrong_separator");
    expect(parseUniqueId("PROJ:0042", { prefix: "PROJ", separator: ":" }).ok).toBe(true);
  });

  it("rejects letters or junk in the numeric part", () => {
    expectParseError(parseUniqueId("PROJ-00A2", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042abc", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042 ", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042-1", { prefix: "PROJ" }), "invalid_number");
  });

  it("enforces the zeroPad minimum and a positive value", () => {
    expectParseError(parseUniqueId("PROJ-42", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042", { prefix: "PROJ", zeroPad: 6 }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0000", { prefix: "PROJ" }), "invalid_number");
    expect(parseUniqueId("PROJ-00042", { prefix: "PROJ" }).ok).toBe(true);
  });

  it("rejects empty input", () => {
    expectParseError(parseUniqueId("", { prefix: "PROJ" }), "empty");
    expectParseError(parseUniqueId("   ", { prefix: "PROJ" }), "empty");
  });
});

describe("nextNumbers", () => {
  it("starts at startAt for an empty list", () => {
    expect(nextNumbers({ prefix: "PROJ" }, [])).toEqual([1]);
    expect(nextNumbers({ prefix: "PROJ", startAt: 10 }, [])).toEqual([10]);
  });

  it("continues after the max, so gaps and deletions don't reuse ids", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0001", "PROJ-0002", "PROJ-0007"])).toEqual([8]);
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0009", "PROJ-0003"])).toEqual([10]);
  });

  it("ignores unparseable entries without throwing", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["nonsense", "PROJ-0003", "", "PROJ-99"])).toEqual([4]);
    expect(nextNumbers({ prefix: "PROJ" }, ["", "   "])).toEqual([1]);
  });

  it("returns consecutive numbers for a count", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0004"], 3)).toEqual([5, 6, 7]);
    expect(nextNumbers({ prefix: "PROJ" }, [], 0)).toEqual([]);
  });

  it("never dips below startAt", () => {
    expect(nextNumbers({ prefix: "PROJ", startAt: 100 }, ["PROJ-0005"])).toEqual([100]);
  });
});

describe("allocateIds", () => {
  it("allocates a unique, monotonic batch", () => {
    const first = allocateIds({ prefix: "PROJ" }, ["PROJ-0001", "PROJ-0002"], 3);
    expect(first).toEqual(["PROJ-0003", "PROJ-0004", "PROJ-0005"]);
    const second = allocateIds({ prefix: "PROJ" }, [...first], 2);
    expect(second).toEqual(["PROJ-0006", "PROJ-0007"]);
    expect(new Set([...first, ...second]).size).toBe(5);
  });
});

describe("hasUniqueId", () => {
  it("compares case-insensitively", () => {
    const existing = ["PROJ-0001", "proj-0002"];
    expect(hasUniqueId(existing, "PROJ-0002")).toBe(true);
    expect(hasUniqueId(existing, "proj-0002")).toBe(true);
    expect(hasUniqueId(existing, "PROJ-0003")).toBe(false);
    expect(hasUniqueId(existing, "")).toBe(false);
  });
});

describe("isValidPrefix", () => {
  it("accepts word-character prefixes", () => {
    expect(isValidPrefix("PROJ")).toBe(true);
    expect(isValidPrefix("p1")).toBe(true);
    expect(isValidPrefix("TEAM_2")).toBe(true);
  });

  it("rejects empty, spaced, separator-bearing or non-string prefixes", () => {
    expect(isValidPrefix("")).toBe(false);
    expect(isValidPrefix("   ")).toBe(false);
    expect(isValidPrefix("PRO J")).toBe(false);
    expect(isValidPrefix("PRO-J")).toBe(false);
    expect(isValidPrefix("PROJ:")).toBe(false);
    expect(isValidPrefix(42)).toBe(false);
  });
});
