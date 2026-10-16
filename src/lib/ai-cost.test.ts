import { describe, expect, it } from "vitest";
import {
  DATA_BOUNDARY_POLICY,
  DataBoundaryError,
  FALLBACK_PRICE,
  PRICE_TABLE,
  assertDataBoundary,
  checkBudget,
  costOfUsage,
  describeBudget,
  estimateTokens,
  recordUsage,
  resetBudget,
  summarizeUsage,
  type BudgetRecord,
  type UsageEvent,
} from "@/lib/ai-cost";

/**
 * AI cost/token budget engine (docs/specs/ai-surface.md §14 AI cost controls,
 * AI data boundaries, §18 AI usage limits by plan).
 *
 * Pure, deterministic and provider-free: the price table, the token heuristic,
 * the per-request budget check, the usage ledger and the data-boundary guard.
 * No clock, no network, no DB, no `any`.
 *
 * Red-first: this file failed to import (`@/lib/ai-cost` did not exist) before
 * the implementation landed.
 */

const budget = (overrides: Partial<BudgetRecord> = {}): BudgetRecord => ({
  workspaceId: "ws1",
  period: "2026-10",
  limitTokens: 100_000,
  usedInput: 0,
  usedOutput: 0,
  spendUsd: 0,
  ...overrides,
});

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  model: "gpt-4o",
  inputTokens: 0,
  outputTokens: 0,
  ...overrides,
});

