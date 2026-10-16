/**
 * Plans — the pure plan/licensing engine behind the 14 rows of the
 * "Pricing & plan-gated features" matrix area
 * (`docs/FEATURE_MATRIX.md:671-689`) and `docs/specs/plans-licensing.md`.
 *
 * A workspace's plan (`free`, `personal`, `team`, `enterprise`) is a single
 * value that decides three different things:
 *
 *   1. **Limits** — the numeric ceilings on `guests`, `storage`,
 *      `versionRetentionDays`, `aiTokens` and `seats`. A ceiling is either a
 *      finite number or the literal `"unlimited"`.
 *   2. **Features** — the boolean capabilities a plan gates (`sso`, `scim`,
 *      `auditLog`, `customRoles` — the spec's Class-A allow-list).
 *   3. **Billing math** — seat additions (`canAddSeats`) and plan-change
 *      proration (`proratePlanChange`) are computed locally and
 *      deterministically. Per spec decision D2 / R26.16 this repo ships **no**
 *      payment provider: these helpers are pure arithmetic, never I/O.
 *
 * Everything here is pure and deterministic: a frozen catalogue, no DB, no
 * routes, no React, no clock, no `process.env`, no `any`, no mutation of
 * inputs. Plan values arrive from untrusted callers, so the helpers normalise
 * and **fail closed** — an unknown plan degrades to `free` (the cheapest
 * tier), an unknown feature/kind is never granted, and non-finite numbers deny.
 *
 * This is the plan/licensing half of the substrate; it owns no I/O and does no
 * network calls (R26.3).
 */

/** The four subscription tiers, cheapest first. */
export type PlanTier = "free" | "personal" | "team" | "enterprise";

/** A plan ceiling: a finite number, or the literal `"unlimited"`. */
export type PlanAmount = number | "unlimited";

/** The numeric ceilings a plan meters — the keys `withinLimit` accepts. */
export type PlanLimitKind = "guests" | "storage" | "versionRetentionDays" | "aiTokens" | "seats";

/** The boolean capabilities a plan gates — the spec's Class-A allow-list (R26.11). */
export type PlanFeature = "sso" | "scim" | "auditLog" | "customRoles";

/** One tier's full limit set. */
export interface PlanLimits {
  /** Maximum external guests; new invites only, never revokes. */
  readonly guests: PlanAmount;
  /** Total storage ceiling, in megabytes. */
  readonly storage: PlanAmount;
  /** Version-history retention window, in days; `"unlimited"` keeps everything. */
  readonly versionRetentionDays: PlanAmount;
  /** Monthly AI token budget, in tokens; `"unlimited"` never warns. */
  readonly aiTokens: PlanAmount;
  /** Member seat ceiling. */
  readonly seats: PlanAmount;
  /** Whether per-workspace SSO connections are unlocked (R26.7). */
  readonly sso: boolean;
  /** Whether the extended audit log is unlocked (R26.9). */
  readonly auditLog: boolean;
}

/** Every tier id, in ladder order — the order `describePlan` and upgrades walk. */
export const PLAN_TIER_IDS: readonly PlanTier[] = ["free", "personal", "team", "enterprise"];

/** Every metered numeric kind, in catalogue order. */
export const PLAN_LIMIT_KINDS: readonly PlanLimitKind[] = [
  "guests",
  "storage",
  "versionRetentionDays",
  "aiTokens",
  "seats",
];

/**
 * The gated feature allow-list, pinned to exactly four keys (R26.11). Growing
 * it requires a spec amendment, not a code change.
 */
export const PLAN_FEATURES: readonly PlanFeature[] = ["sso", "scim", "auditLog", "customRoles"];

/**
 * The frozen tier catalogue, cheapest to most capable. Numeric ceilings are
 * monotone and the boolean gates only ever turn on as the ladder ascends, so a
 * higher tier never gives up a lower tier's entitlement
 * (`src/lib/plans.test.ts` pins both properties).
 */
