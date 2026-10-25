import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.12–R25.14 — durable metering.
 *
 * The database is an in-memory stand-in for `AiBudget`/`AiUsage`, so the real
 * accumulation, period scoping, guard boundaries and reset logic run. The
 * store mirrors the two operations the implementation relies on: an aggregate
 * over `(workspace, period)` and an upsert whose `increment`s accumulate.
 */

type BudgetRow = { monthlyTokenLimit: number; warnPercent: number; hardStop: boolean };
type UsageRow = {
  id: string;
  workspaceId: string;
  period: string;
  surface: string;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  failures: number;
};

const { state, prisma } = vi.hoisted(() => {
  const state = {
    budgets: new Map<string, BudgetRow>(),
    usage: [] as UsageRow[],
    nextId: 1,
  };

  const prisma = {
    aiBudget: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId: string } }) => {
        return state.budgets.get(where.workspaceId) ?? null;
      }),
    },
    aiUsage: {
      aggregate: vi.fn(async ({
        where,
      }: {
        where: { workspaceId: string; period: string };
      }) => {
        const rows = state.usage.filter(
          (row) => row.workspaceId === where.workspaceId && row.period === where.period,
        );
        return {
          _sum: {
            tokensIn: rows.reduce((sum, row) => sum + row.tokensIn, 0),
            tokensOut: rows.reduce((sum, row) => sum + row.tokensOut, 0),
            requests: rows.reduce((sum, row) => sum + row.requests, 0),
          },
        };
      }),
      upsert: vi.fn(async ({
        where,
        create,
        update,
      }: {
        where: {
          workspaceId_period_surface: {
            workspaceId: string;
            period: string;
            surface: string;
          };
        };
        create: Omit<UsageRow, "id">;
        update: {
          tokensIn?: { increment: number };
          tokensOut?: { increment: number };
          requests?: { increment: number };
          failures?: { increment: number };
        };
      }) => {
        const key = where.workspaceId_period_surface;
        let row = state.usage.find(
          (entry) =>
            entry.workspaceId === key.workspaceId &&
            entry.period === key.period &&
            entry.surface === key.surface,
        );
        if (!row) {
          row = { id: `usage-${state.nextId++}`, ...create };
          state.usage.push(row);
          return row;
        }
        row.tokensIn += update.tokensIn?.increment ?? 0;
        row.tokensOut += update.tokensOut?.increment ?? 0;
        row.requests += update.requests?.increment ?? 0;
        row.failures += update.failures?.increment ?? 0;
        return row;
      }),
      findMany: vi.fn(async ({
        where,
      }: {
        where: { workspaceId: string; period: string };
      }) => {
        return state.usage
          .filter((row) => row.workspaceId === where.workspaceId && row.period === where.period)
          .sort((a, b) => (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0))
          .map((row) => ({
            surface: row.surface,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
            requests: row.requests,
            failures: row.failures,
          }));
      }),
      deleteMany: vi.fn(async ({
        where,
      }: {
        where: { workspaceId: string; period: string };
      }) => {
        const before = state.usage.length;
        state.usage = state.usage.filter(
          (row) => !(row.workspaceId === where.workspaceId && row.period === where.period),
        );
        return { count: before - state.usage.length };
      }),
    },
  };

  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma }));

import {
  budgetPeriod,
  checkWorkspaceBudget,
  getWorkspaceUsageSummary,
  loadWorkspaceBudget,
  normalizeBudgetInput,
  normalizeSurface,
  recordAiUsage,
  resetWorkspaceUsage,
} from "@/lib/ai-metering";

const WORKSPACE = "clx1a2b3c4d5e6f7g8h9i0jkl";
const OCTOBER = new Date("2026-10-15T12:00:00Z");
const NOVEMBER = new Date("2026-11-02T08:00:00Z");

function setBudget(overrides: Partial<BudgetRow> = {}) {
  state.budgets.set(WORKSPACE, {
    monthlyTokenLimit: 1000,
    warnPercent: 80,
    hardStop: true,
    ...overrides,
  });
}

