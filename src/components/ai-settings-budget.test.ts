import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AiBudgetPanel,
  budgetUsage,
  formatTokens,
  type AiBudgetPanelData,
} from "./ai-settings-providers";

/**
 * R25.14 — the settings render seam.
 *
 * `AiBudgetPanel` is the presentational half of the dashboard: it takes the
 * summary `getAiBudgetSummary` returns and must show the budget state, the
 * warning/over message, the per-surface breakdown and locale-formatted
 * numbers. Keeping it free of the router and actions is what lets this render
 * without a Next runtime.
 */

const h = createElement;

function summary(overrides: Partial<AiBudgetPanelData> = {}): AiBudgetPanelData {
  return {
    period: "2026-10",
    configured: true,
    monthlyTokenLimit: 10_000,
    warnPercent: 80,
    hardStop: true,
    tokensIn: 300,
    tokensOut: 100,
    usedTokens: 400,
    requests: 4,
    failures: 0,
    remainingTokens: 9_600,
    percent: 4,
    state: "ok",
    bySurface: [
      { surface: "ask", tokensIn: 200, tokensOut: 60, requests: 2, failures: 0 },
      { surface: "chat", tokensIn: 100, tokensOut: 40, requests: 2, failures: 0 },
    ],
    ...overrides,
  };
}

function render(data: AiBudgetPanelData, locale = "en-US"): string {
  return renderToStaticMarkup(h(AiBudgetPanel, { summary: data, locale }));
}

describe("AiBudgetPanel — budget states", () => {
  it("renders the under-budget state with formatted totals", () => {
    const html = render(summary());

    expect(html).toContain('data-budget-state="ok"');
    expect(html).toContain('data-budget-period="2026-10"');
    expect(html).toContain("Within budget");
    expect(html).toContain("10,000");
    expect(html).toContain("4%");
    expect(html).toContain("9,600");
    expect(html).toContain("4 calls");
    expect(html).not.toContain("data-over-budget");
  });

  it("renders the warning state at the workspace threshold", () => {
    const html = render(
      summary({
        usedTokens: 8_500,
        tokensIn: 8_000,
        tokensOut: 500,
        remainingTokens: 1_500,
        percent: 85,
        state: "warn",
      }),
    );

    expect(html).toContain('data-budget-state="warn"');
    expect(html).toContain("Warning");
    expect(html).toContain("85%");
    expect(html).toContain("warning at");
    expect(html).toContain("text-warning");
  });

  it("renders the over-budget state and the hard-stop message", () => {
    const html = render(
      summary({
        usedTokens: 12_000,
        remainingTokens: 0,
        percent: 100,
        state: "over",
      }),
    );

    expect(html).toContain('data-budget-state="over"');
    expect(html).toContain("Over budget");
    expect(html).toContain('data-over-budget="true"');
    expect(html).toContain("new AI calls are refused");
    expect(html).toContain("bg-danger");
  });

  it("says a soft budget still runs when hardStop is off", () => {
    const html = render(
      summary({
        hardStop: false,
        usedTokens: 12_000,
        percent: 100,
        state: "over",
      }),
    );

    expect(html).toContain("soft limit — calls still run");
  });

  it("renders the unconfigured state without inventing a limit", () => {
    const html = render(
      summary({
        configured: false,
        monthlyTokenLimit: 0,
        percent: 0,
        remainingTokens: 0,
        state: "unset",
        bySurface: [],
      }),
    );

    expect(html).toContain('data-budget-state="unset"');
    expect(html).toContain("No limit");
    expect(html).toContain("No monthly token budget is set");
    expect(html).toContain("No AI calls have been recorded");
    expect(html).not.toContain("data-over-budget");
  });
});

describe("AiBudgetPanel — per-surface breakdown", () => {
  it("renders one row per surface with tokens and calls", () => {
    const html = render(summary());

    expect(html).toContain('data-budget-surface="ask"');
    expect(html).toContain('data-budget-surface="chat"');
    expect(html).toContain("260");
    expect(html).toContain("140");
  });

  it("marks failed calls in a surface row", () => {
    const html = render(
      summary({
        failures: 2,
        bySurface: [{ surface: "autofill", tokensIn: 0, tokensOut: 0, requests: 2, failures: 2 }],
      }),
    );

    expect(html).toContain('data-budget-surface="autofill"');
    expect(html).toContain("2 failed");
  });
});

describe("budgetUsage — warning threshold", () => {
  it("defaults to 80% and accepts the workspace's own threshold", () => {
    expect(budgetUsage(500, 1000).tone).toBe("success");
    expect(budgetUsage(800, 1000).tone).toBe("accent");
    expect(budgetUsage(500, 1000, 40).tone).toBe("accent");
    expect(budgetUsage(1200, 1000).tone).toBe("danger");
  });
});

describe("formatTokens", () => {
  it("groups digits and falls back safely for garbage", () => {
    expect(formatTokens(1234, "en-US")).toBe("1,234");
    expect(formatTokens(0, "en-US")).toBe("0");
    expect(formatTokens(Number.NaN, "en-US")).toBe("0");
    expect(formatTokens(-50, "en-US")).toBe("0");
  });
});
