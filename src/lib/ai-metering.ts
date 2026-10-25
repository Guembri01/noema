/**
 * Durable AI metering (R25.12–R25.14).
 *
 * The transport (`./ai-provider`) is the one place that calls a provider. This
 * module is the storage half of its cost control:
 *
 * - `loadWorkspaceBudget` reads the workspace's ceiling and the usage already
 *   accumulated in the current UTC month;
 * - `checkWorkspaceBudget` turns that into the same `BudgetEvaluation` the
 *   settings dashboard renders, so the guard and the UI can never disagree;
 * - `recordAiUsage` accumulates one call into its `(workspace, period, surface)`
 *   counter with an atomic `increment`, so concurrent instances cannot lose a
 *   write;
 * - `getWorkspaceUsageSummary` is the read model behind the settings panel and
 *   `resetWorkspaceUsage` clears the current window for an admin.
 *
 * Metering never fails a model call: a storage error is swallowed (the call
 * already produced a result) and the guard falls back to "not configured",
 * which is the same behaviour as a workspace that never set a budget.
 */

import { prisma } from "./db";
import { evaluateBudget, type BudgetEvaluation } from "./ai-cost";

/** Coerce a counter to a non-negative whole number. */
function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** The five shipped surfaces plus the transport-only ones. */
export type AiSurface =
  | "chat"
  | "chat-stream"
  | "ask"
  | "summarize"
  | "skill"
  | "autofill"
  | "transcribe"
  | "test";

/** A surface id is a short lowercase token; unknown values collapse to `chat`. */
export function normalizeSurface(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(raw)) return "chat";
  return raw;
}

