/**
 * Plan entitlements — the pure capability ladder behind Noema's four plans.
 *
 * A workspace's plan (`free`, `plus`, `business`, `enterprise`) is a single
 * value that decides two different things:
 *
 *   1. **Limits** — the numeric ceilings on `members`, `guests`, `databases`,
 *      `fileMb` and `versionDays`. A limit is either a positive number or the
 *      literal `"unlimited"`.
 *   2. **Features** — a set of boolean capability keys a plan unlocks (`api`,
 *      `webhooks`, `versionHistory`, `sso`, `auditLog`, `customRoles`).
 *
 * Everything here is pure and deterministic: a frozen catalogue, no DB, no
 * requests, no clock, no mutation of inputs, no `any`, no `process.env`. Stored
 * plan values arrive from untrusted callers, so the helpers normalise and
 * **fail closed** — an unknown plan degrades to `free` (the most restrictive
 * tier), an unknown feature is never granted, an unknown limit key is never
 * within its limit and an unknown upgrade target is `null`. `validatePlan`
 * reports a bad plan explicitly when a caller wants to reject it rather than
 * degrade.
 *
 * This is the entitlements half of the licensing substrate
 * (`docs/specs/plans-licensing.md`): the hard feature gates and the Class-B
 * capacity defaults both read from it. It is not the edition resolver and it
 * owns no I/O.
 */

/** The four plans, in ladder order from least to most capable. */
export type PlanId = "free" | "plus" | "business" | "enterprise";

/** The capacity ceilings every plan declares. */
export type LimitKey = "members" | "guests" | "databases" | "fileMb" | "versionDays";

/** A ceiling: a finite number, or the literal `"unlimited"`. */
export type PlanLimit = number | "unlimited";

/** The boolean capabilities a plan can unlock. */
export type PlanFeature =
  | "api"
  | "webhooks"
  | "versionHistory"
  | "sso"
  | "auditLog"
  | "customRoles";

/** One plan's full entitlement set. */
export interface PlanEntitlements {
  readonly members: PlanLimit;
  readonly guests: PlanLimit;
  readonly databases: PlanLimit;
  readonly fileMb: PlanLimit;
  readonly versionDays: PlanLimit;
  /** The features this plan grants; empty for `free`. */
  readonly features: ReadonlySet<PlanFeature>;
}

/** Every plan id, in ladder order — the order `upgradeFor` searches. */
export const PLAN_IDS: readonly PlanId[] = ["free", "plus", "business", "enterprise"];

/** Build a feature set; a tiny helper so the catalogue below stays declarative. */
function featureSet(...features: PlanFeature[]): ReadonlySet<PlanFeature> {
  return new Set(features);
}

/**
 * The frozen catalogue, least to most capable. Limits are monotone and feature
 * sets are cumulative, so a higher plan never gives up a lower plan's
 * entitlement (`src/lib/plan-entitlements.test.ts` pins both properties).
 */
export const PLANS: Readonly<Record<PlanId, PlanEntitlements>> = {
  free: {
    members: 10,
    guests: 0,
    databases: 5,
    fileMb: 5,
    versionDays: 7,
    features: featureSet(),
  },
  plus: {
    members: 100,
    guests: 25,
    databases: 50,
    fileMb: 25,
    versionDays: 30,
    features: featureSet("api", "webhooks", "versionHistory"),
  },
  business: {
    members: 500,
    guests: 100,
    databases: 250,
    fileMb: 100,
    versionDays: 180,
    features: featureSet("api", "webhooks", "versionHistory", "sso", "auditLog"),
  },
  enterprise: {
    members: "unlimited",
    guests: "unlimited",
    databases: "unlimited",
    fileMb: 1024,
    versionDays: "unlimited",
    features: featureSet("api", "webhooks", "versionHistory", "sso", "auditLog", "customRoles"),
  },
};

/** Normalise a raw plan to a known id, or `null`. Case- and space-insensitive. */
function normalizePlan(plan: unknown): PlanId | null {
  if (typeof plan !== "string") return null;
  const id = plan.trim().toLowerCase();
  return (PLAN_IDS as readonly string[]).includes(id) ? (id as PlanId) : null;
}

/** Whether `plan` names a known plan (case- and whitespace-insensitive). */
export function isKnownPlan(plan: unknown): boolean {
  return normalizePlan(plan) !== null;
}

