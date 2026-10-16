import { describe, expect, it } from "vitest";
import {
  PLAN_MONTHLY_PRICES,
  WORKSPACE_PLAN_ENV,
  buildBillingViewModel,
  evaluateGuestInviteGate,
  formatPlanAmount,
  planLimitLabel,
  readWorkspacePlan,
  resolveWorkspacePlan,
} from "./workspace-plan";
import { PLAN_LIMIT_KINDS, PLAN_TIER_IDS } from "./plans";

/**
 * Wiring layer for `@/lib/plans`: the two things the engine is now load-bearing
 * for — the external-guest invite gate and the plan/billing page view model —
 * plus the fail-closed plan resolution and amount rendering they depend on.
 * Everything here is pure (no DB, no clock, no React); the server action's use
 * of the gate is covered separately in
 * `src/server/actions/guest-invite-gate.test.ts`.
 */

const PERIOD_START = "2026-01-01T00:00:00.000Z";
const PERIOD_END = "2026-02-01T00:00:00.000Z";

describe("resolveWorkspacePlan / readWorkspacePlan", () => {
  it("normalises case and whitespace", () => {
    expect(resolveWorkspacePlan("  Team ")).toBe("team");
    expect(resolveWorkspacePlan("ENTERPRISE")).toBe("enterprise");
  });

  it("fails closed to free for unknown or malformed values", () => {
    expect(resolveWorkspacePlan(undefined)).toBe("free");
    expect(resolveWorkspacePlan(null)).toBe("free");
    expect(resolveWorkspacePlan("")).toBe("free");
    expect(resolveWorkspacePlan("pro")).toBe("free");
    expect(resolveWorkspacePlan(42)).toBe("free");
  });

  it("reads the WORKSPACE_PLAN environment field, defaulting to free", () => {
    expect(WORKSPACE_PLAN_ENV).toBe("WORKSPACE_PLAN");
    expect(readWorkspacePlan({ [WORKSPACE_PLAN_ENV]: "personal" })).toBe("personal");
    expect(readWorkspacePlan({})).toBe("free");
    expect(readWorkspacePlan({ [WORKSPACE_PLAN_ENV]: "bogus" })).toBe("free");
    expect(readWorkspacePlan({ [WORKSPACE_PLAN_ENV]: undefined })).toBe("free");
  });
});

describe("formatPlanAmount / planLimitLabel", () => {
  it("renders unlimited and grouped finite ceilings", () => {
    expect(formatPlanAmount("unlimited")).toBe("Unlimited");
    expect(formatPlanAmount(0)).toBe("0");
    expect(formatPlanAmount(100)).toBe("100");
    expect(formatPlanAmount(10_000)).toBe("10,000");
    expect(formatPlanAmount(250_000)).toBe("250,000");
  });

  it("labels every metered kind", () => {
    for (const kind of PLAN_LIMIT_KINDS) {
      expect(planLimitLabel(kind).length).toBeGreaterThan(0);
    }
    expect(planLimitLabel("guests")).toBe("External guests");
    expect(planLimitLabel("seats")).toBe("Member seats");
  });
});

describe("evaluateGuestInviteGate", () => {
  it("admits the N-th guest and denies the (N+1)-th on a finite cap", () => {
    expect(evaluateGuestInviteGate("free", 4).allowed).toBe(true);
    const denied = evaluateGuestInviteGate("free", 5);
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(5);
    expect(denied.used).toBe(5);
    expect(denied.plan).toBe("free");
    expect(denied.reason).toContain("Free plan");
    expect(denied.reason).toContain("5 external");
  });

  it("tracks the paid ladder", () => {
    expect(evaluateGuestInviteGate("personal", 24).allowed).toBe(true);
    expect(evaluateGuestInviteGate("personal", 25).allowed).toBe(false);
    expect(evaluateGuestInviteGate("team", 99).allowed).toBe(true);
    expect(evaluateGuestInviteGate("team", 100).allowed).toBe(false);
  });

  it("never denies an unlimited cap", () => {
    const gate = evaluateGuestInviteGate("enterprise", 1_000_000);
    expect(gate.allowed).toBe(true);
    expect(gate.limit).toBe("unlimited");
    expect(gate.reason).toBeNull();
  });

  it("fails closed on a non-finite usage count", () => {
    expect(evaluateGuestInviteGate("free", Number.NaN).allowed).toBe(false);
    expect(evaluateGuestInviteGate("enterprise", Number.POSITIVE_INFINITY).allowed).toBe(false);
  });

  it("treats negative usage as zero", () => {
    const gate = evaluateGuestInviteGate("free", -3);
    expect(gate.allowed).toBe(true);
    expect(gate.used).toBe(0);
  });
});

