/**
 * Workspace plan wiring — the thin, testable layer that makes the pure
 * `@/lib/plans` engine load-bearing. Before this module nothing imported
 * `plans.ts`; here we (a) resolve the plan a workspace runs under, (b) turn it
 * into the view model the billing settings page renders, and (c) expose the one
 * real gate the engine enforces (the external-guest cap that
 * `sendWorkspaceInviteAction` consults before it writes an invite).
 *
 * Where the plan lives: this repo stores **no** plan per workspace — `model
 * Workspace` (`prisma/schema.prisma:122-152`) has no `plan`/`tier` column and
 * the single migration never added one. Following the licensing spec's Class-B
 * convention (`docs/specs/plans-licensing.md` §2.3/D5: workspace-level capacity
 * is operator config, e.g. `MAX_GUESTS`), the interim source is the
 * `WORKSPACE_PLAN` environment field. That is an explicit stopgap, not the end
 * state: a per-workspace `Workspace.plan` column (or a workspace-settings JSON
 * bag) is the follow-up. Everything below still takes the raw plan value as an
 * argument, so swapping the source later touches one call site each.
 *
 * The module stays pure and deterministic apart from {@link readWorkspacePlan},
 * which reads one environment field and fails closed to `free`.
 */

import {
  PLAN_LIMIT_KINDS,
  PLAN_TIER_IDS,
  canAddSeats,
  describePlan,
  getPlanLimits,
  normalizePlan,
  proratePlanChange,
  withinLimit,
} from "@/lib/plans";
import type {
  PlanAmount,
  PlanChangeDirection,
  PlanFeature,
  PlanLimitKind,
  PlanTier,
  TimeInput,
} from "@/lib/plans";

/** Environment field naming this deployment's plan (see the module note). */
export const WORKSPACE_PLAN_ENV = "WORKSPACE_PLAN";

/**
 * Illustrative monthly list prices, in whole currency units, used only to
 * preview proration. The repo ships **no** payment provider (spec D2 / R26.16),
 * so these numbers are display-only; enterprise is priced like the top tier so
 * an upgrade reads as an upgrade rather than a flat change.
 */
export const PLAN_MONTHLY_PRICES: Readonly<Record<PlanTier, number>> = {
  free: 0,
  personal: 12,
  team: 30,
  enterprise: 99,
};

/** Human labels for the metered kinds, in {@link PLAN_LIMIT_KINDS} order. */
const LIMIT_LABELS: Readonly<Record<PlanLimitKind, string>> = {
  guests: "External guests",
  storage: "Storage (MB)",
  versionRetentionDays: "Version retention (days)",
  aiTokens: "AI tokens per month",
  seats: "Member seats",
};

/**
 * Normalise a raw plan value to a known tier, failing closed to `free` — the
 * same default `getPlanLimits` uses, so an unknown or malformed value can never
 * unlock more than the cheapest tier.
 */
export function resolveWorkspacePlan(rawPlan: unknown): PlanTier {
  return normalizePlan(rawPlan) ?? "free";
}

/**
 * Read the deployment's plan from the `WORKSPACE_PLAN` environment field.
 * Unset, blank or unknown values resolve to `free` (fail closed).
 */
