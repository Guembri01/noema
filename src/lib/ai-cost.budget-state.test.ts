import { describe, expect, it } from "vitest";
import { evaluateBudget } from "@/lib/ai-cost";

/**
 * R25.13 — budget math at the boundaries.
 *
 * `evaluateBudget` is the single pure verdict used by the transport guard and
 * the settings dashboard. These cases pin the inclusive ceiling, the warn
 * threshold, the soft (`hardStop: false`) mode and the fail-safe handling of
 * garbage input.
 */

const base = {
  usedTokens: 0,
  limitTokens: 1000,
  warnPercent: 80,
  estimateTokens: 0,
  hardStop: true,
} as const;

describe("evaluateBudget — under the limit", () => {
  it("allows a request with headroom and reports the remaining tokens", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 200, estimateTokens: 100 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.state).toBe("ok");
    expect(verdict.percent).toBe(20);
    expect(verdict.remainingTokens).toBe(800);
    expect(verdict.projectedTokens).toBe(300);
  });

  it("treats a zero limit as unlimited (enforcement disabled)", () => {
    const verdict = evaluateBudget({
      usedTokens: 9_999,
      limitTokens: 0,
      warnPercent: 80,
      estimateTokens: 5_000,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.state).toBe("ok");
    expect(verdict.percent).toBe(0);
    expect(verdict.remainingTokens).toBe(0);
  });
});

describe("evaluateBudget — warn threshold", () => {
  it("stays ok just below the warning threshold", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 799 });
    expect(verdict.state).toBe("ok");
    expect(verdict.allowed).toBe(true);
  });

  it("warns exactly at the threshold (>= comparison)", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 800 });
    expect(verdict.state).toBe("warn");
    expect(verdict.allowed).toBe(true);
    expect(verdict.remainingTokens).toBe(200);
  });

  it("honours a custom threshold and clamps absurd values", () => {
    expect(evaluateBudget({ ...base, usedTokens: 400, warnPercent: 40 }).state).toBe("warn");
    expect(evaluateBudget({ ...base, usedTokens: 400, warnPercent: 41 }).state).toBe("ok");
    expect(evaluateBudget({ ...base, usedTokens: 400, warnPercent: -10 }).state).toBe("ok");
    expect(evaluateBudget({ ...base, usedTokens: 900, warnPercent: 250 }).state).toBe("warn");
    // A non-numeric threshold falls back to 80.
    expect(
      evaluateBudget({
        ...base,
        usedTokens: 850,
        warnPercent: Number.NaN,
      }).state,
    ).toBe("warn");
  });
});

describe("evaluateBudget — the limit is a ceiling, not a wall", () => {
  it("allows a request that lands exactly on the limit", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 900, estimateTokens: 100 });
    expect(verdict.projectedTokens).toBe(1000);
    expect(verdict.allowed).toBe(true);
    // The display meter follows the tokens already used (90%), not the estimate.
    expect(verdict.state).toBe("warn");
    expect(verdict.percent).toBe(90);
    expect(verdict.remainingTokens).toBe(100);
  });

  it("refuses a request one token past the limit", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 900, estimateTokens: 101 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe("over");
    expect(verdict.remainingTokens).toBe(100);
  });

  it("reports an already-over workspace even with a zero estimate", () => {
    const verdict = evaluateBudget({ ...base, usedTokens: 1001 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe("over");
    // The meter is capped at 100% for display; remaining never goes negative.
    expect(verdict.percent).toBe(100);
    expect(verdict.remainingTokens).toBe(0);
  });
});

describe("evaluateBudget — soft budgets", () => {
  it("dispatches over the limit but still reports over", () => {
    const verdict = evaluateBudget({
      ...base,
      usedTokens: 1200,
      estimateTokens: 50,
      hardStop: false,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.state).toBe("over");
    expect(verdict.hardStop).toBe(false);
  });

  it("defaults hardStop to true when omitted", () => {
    expect(
      evaluateBudget({ usedTokens: 1001, limitTokens: 1000, estimateTokens: 0 }).hardStop,
    ).toBe(true);
  });
});

describe("evaluateBudget — fail-safe input", () => {
  it("coerces negative, fractional and non-finite counts", () => {
    const verdict = evaluateBudget({
      usedTokens: -50,
      limitTokens: 100.9,
      estimateTokens: Number.NaN,
      warnPercent: 80,
    });
    expect(verdict.usedTokens).toBe(0);
    expect(verdict.limitTokens).toBe(100);
    expect(verdict.estimatedTokens).toBe(0);
    expect(verdict.percent).toBe(0);
  });
});