function addUsage(
  input: Partial<UsageRow> & { period: string; tokensIn: number; tokensOut: number },
) {
  state.usage.push({
    id: `seed-${state.nextId++}`,
    workspaceId: WORKSPACE,
    surface: "chat",
    requests: 1,
    failures: 0,
    ...input,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.budgets.clear();
  state.usage.length = 0;
  state.nextId = 1;
});

describe("budgetPeriod", () => {
  it("keys usage by the UTC calendar month", () => {
    expect(budgetPeriod(OCTOBER)).toBe("2026-10");
    expect(budgetPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(budgetPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    // A local-time date near midnight must still read UTC.
    expect(budgetPeriod(new Date("2026-10-01T00:30:00+02:00"))).toBe("2026-09");
  });
});

describe("loadWorkspaceBudget", () => {
  it("returns null when the workspace has no budget row", async () => {
    expect(await loadWorkspaceBudget(WORKSPACE, OCTOBER)).toBeNull();
  });

  it("sums only the current period's counters", async () => {
    setBudget();
    addUsage({ period: "2026-10", tokensIn: 100, tokensOut: 50 });
    addUsage({ period: "2026-09", tokensIn: 500, tokensOut: 500 });

    const budget = await loadWorkspaceBudget(WORKSPACE, OCTOBER);

    expect(budget).toMatchObject({
      workspaceId: WORKSPACE,
      period: "2026-10",
      limitTokens: 1000,
      warnPercent: 80,
      hardStop: true,
      usedInput: 100,
      usedOutput: 50,
      requests: 1,
    });
    expect(prisma.aiUsage.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE, period: "2026-10" } }),
    );
  });

  it("keeps a zero limit as configured-and-unlimited instead of falling back", async () => {
    setBudget({ monthlyTokenLimit: 0 });
    const budget = await loadWorkspaceBudget(WORKSPACE, OCTOBER);
    expect(budget?.limitTokens).toBe(0);
    const guard = await checkWorkspaceBudget(WORKSPACE, 999_999, OCTOBER);
    expect(guard.configured).toBe(true);
    expect(guard.allowed).toBe(true);
    expect(guard.state).toBe("ok");
  });

  it("does not guess for a blank workspace id", async () => {
    setBudget();
    expect(await loadWorkspaceBudget("", OCTOBER)).toBeNull();
    expect(prisma.aiBudget.findUnique).not.toHaveBeenCalled();
  });
});

describe("checkWorkspaceBudget — boundaries", () => {
  it("allows an under-limit request with ok state", async () => {
    setBudget();
    addUsage({ period: "2026-10", tokensIn: 300, tokensOut: 200 });

    const guard = await checkWorkspaceBudget(WORKSPACE, 100, OCTOBER);

    expect(guard).toMatchObject({
      configured: true,
      allowed: true,
      state: "ok",
      usedTokens: 500,
      estimatedTokens: 100,
      remainingTokens: 500,
      percent: 50,
      period: "2026-10",
    });
    expect(guard.code).toBeUndefined();
  });

  it("warns at exactly the warn threshold", async () => {
    setBudget({ warnPercent: 80 });
    addUsage({ period: "2026-10", tokensIn: 600, tokensOut: 200 });

    const guard = await checkWorkspaceBudget(WORKSPACE, 0, OCTOBER);

    expect(guard.allowed).toBe(true);
    expect(guard.state).toBe("warn");
    expect(guard.percent).toBe(80);
  });

  it("refuses an over-limit request with the typed budget code", async () => {
    setBudget();
    addUsage({ period: "2026-10", tokensIn: 900, tokensOut: 0 });

    const guard = await checkWorkspaceBudget(WORKSPACE, 101, OCTOBER);

    expect(guard.allowed).toBe(false);
    expect(guard.state).toBe("over");
    expect(guard.code).toBe("AI_BUDGET_EXCEEDED");
  });

  it("allows a request that lands exactly on the limit", async () => {
    setBudget();
    addUsage({ period: "2026-10", tokensIn: 900, tokensOut: 0 });

    const guard = await checkWorkspaceBudget(WORKSPACE, 100, OCTOBER);

    expect(guard.allowed).toBe(true);
    expect(guard.projectedTokens).toBe(1000);
  });

  it("dispatches a soft budget over the limit", async () => {
    setBudget({ hardStop: false });
    addUsage({ period: "2026-10", tokensIn: 1200, tokensOut: 0 });

    const guard = await checkWorkspaceBudget(WORKSPACE, 50, OCTOBER);

    expect(guard.allowed).toBe(true);
    expect(guard.state).toBe("over");
    expect(guard.hardStop).toBe(false);
  });

  it("lets a new month start clean", async () => {
    setBudget();
    addUsage({ period: "2026-10", tokensIn: 999, tokensOut: 0 });

    const october = await checkWorkspaceBudget(WORKSPACE, 10, OCTOBER);
    const november = await checkWorkspaceBudget(WORKSPACE, 10, NOVEMBER);

    expect(october.allowed).toBe(false);
    expect(november.allowed).toBe(true);
    expect(november.state).toBe("ok");
    expect(november.usedTokens).toBe(0);
  });

  it("allows everything when the workspace has no budget", async () => {
    const guard = await checkWorkspaceBudget(WORKSPACE, 999_999, OCTOBER);
    expect(guard.configured).toBe(false);
    expect(guard.allowed).toBe(true);
  });
});

