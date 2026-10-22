/**
 * AI cost & token budget engine — the pure, deterministic layer behind §14
 * "AI cost controls" / "AI data boundaries" and §18 "AI usage limits by plan".
 *
 * Model calls are metered in tokens, budgets are denominated in tokens, and
 * spend is USD. Everything here is provider-free: a static `PRICE_TABLE` prices
 * a call, a `chars / 4` heuristic estimates tokens when a provider reports
 * none, an immutable `BudgetRecord` accumulates usage without a clock, and
 * `assertDataBoundary` encodes the written data-boundary policy (no training on
 * workspace content unless an operator explicitly opts in).
 *
 * Design rules (same contract as the other `src/lib` helpers):
 *
 * - **Pure and immutable.** `recordUsage` / `resetBudget` return a new
 *   `BudgetRecord` and never mutate their argument; equal inputs always yield
 *   byte-identical output.
 * - **Fail-safe, never throw** (except the deliberate `assertDataBoundary`
 *   guard). Missing, negative or non-finite numbers become `0`; an unknown
 *   model falls back to `FALLBACK_PRICE` instead of inventing `NaN`.
 * - **Boundary-inclusive budgets.** A request whose projected usage lands
 *   *exactly* on `limitTokens` is still allowed — the limit is a ceiling, not a
 *   wall.
 */

/** USD price of a model, expressed per one million tokens. */
export type ModelPrice = {
  inputPerMTokens: number;
  outputPerMTokens: number;
};

/** Number of tokens a per-million price is quoted against. */
export const TOKENS_PER_MILLION = 1_000_000;

/**
 * Curated per-model prices in USD per million tokens. Prices are a snapshot,
 * not a live feed; an unknown or newer model falls back to `FALLBACK_PRICE`.
 * Output is never cheaper than input.
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o": { inputPerMTokens: 2.5, outputPerMTokens: 10 },
  "gpt-4o-mini": { inputPerMTokens: 0.15, outputPerMTokens: 0.6 },
  "gpt-4.1": { inputPerMTokens: 2, outputPerMTokens: 8 },
  "gpt-4.1-mini": { inputPerMTokens: 0.4, outputPerMTokens: 1.6 },
  "claude-3-5-sonnet": { inputPerMTokens: 3, outputPerMTokens: 15 },
  "claude-3-5-haiku": { inputPerMTokens: 0.8, outputPerMTokens: 4 },
  "o3-mini": { inputPerMTokens: 1.1, outputPerMTokens: 4.4 },
  "mistral-large": { inputPerMTokens: 2, outputPerMTokens: 6 },
};

/** Price used for any model the table does not name (kept deliberately low). */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTokens: 1, outputPerMTokens: 3 };

/** One metered model call: what it cost and, optionally, where it came from. */
export type UsageEvent = {
  /** The model id the call used. */
  model?: string;
  /** Prompt tokens (or an estimate when the provider reports none). */
  inputTokens?: number;
  /** Completion tokens. */
  outputTokens?: number;
  /** Surface that issued the call (e.g. `chat`, `autofill`); summary key only. */
  surface?: string;
  /** Calendar-month period (`YYYY-MM`, UTC) the call belongs to. */
  period?: string;
};

/**
 * The token budget of one workspace for one period. `usedInput` + `usedOutput`
 * are the meter; `spendUsd` is the running dollar cost for reporting.
 */
export type BudgetRecord = {
  workspaceId: string;
  /** Calendar-month period, `YYYY-MM` in UTC. */
  period: string;
  /** Ceiling on `usedInput + usedOutput` for the period. */
  limitTokens: number;
  usedInput: number;
  usedOutput: number;
  spendUsd: number;
};

/** Why a budget check did or did not allow a request. */
export type BudgetReason = "ok" | "over_limit";

/** Verdict of `checkBudget` for one prospective request. */
export type BudgetCheck = {
  allowed: boolean;
  reason: BudgetReason;
  /** Headroom in tokens *before* the prospective request, clamped at 0. */
  remainingTokens: number;
  /**
   * USD value of `remainingTokens` at the request model's input rate — a
   * conservative floor on the allowance still available for the period.
   */
  remainingUsd: number;
};

/** How `summarizeUsage` buckets a list of usage events. */
export type UsageGroupBy = "model" | "surface" | "period";