/** The UTC calendar-month key (`YYYY-MM`) a budget and its usage belong to. */
export function budgetPeriod(now: Date = new Date()): string {
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Default soft-warning threshold when a workspace does not set one. */
export const DEFAULT_WARN_PERCENT = 80;

/** Upper bound on a stored ceiling (a billion tokens/month is already absurd). */
export const MAX_MONTHLY_TOKEN_LIMIT = 1_000_000_000;

/** The persisted budget configuration of one workspace. */
export type WorkspaceBudget = {
  workspaceId: string;
  period: string;
  limitTokens: number;
  warnPercent: number;
  hardStop: boolean;
  usedInput: number;
  usedOutput: number;
  requests: number;
};

/**
 * The transport/dashboard guard verdict. `configured` is false when the
 * workspace has no budget row (the environment fallback may still apply).
 */
export type AiBudgetGuard = BudgetEvaluation & {
  configured: boolean;
  period: string;
  /** Set only when the verdict refuses the dispatch. */
  code?: "AI_BUDGET_EXCEEDED";
};

/** A guard that allows everything — no ceiling, or no readable storage. */
function unconfiguredGuard(period: string): AiBudgetGuard {
  return {
    ...evaluateBudget({ limitTokens: 0 }),
    configured: false,
    period,
  };
}

function whole(value: unknown): number {
  return Math.floor(nonNegative(value));
}

/**
 * Load the workspace's budget row and the usage summed over `period`.
 *
 * Returns `null` when the workspace has no budget row (or storage is not
 * reachable), which the provider treats as "no durable ceiling". A row with
 * `monthlyTokenLimit = 0` is returned as configured-but-unlimited so an
 * operator can disable a ceiling without the environment default taking over.
 */
export async function loadWorkspaceBudget(
  workspaceId: string | null | undefined,
  now: Date = new Date(),
): Promise<WorkspaceBudget | null> {
  const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!id) return null;
  const period = budgetPeriod(now);

  try {
    const [budget, usage] = await Promise.all([
      prisma.aiBudget.findUnique({
        where: { workspaceId: id },
        select: { monthlyTokenLimit: true, warnPercent: true, hardStop: true },
      }),
      prisma.aiUsage.aggregate({
        where: { workspaceId: id, period },
        _sum: { tokensIn: true, tokensOut: true, requests: true },
      }),
    ]);
    if (!budget) return null;
    return {
      workspaceId: id,
      period,
      limitTokens: whole(budget.monthlyTokenLimit),
      warnPercent:
        typeof budget.warnPercent === "number" && Number.isFinite(budget.warnPercent)
          ? Math.min(100, Math.max(1, Math.floor(budget.warnPercent)))
          : DEFAULT_WARN_PERCENT,
      hardStop: budget.hardStop !== false,
      usedInput: whole(usage._sum.tokensIn),
      usedOutput: whole(usage._sum.tokensOut),
      requests: whole(usage._sum.requests),
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate a prospective call against the workspace's durable budget. The
 * `estimatedTokens` is the prompt plus the requested completion window (the
 * same estimate the transport uses); a zero estimate still refuses a workspace
 * that is already over its ceiling.
 */
export async function checkWorkspaceBudget(
  workspaceId: string | null | undefined,
  estimatedTokens: number,
  now: Date = new Date(),
): Promise<AiBudgetGuard> {
  const period = budgetPeriod(now);
  const budget = await loadWorkspaceBudget(workspaceId, now);
  if (!budget) return unconfiguredGuard(period);

  const verdict = evaluateBudget({
    usedTokens: budget.usedInput + budget.usedOutput,
    limitTokens: budget.limitTokens,
    warnPercent: budget.warnPercent,
    estimateTokens: estimatedTokens,
    hardStop: budget.hardStop,
  });

  return {
    ...verdict,
    configured: true,
    period,
    ...(verdict.allowed ? {} : { code: "AI_BUDGET_EXCEEDED" as const }),
  };
}

/** One call to meter. Missing workspace ids are a no-op (env-only config). */
export type AiUsageEvent = {
  workspaceId?: string | null;
  surface?: string;
  period?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** `false` records the call in `requests` and `failures` with zero tokens. */
  ok?: boolean;
  now?: Date;
};

/**
 * Accumulate one call into its counter row. The upsert's `increment`s are what
 * make the counter safe under concurrency; a failure to write is swallowed
 * because metering must never turn a delivered answer into an error.
 */
export async function recordAiUsage(event: AiUsageEvent): Promise<void> {
  const workspaceId = typeof event?.workspaceId === "string" ? event.workspaceId.trim() : "";
  if (!workspaceId) return;

  const period =
    typeof event.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(event.period)
      ? event.period
      : budgetPeriod(event.now instanceof Date ? event.now : new Date());
  const surface = normalizeSurface(event.surface);
  const ok = event.ok !== false;
  // A failed call contributes no tokens, whatever the caller measured: the
  // invariant belongs to the store, not to every call site.
  const tokensIn = ok ? whole(event.inputTokens) : 0;
  const tokensOut = ok ? whole(event.outputTokens) : 0;

  try {
    await prisma.aiUsage.upsert({
      where: { workspaceId_period_surface: { workspaceId, period, surface } },
      create: {
        workspaceId,
        period,
        surface,
        tokensIn,
        tokensOut,
        requests: 1,
        failures: ok ? 0 : 1,
      },
      update: {
        tokensIn: { increment: tokensIn },
        tokensOut: { increment: tokensOut },
        requests: { increment: 1 },
        failures: ok ? undefined : { increment: 1 },
      },
    });
  } catch {
    // Storage is best-effort; the call itself already happened.
  }
}

/** Usage totals for one surface in one period. */
export type AiUsageSurface = {
  surface: string;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  failures: number;
};

/** The read model of the AI settings dashboard. */
export type AiUsageSummary = {
  period: string;
  tokensIn: number;
  tokensOut: number;
  usedTokens: number;
  requests: number;
  failures: number;
  bySurface: AiUsageSurface[];
  budget: {
    configured: boolean;
    monthlyTokenLimit: number;
    warnPercent: number;
    hardStop: boolean;
  };
};

/**
 * Read the current month's usage, grouped by surface, plus the budget row (if
 * any). Reads are scoped to the one workspace id the caller passes; the action
 * above this function performs the authorization check.
 */
export async function getWorkspaceUsageSummary(
  workspaceId: string,
  now: Date = new Date(),
): Promise<AiUsageSummary> {
  const period = budgetPeriod(now);

  try {
    const [rows, budget] = await Promise.all([
      prisma.aiUsage.findMany({
        where: { workspaceId, period },
        orderBy: { surface: "asc" },
        select: {
          surface: true,
          tokensIn: true,
          tokensOut: true,
          requests: true,
          failures: true,
        },
      }),
      prisma.aiBudget.findUnique({
        where: { workspaceId },
        select: { monthlyTokenLimit: true, warnPercent: true, hardStop: true },
      }),
    ]);

    const bySurface = rows.map((row) => ({
      surface: row.surface,
      tokensIn: whole(row.tokensIn),
      tokensOut: whole(row.tokensOut),
      requests: whole(row.requests),
      failures: whole(row.failures),
    }));

    return {
      period,
      tokensIn: bySurface.reduce((sum, row) => sum + row.tokensIn, 0),
      tokensOut: bySurface.reduce((sum, row) => sum + row.tokensOut, 0),
      usedTokens: bySurface.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0),
      requests: bySurface.reduce((sum, row) => sum + row.requests, 0),
      failures: bySurface.reduce((sum, row) => sum + row.failures, 0),
      bySurface,
      budget: {
        configured: Boolean(budget),
        monthlyTokenLimit: whole(budget?.monthlyTokenLimit),
        warnPercent:
          typeof budget?.warnPercent === "number" &&
          Number.isFinite(budget.warnPercent)
            ? Math.min(100, Math.max(1, Math.floor(budget.warnPercent)))
            : DEFAULT_WARN_PERCENT,
        hardStop: budget?.hardStop !== false,
      },
    };
  } catch {
    return {
      period,
      tokensIn: 0,
      tokensOut: 0,
      usedTokens: 0,
      requests: 0,
      failures: 0,
      bySurface: [],
      budget: {
        configured: false,
        monthlyTokenLimit: 0,
        warnPercent: DEFAULT_WARN_PERCENT,
        hardStop: true,
      },
    };
  }
}

/**
 * Delete the current period's counters for a workspace. Returns the number of
 * rows removed. Used by the admin "reset this period" control; the calendar
 * month itself rolls over automatically because usage rows are period-keyed.
 */
export async function resetWorkspaceUsage(
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const period = budgetPeriod(now);
  try {
    const result = await prisma.aiUsage.deleteMany({ where: { workspaceId, period } });
    return whole(result.count);
  } catch {
    return 0;
  }
}

/** Validated input of `saveAiBudgetAction`. */
export type AiBudgetInput = {
  monthlyTokenLimit: number;
  warnPercent: number;
  hardStop: boolean;
};

export type AiBudgetInputResult =
  | { ok: true; value: AiBudgetInput }
  | { ok: false; error: string };

/**
 * Validate budget fields at the action boundary. A limit of `0` is accepted
 * (ceiling off); negative, fractional and non-finite values are refused rather
 * than rounded into something the admin did not ask for.
 */
export function normalizeBudgetInput(input: {
  monthlyTokenLimit?: unknown;
  warnPercent?: unknown;
  hardStop?: unknown;
}): AiBudgetInputResult {
  const rawLimit = input?.monthlyTokenLimit;
  if (
    typeof rawLimit !== "number" ||
    !Number.isFinite(rawLimit) ||
    rawLimit < 0 ||
    !Number.isInteger(rawLimit)
  ) {
    return { ok: false, error: "The monthly token limit must be a whole number of 0 or more." };
  }
  if (rawLimit > MAX_MONTHLY_TOKEN_LIMIT) {
    return {
      ok: false,
      error: `The monthly token limit cannot exceed ${MAX_MONTHLY_TOKEN_LIMIT.toLocaleString("en-US")}.`,
    };
  }

  const rawWarn = input?.warnPercent;
  const warnPercent =
    rawWarn === undefined || rawWarn === null
      ? DEFAULT_WARN_PERCENT
      : typeof rawWarn === "number" &&
          Number.isFinite(rawWarn) &&
          Number.isInteger(rawWarn) &&
          rawWarn >= 1 &&
          rawWarn <= 100
        ? rawWarn
        : null;
  if (warnPercent === null) {
    return { ok: false, error: "The warning threshold must be a whole number from 1 to 100." };
  }

  return {
    ok: true,
    value: {
      monthlyTokenLimit: rawLimit,
      warnPercent,
      hardStop: input?.hardStop !== false,
    },
  };
}