export function readWorkspacePlan(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlanTier {
  return resolveWorkspacePlan(env[WORKSPACE_PLAN_ENV]);
}

/** The label the billing UI shows for a metered kind. */
export function planLimitLabel(kind: PlanLimitKind): string {
  return LIMIT_LABELS[kind];
}

/** Group thousands with commas; locale-independent so tests stay stable. */
function groupThousands(value: number): string {
  const whole = Math.trunc(value);
  const sign = whole < 0 ? "-" : "";
  return sign + Math.abs(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Render a plan ceiling for the UI: `"Unlimited"` or a grouped number. */
export function formatPlanAmount(amount: PlanAmount): string {
  return amount === "unlimited" ? "Unlimited" : groupThousands(amount);
}

/** Clamp an untrusted usage count to a non-negative integer. */
function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 0 ? Math.trunc(value) : 0;
}

/**
 * The decision {@link sendWorkspaceInviteAction} makes before granting a new
 * external guest. `allowed` is the load-bearing answer; `reason` is the
 * message a denied caller receives. Denies when the plan's guest ceiling is
 * reached or when the usage count is not a finite number.
 */
export interface GuestInviteGate {
  readonly allowed: boolean;
  readonly plan: PlanTier;
  readonly used: number;
  readonly limit: PlanAmount;
  /** `null` when allowed; a user-facing explanation when denied. */
  readonly reason: string | null;
}

/**
 * Evaluate whether `plan` can absorb one more external guest given
 * `currentGuests` already in use. Delegates to the pure `withinLimit` engine so
 * the cap admits the N-th guest and denies the (N+1)-th; `"unlimited"` always
 * admits and non-finite input fails closed.
 */
export function evaluateGuestInviteGate(plan: string, currentGuests: number): GuestInviteGate {
  const resolved = resolveWorkspacePlan(plan);
  const limit = getPlanLimits(resolved).guests;
  const used = clampCount(currentGuests);
  const allowed = Number.isFinite(currentGuests) && withinLimit(resolved, { kind: "guests", used });
  return {
    allowed,
    plan: resolved,
    used,
    limit,
    reason: allowed
      ? null
      : `The ${describePlan(resolved).label} plan allows ${formatPlanAmount(limit)} external ` +
        `guests and ${used} are already in use. Remove a guest or upgrade the plan to invite more.`,
  };
}

/** One row in the billing page's limit table. */
export interface BillingLimitRow {
  readonly kind: PlanLimitKind;
  readonly label: string;
  readonly amount: PlanAmount;
}

/** One plan-change preview, rendered from a `proratePlanChange` result. */
export interface PlanProrationPreview {
  readonly to: PlanTier;
  readonly label: string;
  readonly direction: PlanChangeDirection;
  readonly fractionRemaining: number;
  readonly credit: number;
  readonly charge: number;
  readonly amountDue: number;
}

/** The metered usage the billing page shows for one counter. */
export interface BillingUsage {
  readonly used: number;
  readonly limit: PlanAmount;
  /** Whether the plan admits one more unit right now. */
  readonly canAdd: boolean;
}

/** Everything the plan/billing settings page renders, precomputed. */
export interface BillingViewModel {
  /** The normalised current plan. */
  readonly plan: PlanTier;
  /** Whether the raw input named a real tier (false ⇒ fail-closed free). */
  readonly known: boolean;
  readonly label: string;
  readonly limits: readonly BillingLimitRow[];
  /** The gated features this plan unlocks, in catalogue order. */
  readonly features: readonly PlanFeature[];
  readonly seats: BillingUsage;
  readonly guests: BillingUsage;
  readonly prices: Readonly<Record<PlanTier, number>>;
  readonly proration: readonly PlanProrationPreview[];
}

/** Inputs to {@link buildBillingViewModel}; times feed the proration preview. */
export interface BillingViewModelInput {
  readonly plan: unknown;
  readonly seatCount: number;
  readonly guestCount: number;
  readonly periodStart: TimeInput;
  readonly periodEnd: TimeInput;
  readonly at: TimeInput;
  /** Overrides {@link PLAN_MONTHLY_PRICES}; missing/invalid entries are ignored. */
  readonly prices?: Readonly<Record<string, number>>;
}

/** Fill every tier from the defaults, letting a caller override finite, ≥0 values. */
function normalizePrices(
  prices?: Readonly<Record<string, number>>,
): Readonly<Record<PlanTier, number>> {
  const out: Record<PlanTier, number> = { ...PLAN_MONTHLY_PRICES };
  if (prices) {
    for (const tier of PLAN_TIER_IDS) {
      const value = prices[tier];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        out[tier] = value;
      }
    }
  }
  return out;
}

/**
 * Map a workspace's plan and current usage onto the billing page's view model:
 * the tier summary (`describePlan`), its limit rows (`getPlanLimits`), the
 * features it unlocks, seat/guest meter readings (`canAddSeats` / `withinLimit`)
 * and a proration preview for every other tier (`proratePlanChange`). Pure and
 * deterministic — the page stays a thin shell.
 */
export function buildBillingViewModel(input: BillingViewModelInput): BillingViewModel {
  const plan = resolveWorkspacePlan(input.plan);
  const described = describePlan(plan);
  const limits = described.limits;
  const prices = normalizePrices(input.prices);
  const seatCount = clampCount(input.seatCount);
  const guestCount = clampCount(input.guestCount);

  const proration: PlanProrationPreview[] = [];
  for (const to of PLAN_TIER_IDS) {
    if (to === plan) continue;
    const result = proratePlanChange({
      from: plan,
      to,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      at: input.at,
      priceMonthly: prices,
    });
    if (!result) continue;
    proration.push({
      to,
      label: describePlan(to).label,
      direction: result.direction,
      fractionRemaining: result.fractionRemaining,
      credit: result.credit,
      charge: result.charge,
      amountDue: result.amountDue,
    });
  }

  return {
    plan,
    known: normalizePlan(input.plan) !== null,
    label: described.label,
    limits: PLAN_LIMIT_KINDS.map((kind) => ({
      kind,
      label: planLimitLabel(kind),
      amount: limits[kind],
    })),
    features: described.features,
    seats: {
      used: seatCount,
      limit: limits.seats,
      canAdd: canAddSeats(plan, seatCount),
    },
    guests: {
      used: guestCount,
      limit: limits.guests,
      canAdd: withinLimit(plan, { kind: "guests", used: guestCount }),
    },
    prices,
    proration,
  };
}