/** One aggregated bucket of usage. */
export type UsageSummaryEntry = {
  /** The group value, or `"unknown"` when an event omitted it. */
  key: string;
  /** Number of events in the bucket. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  spendUsd: number;
};

/** Coerce an arbitrary value to a non-negative, finite, whole number. */
function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Coerce an arbitrary value to a non-negative, finite number (not floored). */
function nonNegativeFloat(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** Split a string into code points so an astral character counts once. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Estimated token count of `text` using the documented `chars / 4` heuristic
 * (the same rule as `ai-context.ts`, reimplemented here so this module is
 * dependency-free). Counting is code-point aware, so an emoji or rare CJK
 * character costs one character rather than two, and the result is `0` for
 * empty or non-string input. Deterministic — no tokenizer, no clock.
 */
export function estimateTokens(text: string): number {
  const input = typeof text === "string" ? text : "";
  const length = codePoints(input).length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

/** Resolve a model id to a price, falling back for unknown/missing models. */
function priceFor(model: unknown): ModelPrice {
  const id = typeof model === "string" ? model.trim() : "";
  if (id !== "" && Object.prototype.hasOwnProperty.call(PRICE_TABLE, id)) {
    return PRICE_TABLE[id];
  }
  return FALLBACK_PRICE;
}

/**
 * USD cost of a single call: `inputTokens` priced at the model's input rate
 * plus `outputTokens` at its output rate. Missing counts are `0`; an unknown or
 * missing model uses `FALLBACK_PRICE`. Never returns `NaN`.
 */
export function costOfUsage(usage: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}): number {
  const price = priceFor(usage?.model);
  const input = nonNegative(usage?.inputTokens);
  const output = nonNegative(usage?.outputTokens);
  return (
    (input / TOKENS_PER_MILLION) * price.inputPerMTokens +
    (output / TOKENS_PER_MILLION) * price.outputPerMTokens
  );
}

/** Canonical, fail-safe view of an arbitrary budget-shaped value. */
function normalizeBudget(budget: BudgetRecord | undefined): BudgetRecord {
  return {
    workspaceId: typeof budget?.workspaceId === "string" ? budget.workspaceId : "",
    period: typeof budget?.period === "string" ? budget.period : "",
    limitTokens: nonNegative(budget?.limitTokens),
    usedInput: nonNegative(budget?.usedInput),
    usedOutput: nonNegative(budget?.usedOutput),
    spendUsd: nonNegativeFloat(budget?.spendUsd),
  };
}

/**
 * Record one usage event against a budget, returning a **new** record. Token
 * counts add to `usedInput` / `usedOutput`, the model-priced cost adds to
 * `spendUsd`, and the input budget is never mutated. When the event carries a
 * `period` different from the budget's, the period is rolled over first (usage
 * and spend reset, the limit is kept) so a new month starts clean without an
 * explicit `resetBudget`. Negative or non-finite counts are ignored.
 */
export function recordUsage(budget: BudgetRecord, event: UsageEvent): BudgetRecord {
  const current = normalizeBudget(budget);
  const rolled =
    typeof event?.period === "string" && event.period !== "" && event.period !== current.period
      ? { ...current, period: event.period, usedInput: 0, usedOutput: 0, spendUsd: 0 }
      : current;

  const input = nonNegative(event?.inputTokens);
  const output = nonNegative(event?.outputTokens);

  return {
    ...rolled,
    usedInput: rolled.usedInput + input,
    usedOutput: rolled.usedOutput + output,
    spendUsd:
      rolled.spendUsd + costOfUsage({ model: event?.model, inputTokens: input, outputTokens: output }),
  };
}

/**
 * Decide whether a prospective request fits the budget. The projected
 * `estimatedTokens` is added to the tokens already used and compared against
 * `limitTokens` **inclusively** — a request that lands exactly on the limit is
 * allowed. `remainingTokens` (and the derived `remainingUsd`, priced at the
 * request model's input rate) report the headroom *before* this request and
 * never go negative.
 */
export function checkBudget(
  budget: BudgetRecord,
  request: { estimatedTokens?: number; model?: string; period?: string },
): BudgetCheck {
  const current = normalizeBudget(budget);
  // A record from another period has no usage in this one. The in-process
  // loader rolls the record before it calls this, but the explicit period also
  // makes the exported check correct on its own.
  const used =
    typeof request?.period === "string" &&
    request.period !== "" &&
    request.period !== current.period
      ? 0
      : current.usedInput + current.usedOutput;
  const limit = current.limitTokens;
  const estimated = nonNegative(request?.estimatedTokens);
  const allowed = used + estimated <= limit;
  const remainingTokens = Math.max(0, limit - used);
  const price = priceFor(request?.model);

  return {
    allowed,
    reason: allowed ? "ok" : "over_limit",
    remainingTokens,
    remainingUsd: (remainingTokens / TOKENS_PER_MILLION) * price.inputPerMTokens,
  };
}

/**
 * Start a fresh period: a new budget with the same `workspaceId` and
 * `limitTokens`, zeroed usage and spend, and `period` set to the new month. The
 * input budget is not mutated. A blank period keeps the current one.
 */
export function resetBudget(budget: BudgetRecord, options: { period: string }): BudgetRecord {
  const current = normalizeBudget(budget);
  const period =
    typeof options?.period === "string" && options.period !== "" ? options.period : current.period;

  return {
    workspaceId: current.workspaceId,
    period,
    limitTokens: current.limitTokens,
    usedInput: 0,
    usedOutput: 0,
    spendUsd: 0,
  };
}

/** The summary key of an event for the chosen grouping. */
function groupKey(event: UsageEvent, groupBy: UsageGroupBy): string {
  const raw =
    groupBy === "surface" ? event?.surface : groupBy === "period" ? event?.period : event?.model;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" ? "unknown" : value;
}

/**
 * Aggregate usage events into per-group totals, sorted by key. `groupBy`
 * selects the model, surface or period; an event that omits the chosen field
 * lands in the `"unknown"` bucket. `spendUsd` is `costOfUsage` summed over the
 * bucket, so it uses the same price table as billing. Returns `[]` for no
 * events.
 */
export function summarizeUsage(
  events: readonly UsageEvent[],
  options: { groupBy: UsageGroupBy },
): UsageSummaryEntry[] {
  const list = Array.isArray(events) ? events : [];
  const groupBy: UsageGroupBy =
    options?.groupBy === "surface" || options?.groupBy === "period" ? options.groupBy : "model";

  const buckets = new Map<
    string,
    { calls: number; inputTokens: number; outputTokens: number; spendUsd: number }
  >();

  for (const event of list) {
    const key = groupKey(event, groupBy);
    const bucket = buckets.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, spendUsd: 0 };
    const input = nonNegative(event?.inputTokens);
    const output = nonNegative(event?.outputTokens);
    bucket.calls += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    bucket.spendUsd += costOfUsage({ model: event?.model, inputTokens: input, outputTokens: output });
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, bucket]) => ({
      key,
      calls: bucket.calls,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      totalTokens: bucket.inputTokens + bucket.outputTokens,
      spendUsd: bucket.spendUsd,
    }));
}

