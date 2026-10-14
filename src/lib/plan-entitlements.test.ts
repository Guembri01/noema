import { describe, expect, it } from "vitest";
import {
  PLANS,
  PLAN_IDS,
  canUse,
  entitlementsFor,
  isKnownPlan,
  remaining,
  upgradeFor,
  validatePlan,
  withinLimit,
} from "./plan-entitlements";
import type { LimitKey, PlanFeature, PlanLimit } from "./plan-entitlements";

/**
 * Plan entitlements — the pure capability ladder behind the four plans.
 *
 * Red-first: `src/lib/plan-entitlements.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 * This is the pure half of the licensing substrate: a frozen four-plan
 * catalogue (numeric-or-`"unlimited"` limits plus a boolean feature set),
 * lookup (`entitlementsFor`), feature checks (`canUse`), capacity checks
 * (`withinLimit` / `remaining`), an `upgradeFor` router and a `validatePlan`
 * diagnostic. Every unknown input fails closed. No DB, routes, React, clock or
 * `process.env`.
 */

const LIMIT_KEYS: readonly LimitKey[] = ["members", "guests", "databases", "fileMb", "versionDays"];
const FEATURES: readonly PlanFeature[] = [
  "api",
  "webhooks",
  "versionHistory",
  "sso",
  "auditLog",
  "customRoles",
];

/** A limit as an orderable number; `"unlimited"` outranks every finite value. */
function rank(limit: PlanLimit): number {
  return limit === "unlimited" ? Number.POSITIVE_INFINITY : limit;
}