export const PLAN_TIERS: Readonly<Record<PlanTier, PlanLimits>> = {
  free: {
    guests: 5,
    storage: 100,
    versionRetentionDays: 7,
    aiTokens: 10_000,
    seats: 10,
    sso: false,
    auditLog: false,
  },
  personal: {
    guests: 25,
    storage: 1_000,
    versionRetentionDays: 30,
    aiTokens: 50_000,
    seats: 100,
    sso: false,
    auditLog: false,
  },
  team: {
    guests: 100,
    storage: 10_000,
    versionRetentionDays: 180,
    aiTokens: 250_000,
    seats: 500,
    sso: false,
    auditLog: true,
  },
  enterprise: {
    guests: "unlimited",
    storage: "unlimited",
    versionRetentionDays: "unlimited",
    aiTokens: "unlimited",
    seats: "unlimited",
    sso: true,
    auditLog: true,
  },
};

/** Human-facing tier labels, used by {@link describePlan}. */
const PLAN_LABELS: Readonly<Record<PlanTier, string>> = {
  free: "Free",
  personal: "Personal",
  team: "Team",
  enterprise: "Enterprise",
};

/**
 * Normalise a raw plan to a known id, or `null`. Case- and
 * whitespace-insensitive; anything that is not a string, or names no tier,
 * yields `null`.
 */
export function normalizePlan(plan: unknown): PlanTier | null {
  if (typeof plan !== "string") return null;
  const id = plan.trim().toLowerCase();
  return (PLAN_TIER_IDS as readonly string[]).includes(id) ? (id as PlanTier) : null;
}

/** Whether `plan` names a known tier (case- and whitespace-insensitive). */
export function isKnownPlan(plan: unknown): boolean {
  return normalizePlan(plan) !== null;
}

/**
 * The limits for `plan`, falling back to `free` when the plan is unknown or
 * malformed — the fail-closed default.
 */
export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_TIERS[normalizePlan(plan) ?? "free"];
}

/**
 * Whether `plan` grants the gated `feature`. `sso` and `auditLog` read the
 * tier's boolean gates; `scim` and `customRoles` are enterprise-only until
 * built (R26.8/R26.10). An unknown feature is never granted and an unknown
 * plan is checked against `free`.
 */
export function isFeatureAllowed(plan: string, feature: string): boolean {
  const tier = normalizePlan(plan);
  switch (feature) {
    case "sso":
      return getPlanLimits(plan).sso;
    case "auditLog":
      return getPlanLimits(plan).auditLog;
    case "scim":
    case "customRoles":
      return tier === "enterprise";
    default:
      return false;
  }
}

/** The raw ceiling for a metered `kind`, or `null` for an unknown kind. */
function amountFor(limits: PlanLimits, kind: string): PlanAmount | null {
  if (!(PLAN_LIMIT_KINDS as readonly string[]).includes(kind)) return null;
  const value = (limits as unknown as Record<string, unknown>)[kind];
  if (value === "unlimited") return "unlimited";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Clamp an untrusted usage count to a non-negative number, or `null` when not finite. */
function usageOf(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return value > 0 ? value : 0;
}

/** A request to consume `adding` more units of `kind`, on top of `used`. */
export interface LimitUsage {
  readonly kind: PlanLimitKind;
  readonly used: number;
  /** Units to add; defaults to one. Non-positive values are permitted (removals). */
  readonly adding?: number;
}

/**
 * Whether `plan` can absorb `adding` more units of `kind` on top of `used`.
 * A finite ceiling admits `used + adding <= limit`, so a cap of N admits the
 * N-th unit and denies the (N+1)-th. `"unlimited"` always admits. An unknown
 * kind, plan or non-finite number fails closed.
 */
export function withinLimit(plan: string, usage: LimitUsage): boolean {
  const amount = amountFor(getPlanLimits(plan), usage.kind);
  if (amount === null) return false;
  if (amount === "unlimited") return true;

  const used = usageOf(usage.used);
  if (used === null) return false;

  const adding = usage.adding === undefined ? 1 : usage.adding;
  if (!Number.isFinite(adding)) return false;

  return used + adding <= amount;
}

/**
 * Whether `plan` can take `delta` more seats from `current`. A non-positive
 * `delta` (a removal) is always allowed; a finite seat ceiling admits
 * `current + delta <= seats`; `"unlimited"` always admits. Non-finite inputs
 * and unknown plans fail closed (the latter against `free`).
 */
export function canAddSeats(plan: string, current: number, delta = 1): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(delta)) return false;
  if (delta <= 0) return true;

  const seats = getPlanLimits(plan).seats;
  if (seats === "unlimited") return true;

  const used = current > 0 ? current : 0;
  return used + delta <= seats;
}