describe("buildBillingViewModel (billing page data mapping)", () => {
  const base = {
    seatCount: 3,
    guestCount: 2,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    at: PERIOD_START,
  } as const;

  it("maps a known plan onto its label, limits and unlocked features", () => {
    const model = buildBillingViewModel({ plan: "team", ...base });

    expect(model.plan).toBe("team");
    expect(model.known).toBe(true);
    expect(model.label).toBe("Team");
    // One row per metered kind, in catalogue order, labelled.
    expect(model.limits.map((row) => row.kind)).toEqual([...PLAN_LIMIT_KINDS]);
    expect(model.limits.find((row) => row.kind === "guests")?.amount).toBe(100);
    expect(model.limits.find((row) => row.kind === "aiTokens")?.amount).toBe(250_000);
    expect(model.limits.find((row) => row.kind === "seats")?.amount).toBe(500);
    expect(model.features).toEqual(["auditLog"]);
  });

  it("reads the seat and guest meters through the engine", () => {
    const atCeiling = buildBillingViewModel({ plan: "free", ...base, seatCount: 10, guestCount: 5 });
    expect(atCeiling.seats).toEqual({ used: 10, limit: 10, canAdd: false });
    expect(atCeiling.guests).toEqual({ used: 5, limit: 5, canAdd: false });

    const over = buildBillingViewModel({
      plan: "enterprise",
      ...base,
      seatCount: 999,
      guestCount: 999,
    });
    expect(over.seats.canAdd).toBe(true);
    expect(over.guests.canAdd).toBe(true);
  });

  it("fails closed to free and reports an unknown plan", () => {
    const model = buildBillingViewModel({ plan: "pro-plus", ...base });
    expect(model.plan).toBe("free");
    expect(model.known).toBe(false);
    expect(model.label).toBe("Free");
    expect(model.features).toEqual([]);
  });

  it("previews a proration for every other tier, priced by direction", () => {
    const model = buildBillingViewModel({ plan: "free", ...base });
    expect(model.proration.map((preview) => preview.to)).toEqual(["personal", "team", "enterprise"]);
    expect(model.proration.map((preview) => preview.direction)).toEqual([
      "upgrade",
      "upgrade",
      "upgrade",
    ]);
    // At the start of the period the whole month is billed at list price.
    const personal = model.proration.find((preview) => preview.to === "personal");
    expect(personal).toMatchObject({
      fractionRemaining: 1,
      credit: 0,
      charge: PLAN_MONTHLY_PRICES.personal,
      amountDue: PLAN_MONTHLY_PRICES.personal,
    });
  });

  it("reports a downgrade as credit owed to the workspace", () => {
    const model = buildBillingViewModel({ plan: "enterprise", ...base });
    const downToFree = model.proration.find((preview) => preview.to === "free");
    expect(downToFree?.direction).toBe("downgrade");
    expect(downToFree?.amountDue).toBe(-PLAN_MONTHLY_PRICES.enterprise);
    const downToTeam = model.proration.find((preview) => preview.to === "team");
    expect(downToTeam?.direction).toBe("downgrade");
    expect(downToTeam?.amountDue).toBe(
      PLAN_MONTHLY_PRICES.team - PLAN_MONTHLY_PRICES.enterprise,
    );
  });

  it("honours finite, non-negative price overrides and ignores the rest", () => {
    const model = buildBillingViewModel({
      plan: "free",
      ...base,
      prices: { team: 300, personal: -5, enterprise: Number.NaN },
    });
    expect(model.proration.find((preview) => preview.to === "team")?.amountDue).toBe(300);
    expect(model.proration.find((preview) => preview.to === "personal")?.amountDue).toBe(
      PLAN_MONTHLY_PRICES.personal,
    );
    expect(model.prices.free).toBe(0);
  });

  it("clamps untrusted usage counts", () => {
    const model = buildBillingViewModel({
      plan: "free",
      ...base,
      seatCount: Number.NaN,
      guestCount: -4,
    });
    expect(model.seats.used).toBe(0);
    expect(model.guests.used).toBe(0);
  });

  it("walks the whole ladder deterministically", () => {
    for (const plan of PLAN_TIER_IDS) {
      const first = buildBillingViewModel({ plan, ...base });
      const second = buildBillingViewModel({ plan, ...base });
      expect(first).toEqual(second);
      expect(first.proration).toHaveLength(PLAN_TIER_IDS.length - 1);
    }
  });
});
