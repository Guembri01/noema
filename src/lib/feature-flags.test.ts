import { describe, expect, it } from "vitest";
import {
  FLAG_RULE_OPERATORS,
  bucketFor,
  evaluateFlag,
  isEnabled,
  resolveFlag,
  validateFlag,
  type Flag,
  type FlagContext,
  type FlagRule,
  type FlagRuleOperator,
} from "@/lib/feature-flags";

/*
   A pure feature-flag engine. The interesting properties are:

   - precedence is fixed and total: denylist > allowlist > rules > rollout >
     `enabled` (the baseline), so a beta flag can ship `enabled: false` and turn
     on only for an allowlist or a percentage of users;
   - the rollout bucket is a deterministic function of the user id, so a user
     never flip-flops between requests;
   - malformed stored flags fail closed (disabled) and `validateFlag` reports
     them instead of throwing.
*/

const ctx = (userId: string, attributes?: FlagContext["attributes"]): FlagContext =>
  attributes === undefined ? { userId } : { userId, attributes };

const flag = (overrides: Partial<Flag> = {}): Flag => ({
  key: "beta",
  enabled: false,
  ...overrides,
});

describe("bucketFor", () => {
  it("returns a stable integer in 0..99 for a spread of ids", () => {
    for (const id of ["user-1", "user-2", "user-3", "alpha", "", "a", "b", "c"]) {
      const bucket = bucketFor(id);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("is deterministic: the same id always buckets the same way", () => {
    expect(["a", "b", "c", "user-1"].map(bucketFor)).toEqual(
      ["a", "b", "c", "user-1"].map(bucketFor),
    );
  });

  it("pins the hash so a bucket never silently moves", () => {
    expect(["a", "b", "c"].map(bucketFor)).toEqual([20, 77, 58]);
    expect(bucketFor("user-1")).toBe(0);
    expect(bucketFor("user-2")).toBe(57);
  });

  it("spreads distinct ids across different buckets", () => {
    expect(new Set(["a", "b", "c", "user-1", "user-2", "user-3"].map(bucketFor)).size).toBeGreaterThan(1);
  });
});

describe("evaluateFlag — the enabled baseline", () => {
  it("disables a flag that is off with no targeting", () => {
    expect(evaluateFlag(flag(), ctx("u1"))).toEqual({ enabled: false, reason: "disabled" });
  });

  it("enables a flag that is on with no targeting", () => {
    expect(evaluateFlag(flag({ enabled: true }), ctx("u1"))).toEqual({
      enabled: true,
      reason: "enabled",
    });
  });

  it("treats a malformed stored flag as disabled, never throwing", () => {
    expect(evaluateFlag(null as unknown as Flag, ctx("u1"))).toEqual({
      enabled: false,
      reason: "invalid",
    });
    expect(evaluateFlag("nope" as unknown as Flag, ctx("u1"))).toEqual({
      enabled: false,
      reason: "invalid",
    });
  });
});

describe("evaluateFlag — precedence", () => {
  it("denylist beats allowlist, rules, rollout and enabled", () => {
    const f = flag({
      enabled: true,
      rollout: 100,
      allowlist: ["u1"],
      denylist: ["u1"],
      rules: [{ attr: "plan", op: "eq", value: "pro" }],
    });
    expect(evaluateFlag(f, ctx("u1", { plan: "pro" }))).toEqual({
      enabled: false,
      reason: "denylist",
    });
  });

  it("allowlist beats rules, rollout and enabled", () => {
    const f = flag({
      enabled: false,
      rollout: 0,
      allowlist: ["u1"],
      rules: [{ attr: "plan", op: "eq", value: "pro" }],
    });
    expect(evaluateFlag(f, ctx("u1", { plan: "free" }))).toEqual({
      enabled: true,
      reason: "allowlist",
    });
  });

  it("rules beat rollout and enabled", () => {
    const f = flag({
      enabled: false,
      rollout: 0,
      rules: [{ attr: "plan", op: "eq", value: "pro" }],
    });
    expect(evaluateFlag(f, ctx("u1", { plan: "pro" }))).toEqual({
      enabled: true,
      reason: "rules",
    });
  });

  it("rollout beats enabled", () => {
    const f = flag({ enabled: false, rollout: 100 });
    expect(evaluateFlag(f, ctx("u1"))).toEqual({ enabled: true, reason: "rollout" });
  });

  it("falls through every override to the enabled baseline", () => {
    const f = flag({
      enabled: true,
      allowlist: ["someone-else"],
      denylist: ["another"],
      rules: [{ attr: "plan", op: "eq", value: "enterprise" }],
    });
    expect(evaluateFlag(f, ctx("u1", { plan: "pro" }))).toEqual({
      enabled: true,
      reason: "enabled",
    });
  });

  it("only denylists the listed user", () => {
    const f = flag({ enabled: true, denylist: ["blocked"] });
    expect(evaluateFlag(f, ctx("blocked")).enabled).toBe(false);
    expect(evaluateFlag(f, ctx("allowed"))).toEqual({ enabled: true, reason: "enabled" });
  });
});

describe("evaluateFlag — rollout buckets", () => {
  it("turns every user off at 0 and on at 100", () => {
    for (const id of ["user-1", "user-2", "user-3"]) {
      expect(evaluateFlag(flag({ rollout: 0 }), ctx(id))).toEqual({
        enabled: false,
        reason: "rollout",
      });
      expect(evaluateFlag(flag({ rollout: 100 }), ctx(id))).toEqual({
        enabled: true,
        reason: "rollout",
      });
    }
  });

  it("includes a user exactly when their bucket is below the percentage", () => {
    const id = "user-2";
    const bucket = bucketFor(id); // pinned at 57 by the hash test
    expect(evaluateFlag(flag({ rollout: bucket }), ctx(id)).enabled).toBe(false);
    expect(evaluateFlag(flag({ rollout: bucket + 1 }), ctx(id)).enabled).toBe(true);
  });

  it("clamps an out-of-range rollout instead of throwing", () => {
    expect(evaluateFlag(flag({ rollout: -10 }), ctx("u1")).enabled).toBe(false);
    expect(evaluateFlag(flag({ rollout: 250 }), ctx("u1")).enabled).toBe(true);
    expect(evaluateFlag(flag({ rollout: 42.9 }), ctx("u1")).reason).toBe("rollout");
  });
});

describe("evaluateFlag — targeting rules", () => {
  const rules = (...r: FlagRule[]) => flag({ rules: r });

  it("eq / neq / in", () => {
    expect(evaluateFlag(rules({ attr: "plan", op: "eq", value: "pro" }), ctx("u", { plan: "pro" })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "plan", op: "eq", value: "pro" }), ctx("u", { plan: "free" })).enabled).toBe(false);
    expect(evaluateFlag(rules({ attr: "plan", op: "neq", value: "free" }), ctx("u", { plan: "pro" })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "plan", op: "in", value: ["pro", "team"] }), ctx("u", { plan: "team" })).enabled).toBe(true);
  });

  it("contains / starts_with / ends_with", () => {
    expect(evaluateFlag(rules({ attr: "email", op: "contains", value: "@acme" }), ctx("u", { email: "x@acme.com" })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "email", op: "starts_with", value: "x@" }), ctx("u", { email: "x@acme.com" })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "email", op: "ends_with", value: ".com" }), ctx("u", { email: "x@acme.com" })).enabled).toBe(true);
  });

  it("gt / lt / gte / lte compare numerically", () => {
    expect(evaluateFlag(rules({ attr: "age", op: "gt", value: 18 }), ctx("u", { age: 30 })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "age", op: "lt", value: 18 }), ctx("u", { age: 30 })).enabled).toBe(false);
    expect(evaluateFlag(rules({ attr: "age", op: "gte", value: 30 }), ctx("u", { age: 30 })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "age", op: "lte", value: 30 }), ctx("u", { age: "30" })).enabled).toBe(true);
  });

  it("exists / not_exists test presence", () => {
    expect(evaluateFlag(rules({ attr: "plan", op: "exists" }), ctx("u", { plan: "pro" })).enabled).toBe(true);
    expect(evaluateFlag(rules({ attr: "plan", op: "exists" }), ctx("u")).enabled).toBe(false);
    expect(evaluateFlag(rules({ attr: "plan", op: "not_exists" }), ctx("u")).enabled).toBe(true);
  });

  it("reads the userId as an attribute", () => {
    expect(evaluateFlag(rules({ attr: "userId", op: "eq", value: "u1" }), ctx("u1")).enabled).toBe(true);
  });

  it("an unknown operator never matches", () => {
    const f = rules({ attr: "plan", op: "wat" as FlagRuleOperator, value: "pro" });
    expect(evaluateFlag(f, ctx("u", { plan: "pro" }))).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });

  it("a malformed rule never matches", () => {
    const f = rules({ attr: 7 as unknown as string, op: "eq", value: "pro" });
    expect(evaluateFlag(f, ctx("u", { plan: "pro" })).enabled).toBe(false);
  });

  it("a rule on a missing attribute does not enable (fail closed)", () => {
    expect(evaluateFlag(rules({ attr: "plan", op: "neq", value: "free" }), ctx("u")).enabled).toBe(false);
  });

  it("only one matching rule is required", () => {
    const f = rules(
      { attr: "plan", op: "eq", value: "enterprise" },
      { attr: "plan", op: "eq", value: "pro" },
    );
    expect(evaluateFlag(f, ctx("u", { plan: "pro" })).enabled).toBe(true);
  });
});