/** A point in time accepted by the proration helpers. */
export type TimeInput = number | string | Date;

/** The inputs to {@link proratePlanChange}. */
export interface ProrationInput {
  /** The plan being left. Unknown ids normalise to `free`. */
  readonly from: string;
  /** The plan being adopted. Unknown ids normalise to `free`. */
  readonly to: string;
  /** Start of the current billing period. */
  readonly periodStart: TimeInput;
  /** End of the current billing period. */
  readonly periodEnd: TimeInput;
  /** The instant the change takes effect. */
  readonly at: TimeInput;
  /** Monthly price per plan id, in minor-unit-agnostic currency. Missing/negative ⇒ 0. */
  readonly priceMonthly: Readonly<Record<string, number>>;
}

/** The direction of a plan change, derived from the monthly prices. */
export type PlanChangeDirection = "upgrade" | "downgrade" | "flat";

/** The deterministic result of {@link proratePlanChange}. */
export interface ProrationResult {
  readonly from: PlanTier;
  readonly to: PlanTier;
  readonly direction: PlanChangeDirection;
  /** Share of the period left after `at`, in `[0, 1]`, rounded to 4 decimals. */
  readonly fractionRemaining: number;
  /** Unused value of the old plan over the remaining period, in currency. */
  readonly credit: number;
  /** Prorated cost of the new plan over the remaining period. */
  readonly charge: number;
  /** `charge - credit`: positive bills the customer, negative credits them. */
  readonly amountDue: number;
}

/** Parse a {@link TimeInput} to epoch millis, or `null` when unparseable. */
function toMillis(value: TimeInput): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Read a finite, non-negative price, defaulting to `0`. */
function priceFor(prices: Readonly<Record<string, number>>, plan: PlanTier): number {
  const value = typeof prices === "object" && prices !== null ? prices[plan] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Round to whole cents, symmetric around zero. */
function round2(value: number): number {
  const scaled = value * 100;
  return (Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON)) / 100;
}

/** Round a fraction to 4 decimals so results stay stable across runs. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Prorate a plan change at `at` within `[periodStart, periodEnd)`:
 *
 *   - `fractionRemaining` is the unused share of the period (`1` at the start,
 *     `0` once the period has elapsed, clamped either way).
 *   - `credit` is the old plan's unused value, `charge` the new plan's cost over
 *     the same window, and `amountDue = charge - credit`.
 *
 * Deterministic and side-effect free — amounts are rounded to whole cents.
 * Returns `null` when any timestamp is unparseable (never throws).
 */
export function proratePlanChange(input: ProrationInput): ProrationResult | null {
  const from = normalizePlan(input.from) ?? "free";
  const to = normalizePlan(input.to) ?? "free";

  const start = toMillis(input.periodStart);
  const end = toMillis(input.periodEnd);
  const at = toMillis(input.at);
  if (start === null || end === null || at === null) return null;

  const total = end - start;
  let fraction: number;
  if (total <= 0) fraction = 0;
  else if (at <= start) fraction = 1;
  else if (at >= end) fraction = 0;
  else fraction = (end - at) / total;

  const fromPrice = priceFor(input.priceMonthly, from);
  const toPrice = priceFor(input.priceMonthly, to);

  const credit = round2(fromPrice * fraction);
  const charge = round2(toPrice * fraction);
  const amountDue = round2(charge - credit);

  const direction: PlanChangeDirection =
    from === to || fromPrice === toPrice ? "flat" : toPrice > fromPrice ? "upgrade" : "downgrade";

  return {
    from,
    to,
    direction,
    fractionRemaining: round4(fraction),
    credit,
    charge,
    amountDue,
  };
}

