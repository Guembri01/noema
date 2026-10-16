import { describe, expect, it } from "vitest";
import {
  PLAN_FEATURES,
  PLAN_LIMIT_KINDS,
  PLAN_TIER_IDS,
  PLAN_TIERS,
  SELF_HOSTED_LICENSE_KINDS,
  canAddSeats,
  describePlan,
  getPlanLimits,
  isFeatureAllowed,
  isKnownPlan,
  isSelfHostedLicenseKind,
  meterUsage,
  normalizePlan,
  proratePlanChange,
  withinLimit,
} from "./plans";
import type { PlanAmount, PlanLimitKind, PlanLimits, PlanTier, UsageEvent } from "./plans";

/**
 * Plans — the pure plan/licensing engine behind the 14 rows of the
 * "Pricing & plan-gated features" matrix area (`docs/FEATURE_MATRIX.md:671-689`)
 * and `docs/specs/plans-licensing.md`.
 *
 * Red-first: `src/lib/plans.ts` did not exist when this file was written, so
 * every test below fails on the missing module until the helpers land. The
 * suite pins the frozen four-tier catalogue (`PLAN_TIERS`), lookup
 * (`getPlanLimits`), plan gates (`isFeatureAllowed`), usage metering
 * (`withinLimit` / `meterUsage`), seat management (`canAddSeats`),
 * deterministic plan-change proration (`proratePlanChange`), the
 * `describePlan` summary and `SELF_HOSTED_LICENSE_KINDS`.
 *
 * Everything is pure and deterministic: no DB, no routes, no React, no clock,
 * no `process.env`, no `any`. Unknown inputs fail closed.
 */

const NUMERIC_KINDS: readonly PlanLimitKind[] = [
  "guests",
  "storage",
  "versionRetentionDays",
  "aiTokens",
  "seats",
];

const LIMITS_KEYS = [...NUMERIC_KINDS, "sso", "auditLog"].sort();

/** A limit as an orderable number; `"unlimited"` outranks every finite value. */
function rank(limit: PlanAmount): number {
  return limit === "unlimited" ? Number.POSITIVE_INFINITY : limit;
}