describe("recordAiUsage — atomic accumulation", () => {
  it("adds token counts and requests to one (workspace, period, surface) row", async () => {
    await recordAiUsage({
      workspaceId: WORKSPACE,
      period: "2026-10",
      surface: "ask",
      inputTokens: 10,
      outputTokens: 4,
    });
    await recordAiUsage({
      workspaceId: WORKSPACE,
      period: "2026-10",
      surface: "ask",
      inputTokens: 20,
      outputTokens: 8,
    });

    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      workspaceId: WORKSPACE,
      period: "2026-10",
      surface: "ask",
      tokensIn: 30,
      tokensOut: 12,
      requests: 2,
      failures: 0,
    });
  });

  it("records a failed call with zero tokens but a request and failure count", async () => {
    await recordAiUsage({
      workspaceId: WORKSPACE,
      period: "2026-10",
      surface: "chat",
      inputTokens: 999,
      outputTokens: 999,
      ok: false,
    });

    expect(state.usage[0]).toMatchObject({
      tokensIn: 0,
      tokensOut: 0,
      requests: 1,
      failures: 1,
    });
  });

  it("ignores a call without a workspace (env-only config)", async () => {
    await recordAiUsage({ workspaceId: null, surface: "chat", inputTokens: 10 });
    expect(state.usage).toHaveLength(0);
    expect(prisma.aiUsage.upsert).not.toHaveBeenCalled();
  });

  it("normalizes an unknown surface to chat and rejects a garbage period", async () => {
    await recordAiUsage({
      workspaceId: WORKSPACE,
      period: "not-a-period",
      surface: "CHAT STREAM!",
      inputTokens: 1,
      outputTokens: 1,
      now: OCTOBER,
    });

    expect(state.usage[0]).toMatchObject({ surface: "chat", period: "2026-10" });
  });
});

describe("getWorkspaceUsageSummary", () => {
  it("reports the current month grouped by surface, excluding older periods", async () => {
    setBudget({ monthlyTokenLimit: 5000 });
    addUsage({ period: "2026-10", surface: "ask", tokensIn: 100, tokensOut: 50, requests: 2 });
    addUsage({ period: "2026-10", surface: "chat", tokensIn: 30, tokensOut: 20, requests: 1, failures: 0 });
    addUsage({ period: "2026-09", surface: "ask", tokensIn: 999, tokensOut: 999 });

    const summary = await getWorkspaceUsageSummary(WORKSPACE, OCTOBER);

    expect(summary.period).toBe("2026-10");
    expect(summary.tokensIn).toBe(130);
    expect(summary.tokensOut).toBe(70);
    expect(summary.usedTokens).toBe(200);
    expect(summary.requests).toBe(3);
    expect(summary.bySurface.map((row) => row.surface)).toEqual(["ask", "chat"]);
    expect(summary.budget).toMatchObject({
      configured: true,
      monthlyTokenLimit: 5000,
      warnPercent: 80,
      hardStop: true,
    });
  });

  it("returns an empty, unconfigured summary when storage fails", async () => {
    prisma.aiUsage.findMany.mockRejectedValueOnce(new Error("db down"));
    const summary = await getWorkspaceUsageSummary(WORKSPACE, OCTOBER);
    expect(summary.usedTokens).toBe(0);
    expect(summary.bySurface).toEqual([]);
    expect(summary.budget.configured).toBe(false);
  });
});

describe("resetWorkspaceUsage", () => {
  it("clears only the current period", async () => {
    addUsage({ period: "2026-10", tokensIn: 10, tokensOut: 10 });
    addUsage({ period: "2026-09", tokensIn: 20, tokensOut: 20 });

    const removed = await resetWorkspaceUsage(WORKSPACE, OCTOBER);

    expect(removed).toBe(1);
    expect(state.usage.map((row) => row.period)).toEqual(["2026-09"]);
    expect(prisma.aiUsage.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, period: "2026-10" },
    });
  });
});

describe("normalizeSurface", () => {
  it("accepts lowercase ids and collapses everything else", () => {
    expect(normalizeSurface("chat-stream")).toBe("chat-stream");
    expect(normalizeSurface("ASK")).toBe("ask");
    expect(normalizeSurface("skill ")).toBe("skill");
    expect(normalizeSurface("has spaces")).toBe("chat");
    expect(normalizeSurface("")).toBe("chat");
    expect(normalizeSurface(42)).toBe("chat");
  });
});

describe("normalizeBudgetInput", () => {
  it("accepts a zero limit and a valid threshold", () => {
    expect(
      normalizeBudgetInput({ monthlyTokenLimit: 0, warnPercent: 80, hardStop: false }),
    ).toEqual({ ok: true, value: { monthlyTokenLimit: 0, warnPercent: 80, hardStop: false } });
  });

  it("defaults the warning threshold to 80 and hardStop to true", () => {
    expect(normalizeBudgetInput({ monthlyTokenLimit: 1000 })).toEqual({
      ok: true,
      value: { monthlyTokenLimit: 1000, warnPercent: 80, hardStop: true },
    });
  });

  it("refuses negative, fractional and non-integer limits", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
      expect(normalizeBudgetInput({ monthlyTokenLimit: value }).ok, String(value)).toBe(false);
    }
    expect(normalizeBudgetInput({ monthlyTokenLimit: 1_000_000_001 }).ok).toBe(false);
  });

  it("refuses out-of-range warning thresholds", () => {
    for (const warnPercent of [0, 101, 50.5, Number.NaN]) {
      expect(
        normalizeBudgetInput({ monthlyTokenLimit: 10, warnPercent }).ok,
        String(warnPercent),
      ).toBe(false);
    }
  });
});