/** One metered usage event, e.g. one AI call or one upload. */
export interface UsageEvent {
  /** The metered stream, e.g. `"aiTokens"` or `"storage"`. */
  readonly kind: string;
  /** Units consumed; non-positive/non-finite events are ignored. */
  readonly quantity: number;
  /** Optional timestamp, carried verbatim (the rollup does not window on it). */
  readonly at?: TimeInput;
}

/** The deterministic rollup produced by {@link meterUsage}. */
export interface UsageRollup {
  /** Sum of every accepted quantity. */
  readonly total: number;
  /** Number of accepted events. */
  readonly count: number;
  /** Per-kind totals, keyed by kind in sorted order. */
  readonly byKind: Readonly<Record<string, number>>;
  /** Per-kind event counts, keyed by kind in sorted order. */
  readonly countByKind: Readonly<Record<string, number>>;
}

/** Build a plain object from a map with its keys sorted, for stable output. */
function sortedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) {
    out[key] = map.get(key) ?? 0;
  }
  return out;
}

/**
 * Roll a stream of usage events up into totals and per-kind breakdowns. Blank
 * or non-string kinds and non-positive/non-finite quantities are skipped so an
 * untrusted stream cannot poison the totals. Keys are sorted, so two runs over
 * the same input are deep-equal. Tolerates a non-array input by returning zeros.
 */
export function meterUsage(events: readonly UsageEvent[]): UsageRollup {
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  let total = 0;
  let count = 0;

  if (Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event.kind !== "string" || event.kind.trim() === "") continue;
      const quantity = event.quantity;
      if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) continue;

      totals.set(event.kind, (totals.get(event.kind) ?? 0) + quantity);
      counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
      total += quantity;
      count += 1;
    }
  }

  return {
    total,
    count,
    byKind: sortedRecord(totals),
    countByKind: sortedRecord(counts),
  };
}

/** A human-facing summary of one plan. */
export interface PlanDescription {
  /** The normalised tier, or `null` when the input named no tier. */
  readonly id: PlanTier | null;
  /** Display label; `"Unknown"` when the input was unrecognised. */
  readonly label: string;
  /** Whether the input named a real tier. */
  readonly known: boolean;
  /** The tier's limits (free's, fail-closed, when unknown). */
  readonly limits: PlanLimits;
  /** The gated features the tier unlocks, in catalogue order. */
  readonly features: readonly PlanFeature[];
}

/**
 * Describe `plan` for a UI: its id, label, limits and the gated features it
 * unlocks. An unknown plan falls back to free's limits, reports `known: false`
 * and unlocks nothing.
 */
export function describePlan(plan: string): PlanDescription {
  const id = normalizePlan(plan);
  return {
    id,
    label: id === null ? "Unknown" : PLAN_LABELS[id],
    known: id !== null,
    limits: PLAN_TIERS[id ?? "free"],
    features: id === null ? [] : PLAN_FEATURES.filter((feature) => isFeatureAllowed(id, feature)),
  };
}

/**
 * The self-hosted licence kinds (spec §5.1, D3). `community` is the MIT default
 * (no licence file); `trial` and `subscription` are time-limited; `perpetual`
 * has no `expiresAt`. Purely descriptive — verification lives in the edition
 * module and never phones home (R26.3).
 */
export type LicenseKind = "community" | "trial" | "subscription" | "perpetual";

/** Every recognised licence kind, community default first. */
export const SELF_HOSTED_LICENSE_KINDS: readonly LicenseKind[] = [
  "community",
  "trial",
  "subscription",
  "perpetual",
];

/** Whether `value` names a recognised self-hosted licence kind. */
export function isSelfHostedLicenseKind(value: unknown): value is LicenseKind {
  return typeof value === "string" && (SELF_HOSTED_LICENSE_KINDS as readonly string[]).includes(value);
}