describe("PLANS catalogue", () => {
  it("lists the four plans in ladder order with a features Set each", () => {
    expect([...PLAN_IDS]).toEqual(["free", "plus", "business", "enterprise"]);
    for (const plan of PLAN_IDS) {
      expect(PLANS[plan].features).toBeInstanceOf(Set);
    }
  });

  it("keys every catalogue entry by its own plan id", () => {
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it("never lets a higher plan have a lower numeric limit", () => {
    for (const key of LIMIT_KEYS) {
      for (let i = 1; i < PLAN_IDS.length; i += 1) {
        const lower = rank(PLANS[PLAN_IDS[i - 1]][key]);
        const higher = rank(PLANS[PLAN_IDS[i]][key]);
        expect(higher).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  it("keeps the feature sets monotone across the ladder", () => {
    for (let i = 1; i < PLAN_IDS.length; i += 1) {
      const lower = PLANS[PLAN_IDS[i - 1]].features;
      const higher = PLANS[PLAN_IDS[i]].features;
      for (const feature of lower) expect(higher.has(feature)).toBe(true);
    }
  });
});

describe("entitlementsFor", () => {
  it("returns the catalogue entry for a known plan", () => {
    expect(entitlementsFor("plus")).toBe(PLANS.plus);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(entitlementsFor("  BUSINESS ")).toBe(PLANS.business);
  });

  it("fails closed to free for an unknown plan", () => {
    expect(entitlementsFor("bogus")).toBe(PLANS.free);
    expect(entitlementsFor("PRO")).toBe(PLANS.free);
  });

  it("fails closed to free for a non-string plan", () => {
    expect(entitlementsFor(42 as unknown as string)).toBe(PLANS.free);
  });
});

describe("isKnownPlan", () => {
  it("recognises real plan ids, ignoring case and whitespace", () => {
    expect(isKnownPlan("free")).toBe(true);
    expect(isKnownPlan(" Enterprise ")).toBe(true);
  });

  it("rejects unknown, empty and non-string values", () => {
    expect(isKnownPlan("pro")).toBe(false);
    expect(isKnownPlan("")).toBe(false);
    expect(isKnownPlan(7)).toBe(false);
  });
});

describe("canUse", () => {
  it("grants free no boolean features", () => {
    for (const feature of FEATURES) expect(canUse("free", feature)).toBe(false);
  });

  it("unlocks api, webhooks and version history on plus", () => {
    expect(canUse("plus", "api")).toBe(true);
    expect(canUse("plus", "webhooks")).toBe(true);
    expect(canUse("plus", "versionHistory")).toBe(true);
    expect(canUse("plus", "sso")).toBe(false);
    expect(canUse("plus", "customRoles")).toBe(false);
  });

  it("unlocks sso and the audit log on business but not custom roles", () => {
    expect(canUse("business", "sso")).toBe(true);
    expect(canUse("business", "auditLog")).toBe(true);
    expect(canUse("business", "customRoles")).toBe(false);
  });

  it("unlocks every catalogued feature on enterprise", () => {
    for (const feature of FEATURES) expect(canUse("enterprise", feature)).toBe(true);
  });

  it("never grants an unknown feature, even on enterprise", () => {
    expect(canUse("enterprise", "unobtainium")).toBe(false);
  });

  it("fails closed for an unknown plan", () => {
    expect(canUse("bogus", "api")).toBe(false);
  });
});

describe("withinLimit", () => {
  it("admits usage strictly below a numeric ceiling", () => {
    expect(withinLimit("free", "members", 9)).toBe(true);
    expect(withinLimit("free", "members", 0)).toBe(true);
  });

  it("denies usage at or above a numeric ceiling", () => {
    expect(withinLimit("free", "members", 10)).toBe(false);
    expect(withinLimit("free", "members", 11)).toBe(false);
    expect(withinLimit("free", "guests", 0)).toBe(false);
  });

  it("always admits usage under an unlimited ceiling", () => {
    expect(withinLimit("enterprise", "members", 1_000_000)).toBe(true);
  });

  it("fails closed to free's ceiling for an unknown plan", () => {
    expect(withinLimit("bogus", "members", 10)).toBe(false);
    expect(withinLimit("bogus", "members", 9)).toBe(true);
  });

  it("denies an unknown limit key", () => {
    expect(withinLimit("enterprise", "seats" as LimitKey, 0)).toBe(false);
  });

  it("fails closed for a non-finite or negative current value", () => {
    expect(withinLimit("free", "members", Number.NaN)).toBe(false);
    expect(withinLimit("free", "members", -5)).toBe(true);
  });
});

describe("remaining", () => {
  it("counts down a numeric ceiling", () => {
    expect(remaining("free", "members", 4)).toBe(6);
  });

  it("clamps to zero once the ceiling is reached or exceeded", () => {
    expect(remaining("free", "members", 10)).toBe(0);
    expect(remaining("free", "members", 99)).toBe(0);
  });

  it("reports unlimited for an unlimited ceiling", () => {
    expect(remaining("enterprise", "versionDays", 10_000)).toBe("unlimited");
  });

  it("fails closed to zero for an unknown key or plan", () => {
    expect(remaining("enterprise", "seats" as LimitKey, 0)).toBe(0);
    expect(remaining("bogus", "members", 0)).toBe(PLANS.free.members);
  });
});

describe("upgradeFor", () => {
  it("returns the cheapest plan that unlocks a feature", () => {
    expect(upgradeFor("api")).toBe("plus");
    expect(upgradeFor("sso")).toBe("business");
    expect(upgradeFor("customRoles")).toBe("enterprise");
  });

  it("returns null for a feature no plan grants", () => {
    expect(upgradeFor("unobtainium")).toBeNull();
  });
});

describe("validatePlan", () => {
  it("accepts a known id and normalises case and whitespace", () => {
    const result = validatePlan("  PLUS ");
    expect(result.ok).toBe(true);
    expect(result.plan).toBe("plus");
    expect(result.issues).toEqual([]);
  });

  it("reports an unknown plan", () => {
    const result = validatePlan("pro");
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues).toEqual([{ code: "unknown_plan", plan: "pro" }]);
  });

  it("reports an empty plan", () => {
    expect(validatePlan("   ").issues).toEqual([{ code: "empty_plan", plan: "   " }]);
  });

  it("reports a non-string plan", () => {
    const result = validatePlan(42);
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues[0]?.code).toBe("not_a_string");
  });
});