describe("isEnabled / resolveFlag", () => {
  const flags: Flag[] = [
    flag({ key: "on", enabled: true }),
    flag({ key: "off", enabled: false }),
  ];

  it("finds a flag by key and answers its decision", () => {
    expect(isEnabled(flags, "on", ctx("u1"))).toBe(true);
    expect(isEnabled(flags, "off", ctx("u1"))).toBe(false);
  });

  it("answers not_found (disabled) for an unknown key", () => {
    expect(isEnabled(flags, "missing", ctx("u1"))).toBe(false);
    expect(resolveFlag(flags, "missing", ctx("u1"))).toEqual({
      enabled: false,
      reason: "not_found",
    });
  });

  it("survives a malformed flag list", () => {
    const junk = [null, undefined, 7, { key: 5 }] as unknown as Flag[];
    expect(() => isEnabled(junk, "anything", ctx("u1"))).not.toThrow();
    expect(isEnabled(junk, "anything", ctx("u1"))).toBe(false);
  });
});

describe("validateFlag", () => {
  it("reports nothing for a well-formed flag", () => {
    expect(
      validateFlag(
        flag({
          enabled: true,
          rollout: 50,
          allowlist: ["u1"],
          denylist: ["u2"],
          rules: [{ attr: "plan", op: "eq", value: "pro" }],
        }),
      ),
    ).toEqual([]);
  });

  it("reports a missing or empty key", () => {
    expect(validateFlag({ enabled: true }).map((i) => i.code)).toEqual(["missing_key"]);
    expect(validateFlag(flag({ key: "  " })).map((i) => i.code)).toEqual(["missing_key"]);
  });

  it("reports a non-boolean enabled", () => {
    expect(validateFlag({ key: "k", enabled: "yes" }).map((i) => i.code)).toEqual([
      "invalid_enabled",
    ]);
  });

  it("reports an out-of-range rollout", () => {
    expect(validateFlag(flag({ rollout: -1 })).map((i) => i.code)).toEqual(["invalid_rollout"]);
    expect(validateFlag(flag({ rollout: 101 })).map((i) => i.code)).toEqual(["invalid_rollout"]);
    expect(validateFlag(flag({ rollout: 1.5 })).map((i) => i.code)).toEqual(["invalid_rollout"]);
  });

  it("reports malformed allowlist and denylist", () => {
    expect(validateFlag(flag({ allowlist: [1] as unknown as string[] })).map((i) => i.code)).toEqual([
      "invalid_allowlist",
    ]);
    expect(validateFlag(flag({ denylist: "u1" as unknown as string[] })).map((i) => i.code)).toEqual([
      "invalid_denylist",
    ]);
  });

  it("reports malformed rules and unknown operators", () => {
    expect(validateFlag(flag({ rules: "nope" as unknown as FlagRule[] })).map((i) => i.code)).toEqual([
      "invalid_rules",
    ]);
    const issues = validateFlag(
      flag({
        rules: [
          { attr: "plan", op: "wat" as FlagRuleOperator, value: "pro" },
          { attr: 7 as unknown as string, op: "eq", value: "x" },
        ],
      }),
    );
    expect(issues.map((i) => [i.code, i.index])).toEqual([
      ["invalid_rule_op", 0],
      ["invalid_rule_attr", 1],
    ]);
  });

  it("never throws on junk input", () => {
    expect(() => validateFlag(null)).not.toThrow();
    expect(validateFlag(null).map((i) => i.code)).toEqual(["invalid_flag"]);
    expect(() => validateFlag([1, 2] as unknown as Flag)).not.toThrow();
  });
});

describe("FLAG_RULE_OPERATORS", () => {
  it("is the vocabulary evaluateFlag understands", () => {
    expect([...FLAG_RULE_OPERATORS]).toEqual([
      "eq",
      "neq",
      "in",
      "contains",
      "starts_with",
      "ends_with",
      "gt",
      "lt",
      "gte",
      "lte",
      "exists",
      "not_exists",
    ]);
  });
});