describe("PLAN_TIERS catalogue", () => {
  it("lists the four tiers cheapest-first", () => {
    expect([...PLAN_TIER_IDS]).toEqual(["free", "personal", "team", "enterprise"]);
    expect(Object.keys(PLAN_TIERS).sort()).toEqual([...PLAN_TIER_IDS].sort());
  });

  it("declares exactly the seven documented limit keys on every tier", () => {
    for (const tier of PLAN_TIER_IDS) {
      expect(Object.keys(PLAN_TIERS[tier]).sort()).toEqual(LIMITS_KEYS);
    }
  });

  it("never lets a higher tier have a lower numeric ceiling", () => {
    for (const kind of NUMERIC_KINDS) {
      for (let i = 1; i < PLAN_TIER_IDS.length; i += 1) {
        const lower = rank(PLAN_TIERS[PLAN_TIER_IDS[i - 1]][kind]);
        const higher = rank(PLAN_TIERS[PLAN_TIER_IDS[i]][kind]);
        expect(higher).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  it("keeps the boolean gates monotone across the ladder", () => {
    for (const gate of ["sso", "auditLog"] as const) {
      let seen = false;
      for (const tier of PLAN_TIER_IDS) {
        const value = PLAN_TIERS[tier][gate];
        if (seen) expect(value).toBe(true);
        seen = seen || value;
      }
    }
  });

  it("gates sso and the audit log away from free", () => {
    expect(PLAN_TIERS.free.sso).toBe(false);
    expect(PLAN_TIERS.free.auditLog).toBe(false);
    expect(PLAN_TIERS.enterprise.sso).toBe(true);
    expect(PLAN_TIERS.enterprise.auditLog).toBe(true);
  });

  it("makes every numeric ceiling unlimited on enterprise", () => {
    for (const kind of NUMERIC_KINDS) {
      expect(PLAN_TIERS.enterprise[kind]).toBe("unlimited");
    }
  });

  it("pins the free and team ceilings", () => {
    const free: PlanLimits = PLAN_TIERS.free;
    expect(free.guests).toBe(5);
    expect(free.storage).toBe(100);
    expect(free.versionRetentionDays).toBe(7);
    expect(free.aiTokens).toBe(10_000);
    expect(free.seats).toBe(10);
    expect(PLAN_TIERS.team.auditLog).toBe(true);
    expect(PLAN_TIERS.team.sso).toBe(false);
  });
});

describe("normalizePlan / isKnownPlan", () => {
  it("normalises case and surrounding whitespace", () => {
    expect(normalizePlan("  TEAM ")).toBe("team");
    expect(normalizePlan("Enterprise")).toBe("enterprise");
  });

  it("recognises real tiers and rejects the rest", () => {
    expect(isKnownPlan("free")).toBe(true);
    expect(isKnownPlan(" Personal ")).toBe(true);
    expect(isKnownPlan("plus")).toBe(false);
    expect(isKnownPlan("")).toBe(false);
    expect(isKnownPlan(9)).toBe(false);
    expect(isKnownPlan(null)).toBe(false);
  });

  it("returns null for unknown, empty or non-string plans", () => {
    expect(normalizePlan("bogus")).toBeNull();
    expect(normalizePlan("   ")).toBeNull();
    expect(normalizePlan(42)).toBeNull();
  });
});

describe("getPlanLimits", () => {
  it("returns the catalogue entry for a known plan", () => {
    expect(getPlanLimits("team")).toBe(PLAN_TIERS.team);
  });

  it("normalises case", () => {
    expect(getPlanLimits(" ENTERPRISE ")).toBe(PLAN_TIERS.enterprise);
  });

  it("fails closed to free for unknown and non-string plans", () => {
    expect(getPlanLimits("plus")).toBe(PLAN_TIERS.free);
    expect(getPlanLimits(7 as unknown as string)).toBe(PLAN_TIERS.free);
  });
});

describe("isFeatureAllowed", () => {
  it("grants free no gated feature", () => {
    for (const feature of PLAN_FEATURES) expect(isFeatureAllowed("free", feature)).toBe(false);
  });

  it("grants personal no gated feature", () => {
    for (const feature of PLAN_FEATURES) expect(isFeatureAllowed("personal", feature)).toBe(false);
  });

  it("unlocks the audit log on team but not sso, scim or custom roles", () => {
    expect(isFeatureAllowed("team", "auditLog")).toBe(true);
    expect(isFeatureAllowed("team", "sso")).toBe(false);
    expect(isFeatureAllowed("team", "scim")).toBe(false);
    expect(isFeatureAllowed("team", "customRoles")).toBe(false);
  });

  it("unlocks every gated feature on enterprise", () => {
    for (const feature of PLAN_FEATURES) expect(isFeatureAllowed("enterprise", feature)).toBe(true);
  });

  it("never grants an unknown feature, even on enterprise", () => {
    expect(isFeatureAllowed("enterprise", "unobtainium")).toBe(false);
  });

  it("fails closed for an unknown plan", () => {
    for (const feature of PLAN_FEATURES) expect(isFeatureAllowed("bogus", feature)).toBe(false);
  });

  it("normalises the plan name", () => {
    expect(isFeatureAllowed(" ENTERPRISE ", "sso")).toBe(true);
  });
});

describe("withinLimit", () => {
  it("admits a request that lands exactly on the ceiling", () => {
    expect(withinLimit("free", { kind: "guests", used: 4, adding: 1 })).toBe(true);
    expect(withinLimit("free", { kind: "guests", used: 5, adding: 0 })).toBe(true);
  });

  it("denies the request that would exceed a numeric ceiling", () => {
    expect(withinLimit("free", { kind: "guests", used: 5, adding: 1 })).toBe(false);
    expect(withinLimit("free", { kind: "guests", used: 4, adding: 2 })).toBe(false);
  });

  it("defaults adding to a single unit", () => {
    expect(withinLimit("free", { kind: "guests", used: 4 })).toBe(true);
    expect(withinLimit("free", { kind: "guests", used: 5 })).toBe(false);
  });

  it("always admits usage under an unlimited ceiling", () => {
    expect(withinLimit("enterprise", { kind: "seats", used: 1_000_000, adding: 1 })).toBe(true);
  });

  it("applies the ceiling of each numeric kind", () => {
    expect(withinLimit("personal", { kind: "storage", used: 999, adding: 1 })).toBe(true);
    expect(withinLimit("personal", { kind: "storage", used: 1_000, adding: 1 })).toBe(false);
    expect(withinLimit("free", { kind: "versionRetentionDays", used: 6, adding: 1 })).toBe(true);
    expect(withinLimit("free", { kind: "versionRetentionDays", used: 7, adding: 1 })).toBe(false);
  });

  it("fails closed for an unknown kind or plan", () => {
    expect(withinLimit("free", { kind: "sso" as PlanLimitKind, used: 0 })).toBe(false);
    expect(withinLimit("bogus", { kind: "guests", used: 4 })).toBe(true);
    expect(withinLimit("bogus", { kind: "guests", used: 5 })).toBe(false);
  });

  it("fails closed for a non-finite used or adding value", () => {
    expect(withinLimit("free", { kind: "guests", used: Number.NaN })).toBe(false);
    expect(withinLimit("free", { kind: "guests", used: 0, adding: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });

  it("clamps a negative used count to zero", () => {
    expect(withinLimit("free", { kind: "guests", used: -3, adding: 1 })).toBe(true);
  });
});

describe("canAddSeats", () => {
  it("admits seats up to the ceiling and denies the one past it", () => {
    expect(canAddSeats("free", 9, 1)).toBe(true);
    expect(canAddSeats("free", 10, 1)).toBe(false);
  });

  it("defaults delta to one seat", () => {
    expect(canAddSeats("free", 9)).toBe(true);
    expect(canAddSeats("free", 10)).toBe(false);
  });

  it("always admits a non-positive delta", () => {
    expect(canAddSeats("free", 10, 0)).toBe(true);
    expect(canAddSeats("free", 10, -1)).toBe(true);
  });

  it("denies a delta that overshoots the ceiling", () => {
    expect(canAddSeats("free", 5, 10)).toBe(false);
  });

  it("always admits seats on enterprise", () => {
    expect(canAddSeats("enterprise", 1_000_000, 1)).toBe(true);
  });

  it("fails closed for unknown plans using free's ceiling", () => {
    expect(canAddSeats("bogus", 9, 1)).toBe(true);
    expect(canAddSeats("bogus", 10, 1)).toBe(false);
  });

  it("fails closed for non-finite values", () => {
    expect(canAddSeats("free", Number.NaN, 1)).toBe(false);
    expect(canAddSeats("free", 0, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("clamps a negative current seat count to zero", () => {
    expect(canAddSeats("free", -5, 3)).toBe(true);
  });
});

describe("proratePlanChange", () => {
  const START = Date.parse("2026-01-01T00:00:00Z");
  const END = Date.parse("2026-01-31T00:00:00Z"); // exactly 30 days
  const HALF = START + 15 * 24 * 60 * 60 * 1000;
  const priceMonthly = { free: 0, personal: 10, team: 20, enterprise: 40 };

  it("charges the prorated difference on a mid-period upgrade", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly,
    });
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("upgrade");
    expect(result?.fractionRemaining).toBe(0.5);
    expect(result?.credit).toBe(5);
    expect(result?.charge).toBe(10);
    expect(result?.amountDue).toBe(5);
  });

  it("credits the unused value on a mid-period downgrade", () => {
    const result = proratePlanChange({
      from: "team",
      to: "personal",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly,
    });
    expect(result?.direction).toBe("downgrade");
    expect(result?.amountDue).toBe(-5);
  });

  it("nets to zero for the same plan", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "personal",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly,
    });
    expect(result?.direction).toBe("flat");
    expect(result?.amountDue).toBe(0);
  });

  it("treats two plans of equal price as a flat change", () => {
    const result = proratePlanChange({
      from: "free",
      to: "bogus",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly: { free: 7, bogus: 7 },
    });
    expect(result?.from).toBe("free");
    expect(result?.to).toBe("free");
    expect(result?.direction).toBe("flat");
    expect(result?.amountDue).toBe(0);
  });

  it("bills a full period when the change happens at the start", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: START,
      priceMonthly,
    });
    expect(result?.fractionRemaining).toBe(1);
    expect(result?.credit).toBe(10);
    expect(result?.charge).toBe(20);
    expect(result?.amountDue).toBe(10);
  });

  it("bills nothing when the period has already elapsed", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: END,
      priceMonthly,
    });
    expect(result?.fractionRemaining).toBe(0);
    expect(result?.amountDue).toBe(0);
  });

  it("clamps a change before the period to a full period", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: START - 86_400_000,
      priceMonthly,
    });
    expect(result?.fractionRemaining).toBe(1);
  });

  it("returns all zeros for a zero-length period", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: START,
      at: START,
      priceMonthly,
    });
    expect(result?.fractionRemaining).toBe(0);
    expect(result?.amountDue).toBe(0);
  });

  it("accepts ISO date strings interchangeably with epoch millis", () => {
    const fromIso = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-01-31T00:00:00Z",
      at: "2026-01-16T00:00:00Z",
      priceMonthly,
    });
    const fromMillis = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly,
    });
    expect(fromIso).toEqual(fromMillis);
  });

  it("rounds the prorated amounts to whole cents", () => {
    const third = START + (END - START) / 3; // leaves 2/3 of the period
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: third,
      priceMonthly,
    });
    expect(result?.fractionRemaining).toBe(0.6667);
    expect(result?.credit).toBe(6.67);
    expect(result?.charge).toBe(13.33);
    expect(result?.amountDue).toBeCloseTo(6.66, 2);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      from: "personal",
      to: "enterprise",
      periodStart: START,
      periodEnd: END,
      at: HALF,
      priceMonthly,
    } as const;
    expect(proratePlanChange(input)).toEqual(proratePlanChange(input));
  });

  it("clamps negative or non-finite prices to zero", () => {
    const result = proratePlanChange({
      from: "personal",
      to: "team",
      periodStart: START,
      periodEnd: END,
      at: START,
      priceMonthly: { personal: -10, team: Number.NaN },
    });
    expect(result?.credit).toBe(0);
    expect(result?.charge).toBe(0);
  });

  it("returns null for an unparseable date", () => {
    expect(
      proratePlanChange({
        from: "personal",
        to: "team",
        periodStart: "not-a-date",
        periodEnd: END,
        at: HALF,
        priceMonthly,
      }),
    ).toBeNull();
  });
});

