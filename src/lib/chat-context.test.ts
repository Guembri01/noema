import { describe, expect, it, vi } from "vitest";

/**
 * Pure unit tests for the chat context builder's sizing layer: the character
 * budget resolver and the priority-ordered `fitBlocks` trimmer. No DB access —
 * `@/lib/db` and `@/server/queries` are mocked purely so the module loads.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/server/queries", () => ({ searchPagesForPrompt: vi.fn() }));

import { DEFAULT_CONTEXT_CHARS, fitBlocks, resolveContextBudget } from "./chat-context";

describe("resolveContextBudget", () => {
  it("defaults to 60_000 characters", () => {
    expect(DEFAULT_CONTEXT_CHARS).toBe(60_000);
    expect(resolveContextBudget({})).toBe(60_000);
    expect(resolveContextBudget()).toBe(60_000);
  });

  it("reads a positive integer override", () => {
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "250000" })).toBe(250_000);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "  1200  " })).toBe(1200);
  });

  it("falls back to the default for anything that is not a positive integer", () => {
    for (const value of ["", " ", "0", "-1", "12.5", "abc", "10px", "1e5", "NaN"]) {
      expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: value })).toBe(DEFAULT_CONTEXT_CHARS);
    }
  });
});

describe("fitBlocks", () => {
  it("joins blocks with a blank line, in priority order", () => {
    expect(fitBlocks(["a", "b", "c"], 100)).toBe("a\n\nb\n\nc");
  });

  it("keeps the highest-priority blocks and drops from the end", () => {
    const blocks = ["alpha".repeat(10), "beta".repeat(10), "gamma".repeat(10)];
    const result = fitBlocks(blocks, 95);
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).not.toContain("gamma");
  });

  it("truncates the block that only partly fits rather than dropping it", () => {
    const result = fitBlocks(["short", "x".repeat(1000)], 100);
    expect(result.startsWith("short\n\n")).toBe(true);
    expect(result).toContain("… (context truncated)");
    expect(result).toContain("xxx");
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("respects the budget across a range of sizes", () => {
    const blocks = Array.from({ length: 30 }, (_, index) => `block-${index}-${"y".repeat(60)}`);
    for (const budget of [0, 5, 50, 500, 5_000, 60_000]) {
      const result = fitBlocks(blocks, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
    }
  });

  it("is deterministic and does not mutate its input", () => {
    const blocks = ["one", "two", "three"];
    const once = fitBlocks(blocks, 20);
    const twice = fitBlocks(blocks, 20);
    expect(once).toBe(twice);
    expect(blocks).toEqual(["one", "two", "three"]);
  });

  it("ignores empty blocks and returns '' for a non-positive budget", () => {
    expect(fitBlocks(["", "a", ""], 100)).toBe("a");
    expect(fitBlocks([], 100)).toBe("");
    expect(fitBlocks(["a"], 0)).toBe("");
    expect(fitBlocks(["a"], -10)).toBe("");
  });
});