/**
 * The written data-boundary policy this module enforces. The chat transport
 * sends only what the routes build, from a bring-your-own-key configuration:
 * workspace content is never used for provider training, keys are encrypted at
 * rest and never returned to clients, and prompts/completions are never logged.
 */
export const DATA_BOUNDARY_POLICY = {
  id: "ai-data-boundary-v1",
  summary:
    "Workspace content is never used for provider training; keys are AES-256-GCM at rest; prompts and completions are never logged.",
  /** Training on submitted content is off unless an operator opts in. */
  defaultTraining: "deny",
  /** A training-enabled provider needs an explicit `allowTraining` opt-in. */
  requiresExplicitOptIn: true,
  keysAtRest: "AES-256-GCM",
  promptsLogged: false,
  completionsLogged: false,
  /** Transcription audio is processed and discarded. */
  audioRetention: "none",
} as const;

/** A provider's data-boundary posture, as declared by its configuration. */
export type ProviderBoundary = {
  /** Provider id or label (e.g. `openai`, `ollama`). */
  name: string;
  /** Whether the provider may train on submitted workspace content. */
  trainsOnData: boolean;
};

/** Refusal raised when a training-enabled provider is used without opt-in. */
export class DataBoundaryError extends Error {
  readonly code = "DATA_BOUNDARY_TRAINING";
  /** The provider that was refused. */
  readonly provider: string;

  constructor(provider: string) {
    super(
      `Provider "${provider}" trains on submitted content; refuse unless allowTraining is set.`,
    );
    this.name = "DataBoundaryError";
    this.provider = provider;
  }
}

/**
 * Enforce `DATA_BOUNDARY_POLICY`: a provider that trains on submitted content
 * is refused with a `DataBoundaryError` unless the caller explicitly passes
 * `allowTraining: true` (the operator opt-in). A non-training provider — or an
 * opted-in one — is returned unchanged. Never mutates its input.
 */
export function assertDataBoundary(request: {
  provider: ProviderBoundary;
  allowTraining?: boolean;
}): ProviderBoundary {
  const provider = request?.provider;
  if (!provider || typeof provider !== "object") {
    throw new DataBoundaryError("unknown");
  }
  const name = typeof provider.name === "string" ? provider.name : "unknown";
  if (provider.trainsOnData === true && request.allowTraining !== true) {
    throw new DataBoundaryError(name);
  }
  return provider;
}

/** Group a non-negative integer with thousands separators (deterministic). */
function groupDigits(value: number): string {
  return Math.max(0, Math.trunc(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * One-line, human-readable budget for a settings banner, e.g.
 * `AI budget 2026-10: 87,000 / 100,000 tokens used (87%), $4.20 spent, 13,000
 * remaining`. Percent is rounded to a whole number (a zero limit reads `0%`)
 * and `remaining` is clamped at zero. Never throws.
 */
export function describeBudget(budget: BudgetRecord): string {
  const current = normalizeBudget(budget);
  const used = current.usedInput + current.usedOutput;
  const remaining = Math.max(0, current.limitTokens - used);
  const percent =
    current.limitTokens > 0 ? Math.round((used / current.limitTokens) * 100) : 0;
  const period = current.period === "" ? "unknown" : current.period;

  return `AI budget ${period}: ${groupDigits(used)} / ${groupDigits(
    current.limitTokens,
  )} tokens used (${percent}%), $${current.spendUsd.toFixed(2)} spent, ${groupDigits(
    remaining,
  )} remaining`;
}