describe("estimateTokens", () => {
  it("returns 0 for empty or non-string input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(42 as unknown as string)).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });

  it("uses the documented ceil(chars / 4) heuristic", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });

  it("counts code points, so an astral emoji counts once, not twice", () => {
    expect(estimateTokens("😀")).toBe(1);
    expect(estimateTokens("😀😀😀😀😀")).toBe(2);
  });

  it("is deterministic across repeated calls", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});

describe("PRICE_TABLE", () => {
  it("exposes a non-empty table of positive per-million-token prices", () => {
    const entries = Object.entries(PRICE_TABLE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [model, price] of entries) {
      expect(model).not.toBe("");
      expect(price.inputPerMTokens).toBeGreaterThan(0);
      expect(price.outputPerMTokens).toBeGreaterThan(0);
    }
  });

  it("keeps output at least as expensive as input for every model", () => {
    for (const price of Object.values(PRICE_TABLE)) {
      expect(price.outputPerMTokens).toBeGreaterThanOrEqual(price.inputPerMTokens);
    }
  });

  it("ships a documented fallback price for unknown models", () => {
    expect(FALLBACK_PRICE.inputPerMTokens).toBeGreaterThan(0);
    expect(FALLBACK_PRICE.outputPerMTokens).toBeGreaterThan(0);
  });
});

describe("costOfUsage", () => {
  it("prices input tokens at the model's input rate", () => {
    expect(costOfUsage({ model: "gpt-4o", inputTokens: 1_000_000 })).toBeCloseTo(2.5, 10);
  });

  it("prices output tokens at the model's output rate", () => {
    expect(costOfUsage({ model: "gpt-4o", outputTokens: 1_000_000 })).toBeCloseTo(10, 10);
  });

  it("sums input and output cost for a mixed call", () => {
    expect(
      costOfUsage({ model: "gpt-4o", inputTokens: 500_000, outputTokens: 200_000 }),
    ).toBeCloseTo(1.25 + 2, 10);
  });

  it("uses the cheaper mini rates for a mini model", () => {
    expect(costOfUsage({ model: "gpt-4o-mini", inputTokens: 1_000_000 })).toBeCloseTo(0.15, 10);
  });

  it("falls back to the documented price for an unknown or missing model", () => {
    expect(costOfUsage({ model: "mystery-model", inputTokens: 1_000_000 })).toBeCloseTo(
      FALLBACK_PRICE.inputPerMTokens,
      10,
    );
    expect(costOfUsage({ inputTokens: 1_000_000 })).toBeCloseTo(
      FALLBACK_PRICE.inputPerMTokens,
      10,
    );
  });

  it("treats missing, negative and non-finite token counts as zero", () => {
    expect(costOfUsage({ model: "gpt-4o" })).toBe(0);
    expect(costOfUsage({ model: "gpt-4o", inputTokens: -500 })).toBe(0);
    expect(costOfUsage({ model: "gpt-4o", outputTokens: NaN })).toBe(0);
    expect(costOfUsage({ model: "gpt-4o", inputTokens: Infinity })).toBe(0);
  });
});

describe("recordUsage", () => {
  it("adds tokens and spend without mutating the input budget", () => {
    const before = budget();
    const after = recordUsage(before, event({ inputTokens: 1_000, outputTokens: 500 }));

    expect(after.usedInput).toBe(1_000);
    expect(after.usedOutput).toBe(500);
    expect(after.spendUsd).toBeCloseTo(0.0025 + 0.005, 10);
    expect(before).toEqual(budget());
    expect(after).not.toBe(before);
  });

  it("accumulates across events on the same period", () => {
    const first = recordUsage(budget(), event({ inputTokens: 1_000, outputTokens: 500 }));
    const second = recordUsage(first, event({ model: "gpt-4o-mini", inputTokens: 2_000 }));

    expect(second.usedInput).toBe(3_000);
    expect(second.usedOutput).toBe(500);
    expect(second.spendUsd).toBeCloseTo(0.0075 + 0.0003, 10);
    expect(second.period).toBe("2026-10");
  });

  it("rolls the period over before recording an event stamped with a new period", () => {
    const carried = budget({ usedInput: 5_000, usedOutput: 5_000, spendUsd: 0.5 });
    const rolled = recordUsage(carried, event({ inputTokens: 100, outputTokens: 50, period: "2026-11" }));

    expect(rolled.period).toBe("2026-11");
    expect(rolled.usedInput).toBe(100);
    expect(rolled.usedOutput).toBe(50);
    expect(rolled.spendUsd).toBeCloseTo(0.00025 + 0.0005, 10);
  });

  it("ignores negative and non-finite token counts instead of subtracting", () => {
    const after = recordUsage(
      budget({ usedInput: 10, usedOutput: 10 }),
      event({ inputTokens: -1_000, outputTokens: -1_000 }),
    );
    expect(after.usedInput).toBe(10);
    expect(after.usedOutput).toBe(10);
  });
});

describe("checkBudget", () => {
  it("allows a request comfortably under the limit and reports headroom", () => {
    const result = checkBudget(budget({ usedInput: 1_000, usedOutput: 1_000 }), {
      estimatedTokens: 5_000,
      model: "gpt-4o",
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.remainingTokens).toBe(98_000);
    expect(result.remainingUsd).toBeCloseTo((98_000 / 1_000_000) * 2.5, 10);
  });

  it("allows a request that lands exactly on the limit (inclusive boundary)", () => {
    const result = checkBudget(budget({ usedInput: 500, usedOutput: 0 }), {
      estimatedTokens: 99_500,
      model: "gpt-4o",
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("refuses a request one token over the limit", () => {
    const result = checkBudget(budget({ usedInput: 500 }), {
      estimatedTokens: 99_501,
      model: "gpt-4o",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("over_limit");
  });

  it("reports zero remaining tokens when the budget is already exhausted", () => {
    const result = checkBudget(budget({ usedInput: 60_000, usedOutput: 40_000 }), {
      estimatedTokens: 0,
      model: "gpt-4o",
    });
    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(0);
    expect(result.remainingUsd).toBe(0);
  });

  it("never reports negative remaining tokens once over the limit", () => {
    const result = checkBudget(budget({ usedInput: 150_000 }), {
      estimatedTokens: 1,
      model: "gpt-4o",
    });
    expect(result.allowed).toBe(false);
    expect(result.remainingTokens).toBe(0);
    expect(result.remainingUsd).toBe(0);
  });

  it("values remaining headroom with the fallback price for an unknown model", () => {
    const result = checkBudget(budget({ limitTokens: 1_000_000 }), {
      estimatedTokens: 1,
      model: "mystery-model",
    });
    expect(result.remainingUsd).toBeCloseTo(FALLBACK_PRICE.inputPerMTokens, 10);
  });
});

describe("resetBudget", () => {
  it("zeroes usage and spend while keeping the workspace and limit", () => {
    const carried = budget({
      workspaceId: "ws9",
      limitTokens: 250_000,
      usedInput: 5_000,
      usedOutput: 4_000,
      spendUsd: 3.5,
    });
    const reset = resetBudget(carried, { period: "2026-11" });

    expect(reset).toEqual({
      workspaceId: "ws9",
      period: "2026-11",
      limitTokens: 250_000,
      usedInput: 0,
      usedOutput: 0,
      spendUsd: 0,
    });
    expect(carried.usedInput).toBe(5_000);
  });

  it("makes an exhausted budget allow again after rollover", () => {
    const exhausted = budget({ usedInput: 100_000 });
    expect(checkBudget(exhausted, { estimatedTokens: 1, model: "gpt-4o" }).allowed).toBe(false);
    const rolled = resetBudget(exhausted, { period: "2026-11" });
    expect(checkBudget(rolled, { estimatedTokens: 1, model: "gpt-4o" }).allowed).toBe(true);
  });
});

describe("summarizeUsage", () => {
  const events: UsageEvent[] = [
    { model: "gpt-4o", inputTokens: 1_000, outputTokens: 500, surface: "chat", period: "2026-10" },
    { model: "gpt-4o", inputTokens: 2_000, outputTokens: 100, surface: "ask", period: "2026-10" },
    { model: "gpt-4o-mini", inputTokens: 500, outputTokens: 0, surface: "chat", period: "2026-09" },
  ];

  it("returns an empty list for no events", () => {
    expect(summarizeUsage([], { groupBy: "model" })).toEqual([]);
  });

  it("groups by model, aggregating tokens and spend, sorted by key", () => {
    const groups = summarizeUsage(events, { groupBy: "model" });

    expect(groups.map((group) => group.key)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const [gpt4o, mini] = groups;
    expect(gpt4o.calls).toBe(2);
    expect(gpt4o.inputTokens).toBe(3_000);
    expect(gpt4o.outputTokens).toBe(600);
    expect(gpt4o.totalTokens).toBe(3_600);
    expect(gpt4o.spendUsd).toBeCloseTo(0.0135, 10);
    expect(mini.calls).toBe(1);
    expect(mini.totalTokens).toBe(500);
    expect(mini.spendUsd).toBeCloseTo(0.000075, 10);
  });

  it("groups by surface and buckets a missing surface as unknown", () => {
    const groups = summarizeUsage([...events, { model: "gpt-4o" }], { groupBy: "surface" });
    expect(groups.map((group) => group.key)).toEqual(["ask", "chat", "unknown"]);
  });

  it("groups by period", () => {
    const groups = summarizeUsage(events, { groupBy: "period" });
    expect(groups.map((group) => group.key)).toEqual(["2026-09", "2026-10"]);
    expect(groups.find((group) => group.key === "2026-10")?.calls).toBe(2);
  });

  it("defaults an unknown group-by to model", () => {
    const groups = summarizeUsage(events, { groupBy: "nope" as unknown as "model" });
    expect(groups.map((group) => group.key)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

describe("DATA_BOUNDARY_POLICY", () => {
  it("states deny-by-default training, no prompt logging and encrypted keys", () => {
    expect(DATA_BOUNDARY_POLICY.defaultTraining).toBe("deny");
    expect(DATA_BOUNDARY_POLICY.requiresExplicitOptIn).toBe(true);
    expect(DATA_BOUNDARY_POLICY.promptsLogged).toBe(false);
    expect(DATA_BOUNDARY_POLICY.keysAtRest).toBe("AES-256-GCM");
  });
});

describe("assertDataBoundary", () => {
  it("allows a provider that does not train on submitted content", () => {
    const provider = { name: "ollama", trainsOnData: false };
    expect(assertDataBoundary({ provider })).toEqual(provider);
  });

  it("refuses a training-enabled provider without an explicit opt-in", () => {
    expect(() =>
      assertDataBoundary({ provider: { name: "trainer", trainsOnData: true } }),
    ).toThrow(DataBoundaryError);
  });

  it("carries a stable code and the offending provider on the refusal", () => {
    try {
      assertDataBoundary({ provider: { name: "trainer", trainsOnData: true } });
      throw new Error("expected assertDataBoundary to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataBoundaryError);
      const refusal = error as DataBoundaryError;
      expect(refusal.code).toBe("DATA_BOUNDARY_TRAINING");
      expect(refusal.provider).toBe("trainer");
    }
  });

  it("allows a training-enabled provider once explicitly opted in", () => {
    const provider = { name: "trainer", trainsOnData: true };
    expect(assertDataBoundary({ provider, allowTraining: true })).toEqual(provider);
  });

  it("treats an explicit allowTraining false as still refused", () => {
    expect(() =>
      assertDataBoundary({
        provider: { name: "trainer", trainsOnData: true },
        allowTraining: false,
      }),
    ).toThrow(DataBoundaryError);
  });
});

describe("describeBudget", () => {
  it("renders period, grouped token counts, percent and spend", () => {
    const described = describeBudget(
      budget({ period: "2026-10", limitTokens: 100_000, usedInput: 80_000, usedOutput: 7_000, spendUsd: 4.2 }),
    );
    expect(described).toBe(
      "AI budget 2026-10: 87,000 / 100,000 tokens used (87%), $4.20 spent, 13,000 remaining",
    );
  });

  it("handles an empty budget deterministically", () => {
    const described = describeBudget(budget({ period: "2026-01", limitTokens: 50_000 }));
    expect(described).toBe(
      "AI budget 2026-01: 0 / 50,000 tokens used (0%), $0.00 spent, 50,000 remaining",
    );
  });

  it("clamps remaining at zero for an over-budget workspace", () => {
    const described = describeBudget(budget({ usedInput: 200_000 }));
    expect(described).toContain("0 remaining");
    expect(described).toContain("(200%)");
  });
});