describe("meterUsage", () => {
  it("rolls an empty stream up to zeros", () => {
    expect(meterUsage([])).toEqual({ total: 0, count: 0, byKind: {}, countByKind: {} });
  });

  it("sums quantities overall and per kind", () => {
    const events: UsageEvent[] = [
      { kind: "aiTokens", quantity: 100 },
      { kind: "storage", quantity: 5 },
      { kind: "aiTokens", quantity: 50 },
    ];
    const rollup = meterUsage(events);
    expect(rollup.total).toBe(155);
    expect(rollup.count).toBe(3);
    expect(rollup.byKind).toEqual({ aiTokens: 150, storage: 5 });
    expect(rollup.countByKind).toEqual({ aiTokens: 2, storage: 1 });
  });

  it("returns per-kind keys in sorted order for determinism", () => {
    const rollup = meterUsage([
      { kind: "zeta", quantity: 1 },
      { kind: "alpha", quantity: 2 },
      { kind: "mu", quantity: 3 },
    ]);
    expect(Object.keys(rollup.byKind)).toEqual(["alpha", "mu", "zeta"]);
    expect(Object.keys(rollup.countByKind)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("skips zero, negative and non-finite quantities", () => {
    const rollup = meterUsage([
      { kind: "aiTokens", quantity: 0 },
      { kind: "aiTokens", quantity: -5 },
      { kind: "aiTokens", quantity: Number.NaN },
      { kind: "aiTokens", quantity: Number.POSITIVE_INFINITY },
      { kind: "aiTokens", quantity: 7 },
    ]);
    expect(rollup.total).toBe(7);
    expect(rollup.count).toBe(1);
  });

  it("skips events with a blank or non-string kind", () => {
    const rollup = meterUsage([
      { kind: "  ", quantity: 1 },
      { kind: 7 as unknown as string, quantity: 1 },
      { kind: "storage", quantity: 2 },
    ]);
    expect(rollup.byKind).toEqual({ storage: 2 });
  });

  it("tolerates a non-array input", () => {
    expect(meterUsage(null as unknown as readonly UsageEvent[])).toEqual({
      total: 0,
      count: 0,
      byKind: {},
      countByKind: {},
    });
  });

  it("is deterministic for identical input", () => {
    const events: UsageEvent[] = [
      { kind: "b", quantity: 2 },
      { kind: "a", quantity: 1 },
    ];
    expect(meterUsage(events)).toEqual(meterUsage(events));
  });
});

describe("describePlan", () => {
  it("describes the free plan with no gated features", () => {
    const description = describePlan("free");
    expect(description.id).toBe("free");
    expect(description.label).toBe("Free");
    expect(description.known).toBe(true);
    expect(description.limits).toBe(PLAN_TIERS.free);
    expect(description.features).toEqual([]);
  });

  it("lists the gated features a tier unlocks in catalogue order", () => {
    expect(describePlan("team").features).toEqual(["auditLog"]);
    expect(describePlan("enterprise").features).toEqual([...PLAN_FEATURES]);
    expect(PLAN_FEATURES).toContain("sso");
  });

  it("normalises the plan name", () => {
    expect(describePlan(" ENTERPRISE ").label).toBe("Enterprise");
  });

  it("fails closed to free limits but reports the plan as unknown", () => {
    const description = describePlan("bogus");
    expect(description.id).toBeNull();
    expect(description.known).toBe(false);
    expect(description.label).toBe("Unknown");
    expect(description.limits).toBe(PLAN_TIERS.free);
    expect(description.features).toEqual([]);
  });
});

describe("SELF_HOSTED_LICENSE_KINDS", () => {
  it("lists the community default first", () => {
    expect([...SELF_HOSTED_LICENSE_KINDS]).toEqual([
      "community",
      "trial",
      "subscription",
      "perpetual",
    ]);
  });

  it("recognises a licence kind and rejects everything else", () => {
    expect(isSelfHostedLicenseKind("community")).toBe(true);
    expect(isSelfHostedLicenseKind("perpetual")).toBe(true);
    expect(isSelfHostedLicenseKind("enterprise")).toBe(false);
    expect(isSelfHostedLicenseKind("")).toBe(false);
    expect(isSelfHostedLicenseKind(3)).toBe(false);
  });

  it("exposes every plan tier as a known tier", () => {
    for (const tier of PLAN_TIER_IDS) expect(isKnownPlan(tier)).toBe(true);
    expect(PLAN_LIMIT_KINDS).toContain("seats");
    expect(PLAN_TIER_IDS as readonly PlanTier[]).toEqual([
      "free",
      "personal",
      "team",
      "enterprise",
    ]);
  });
});