/**
 * The entitlements for `plan`, falling back to `free` when the plan is unknown
 * or malformed — the fail-closed default. Callers wanting to reject a bad plan
 * outright should use `validatePlan` first.
 */
export function entitlementsFor(plan: string): PlanEntitlements {
  return PLANS[normalizePlan(plan) ?? "free"];
}

/**
 * Whether `plan` grants the boolean `feature`. An unknown feature is never
 * granted, and an unknown plan is checked against `free`.
 */
export function canUse(plan: string, feature: string): boolean {
  return (entitlementsFor(plan).features as ReadonlySet<string>).has(feature);
}

/** The ceiling for `key` under `plan`, or `null` for an unknown key. */
function limitFor(plan: string, key: string): PlanLimit | null {
  const entitlements = entitlementsFor(plan) as unknown as Record<string, unknown>;
  const value = entitlements[key];
  if (value === "unlimited") return "unlimited";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * Clamp an untrusted usage count to a non-negative number, or `null` when it
 * is not finite — the signal callers turn into a fail-closed answer.
 */
function usageOf(current: number): number | null {
  if (!Number.isFinite(current)) return null;
  return current > 0 ? current : 0;
}

/**
 * Whether `current` leaves room under `key`'s ceiling — i.e. one more unit is
 * permitted. A finite ceiling admits `current < limit`, so being *at* the limit
 * denies: a cap of N rejects the (N+1)-th item. `"unlimited"` always admits.
 * An unknown key, plan or non-finite `current` fails closed.
 */
export function withinLimit(plan: string, key: LimitKey, current: number): boolean {
  const limit = limitFor(plan, key);
  if (limit === null) return false;
  if (limit === "unlimited") return true;
  const used = usageOf(current);
  return used === null ? false : used < limit;
}

/**
 * The room left under `key`'s ceiling: `limit - current`, clamped to `0` once
 * the ceiling is reached, or `"unlimited"` for an unlimited ceiling. An unknown
 * key or a non-finite `current` fails closed to `0`.
 */
export function remaining(plan: string, key: LimitKey, current: number): PlanLimit {
  const limit = limitFor(plan, key);
  if (limit === "unlimited") return "unlimited";
  if (limit === null) return 0;
  const used = usageOf(current);
  return used === null ? 0 : Math.max(0, limit - used);
}

/**
 * The cheapest plan that grants `feature`, in ladder order, or `null` when no
 * plan does. Drives an upgrade prompt without hard-coding the tier ladder.
 */
export function upgradeFor(feature: string): PlanId | null {
  for (const plan of PLAN_IDS) {
    if ((PLANS[plan].features as ReadonlySet<string>).has(feature)) return plan;
  }
  return null;
}

/** A stable diagnostic code for a rejected plan value. */
export type PlanIssueCode = "not_a_string" | "empty_plan" | "unknown_plan";

/** One problem found by {@link validatePlan}. */
export interface PlanIssue {
  /** Stable code a UI can map to a message. */
  readonly code: PlanIssueCode;
  /** The offending plan value, as given (stringified for non-strings). */
  readonly plan: string;
}

/** The full result of validating a candidate plan. */
export interface PlanValidation {
  /** `true` when the plan is known. */
  readonly ok: boolean;
  /** The normalised plan id when known, else `null`. */
  readonly plan: PlanId | null;
  /** Every problem, in first-seen order. */
  readonly issues: readonly PlanIssue[];
}

/** Short, safe rendering of an untrusted value for an issue's `plan` field. */
function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return "[unserializable]";
    }
  }
  return String(value);
}

/**
 * Validate a candidate plan. A known id is accepted after trimming and
 * lower-casing; otherwise every problem is reported in one pass with a stable
 * code: `not_a_string`, `empty_plan` or `unknown_plan`. Never throws.
 */
export function validatePlan(value: unknown): PlanValidation {
  if (typeof value !== "string") {
    return { ok: false, plan: null, issues: [{ code: "not_a_string", plan: show(value) }] };
  }

  if (value.trim() === "") {
    return { ok: false, plan: null, issues: [{ code: "empty_plan", plan: value }] };
  }

  const plan = normalizePlan(value);
  if (plan === null) {
    return { ok: false, plan: null, issues: [{ code: "unknown_plan", plan: value.trim() }] };
  }

  return { ok: true, plan, issues: [] };
}
