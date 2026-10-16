import { describe, expect, it } from "vitest";
import {
  FLAG_RULE_OPERATORS,
  bucketFor,
  bucketOf,
  describeFlag,
  evaluateFlag,
  isEnabled,
  overridesFromEnv,
  parseFlags,
  resolveFlag,
  validateFlag,
  type Flag,
  type FlagContext,
  type FlagDefinition,
  type FlagEvaluationContext,
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

/* ------------------------------------------------------------------ *
 * §17 "Plan gates": the plan-aware definition surface
 * (`FlagDefinition`, `parseFlags`, `bucketOf`, `overridesFromEnv`,
 * `describeFlag`, and the plan-aware branch of `evaluateFlag`).
 * ------------------------------------------------------------------ */

const def = (overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key: "beta",
  enabled: false,
  ...overrides,
});

const planCtx = (context: FlagEvaluationContext = {}): FlagEvaluationContext => context;

describe("bucketOf - deterministic stable bucketing", () => {
  it("returns an integer in 0..99 for a spread of ids and keys", () => {
    const samples: Array<[string, string]> = [
      ["user-1", "beta"],
      ["user-2", "beta"],
      ["", "beta"],
      ["u1", "other"],
    ];
    for (const [userId, key] of samples) {
      const bucket = bucketOf(userId, key);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("is deterministic regardless of call order", () => {
    const input: Array<[string, string]> = [
      ["user-1", "beta"],
      ["user-2", "beta"],
      ["user-3", "beta"],
    ];
    const forward = input.map(([userId, key]) => bucketOf(userId, key));
    const reversed = [...input].reverse().map(([userId, key]) => bucketOf(userId, key)).reverse();
    expect(forward).toEqual(reversed);
  });

  it("pins the FNV-1a buckets so a user never drifts between requests", () => {
    expect([
      bucketOf("user-1", "beta"),
      bucketOf("user-2", "beta"),
      bucketOf("user-3", "beta"),
    ]).toEqual([28, 85, 66]);
    expect([bucketOf("alpha", "beta"), bucketOf("", "beta")]).toEqual([91, 25]);
  });

  it("salts by key so one user partitions independently per flag", () => {
    expect(bucketOf("u1", "beta")).toBe(91);
    expect(bucketOf("u1", "other")).toBe(81);
    expect(bucketOf("u1", "beta")).not.toBe(bucketOf("u1", "other"));
  });

  it("spreads distinct users across different buckets", () => {
    const buckets = ["user-1", "user-2", "user-3", "alpha", "u1"].map((userId) =>
      bucketOf(userId, "beta"),
    );
    expect(new Set(buckets).size).toBeGreaterThan(1);
  });
});

describe("parseFlags - untrusted raw to definitions", () => {
  it("parses an array with fail-closed defaults", () => {
    expect(parseFlags([{ key: "a", enabled: true }, { key: "b" }])).toEqual([
      { key: "a", enabled: true },
      { key: "b", enabled: false },
    ]);
  });

  it("parses a keyed map, using the map key as the fallback", () => {
    expect(parseFlags({ a: { enabled: true }, b: true })).toEqual([
      { key: "a", enabled: true },
      { key: "b", enabled: false },
    ]);
  });

  it("clamps rolloutPercent to an integer 0..100", () => {
    expect(
      parseFlags([
        { key: "a", rolloutPercent: 250 },
        { key: "b", rolloutPercent: -5 },
        { key: "c", rolloutPercent: 42.9 },
      ]),
    ).toEqual([
      { key: "a", enabled: false, rolloutPercent: 100 },
      { key: "b", enabled: false, rolloutPercent: 0 },
      { key: "c", enabled: false, rolloutPercent: 42 },
    ]);
  });

  it("drops entries without a usable key and tolerates junk", () => {
    expect(parseFlags([null, 7, "x", { enabled: true }, { key: "  " }, { key: "ok" }])).toEqual([
      { key: "ok", enabled: false },
    ]);
  });

  it("dedupes by key (first wins) and ignores unknown fields", () => {
    expect(parseFlags([{ key: "a", enabled: true, extra: 1 }, { key: "a", enabled: false }])).toEqual([
      { key: "a", enabled: true },
    ]);
  });

  it("normalises nested allowlists and plan gates", () => {
    expect(
      parseFlags([
        {
          key: "a",
          allowlist: { userIds: ["u1", 2], workspaceIds: ["w1"] },
          planGate: { plans: ["business", "x", 3] },
        },
        { key: "b", allowlist: ["u1", "u2"], planGate: ["business"] },
      ]),
    ).toEqual([
      {
        key: "a",
        enabled: false,
        allowlist: { userIds: ["u1"], workspaceIds: ["w1"] },
        planGate: { plans: ["business", "x"] },
      },
      { key: "b", enabled: false, allowlist: { userIds: ["u1", "u2"] }, planGate: { plans: ["business"] } },
    ]);
  });

  it("returns an empty list for non-array, non-object input", () => {
    expect(parseFlags(null)).toEqual([]);
    expect(parseFlags(42)).toEqual([]);
    expect(parseFlags("x")).toEqual([]);
  });
});

describe("overridesFromEnv", () => {
  it("reads the truthy token vocabulary", () => {
    expect(overridesFromEnv({ FLAG_BETA: "true", FLAG_DARK: "1", FLAG_X: "YES", FLAG_Y: "on" })).toEqual({
      beta: true,
      dark: true,
      x: true,
      y: true,
    });
  });

  it("reads the falsy token vocabulary", () => {
    expect(overridesFromEnv({ FLAG_A: "false", FLAG_B: "0", FLAG_C: "No", FLAG_D: "OFF" })).toEqual({
      a: false,
      b: false,
      c: false,
      d: false,
    });
  });

  it("ignores non-flag names, an empty suffix and unparseable values", () => {
    expect(overridesFromEnv({ SMTP_SECURE: "true", FLAG_: "true", FLAG_BAD: "maybe" })).toEqual({});
  });

  it("lower-cases the key and tolerates junk input", () => {
    expect(overridesFromEnv({ flag_beta_ui: "on" })).toEqual({ beta_ui: true });
    expect(overridesFromEnv(null)).toEqual({});
    expect(overridesFromEnv("FLAG_A=true")).toEqual({});
  });
});

describe("describeFlag", () => {
  it("summarises a bare flag", () => {
    expect(describeFlag({ key: "beta", enabled: true })).toBe("beta: on");
    expect(describeFlag({ key: "beta", enabled: false })).toBe("beta: off");
  });

  it("summarises allowlist, plan gate and rollout", () => {
    expect(
      describeFlag({
        key: "beta",
        enabled: false,
        allowlist: { userIds: ["u1", "u2"], workspaceIds: ["w1"] },
        planGate: { plans: ["business"] },
        rolloutPercent: 25,
      }),
    ).toBe("beta: off (allowlist 2 users, 1 workspace, plans business, rollout 25%)");
    expect(describeFlag({ key: "a", enabled: true, allowlist: ["u1", "u2"] })).toBe(
      "a: on (allowlist 2 users)",
    );
  });

  it("never throws on a malformed definition", () => {
    expect(describeFlag(null)).toBe("unknown flag");
    expect(describeFlag({})).toBe("?: off");
  });
});

describe("evaluateFlag - plan-aware precedence", () => {
  it("falls through to the global tier and reports it", () => {
    expect(evaluateFlag(def({ enabled: true }), planCtx({ plan: "free" }))).toEqual({
      enabled: true,
      reason: "global",
    });
    expect(evaluateFlag(def({ enabled: false }), planCtx({ plan: "free" }))).toEqual({
      enabled: false,
      reason: "global",
    });
  });

  it("allowlist (userIds) beats planGate, rollout and global", () => {
    const definition = def({
      enabled: false,
      allowlist: { userIds: ["u1"] },
      planGate: { plans: ["business"] },
      rolloutPercent: 0,
    });
    expect(evaluateFlag(definition, planCtx({ userId: "u1", plan: "free" }))).toEqual({
      enabled: true,
      reason: "allowlist",
    });
  });

  it("allowlist matches a workspace id", () => {
    const definition = def({
      enabled: false,
      allowlist: { workspaceIds: ["w1"] },
      planGate: { plans: ["business"] },
    });
    expect(evaluateFlag(definition, planCtx({ workspaceId: "w1", plan: "free" }))).toEqual({
      enabled: true,
      reason: "allowlist",
    });
    expect(evaluateFlag(definition, planCtx({ workspaceId: "w2", plan: "free" }))).toEqual({
      enabled: false,
      reason: "planGate",
    });
  });

  it("a plan gate admits only its plans", () => {
    const definition = def({ enabled: true, planGate: { plans: ["business", "enterprise"] }, rolloutPercent: 0 });
    expect(evaluateFlag(definition, planCtx({ plan: "business" }))).toEqual({
      enabled: true,
      reason: "planGate",
    });
    expect(evaluateFlag(definition, planCtx({ plan: "free" }))).toEqual({
      enabled: false,
      reason: "planGate",
    });
  });

  it("a plan gate fails closed when the context has no plan", () => {
    expect(evaluateFlag(def({ enabled: true, planGate: { plans: ["business"] } }), planCtx({}))).toEqual({
      enabled: false,
      reason: "planGate",
    });
  });

  it("planGate beats rollout and global", () => {
    const definition = def({ enabled: true, planGate: { plans: ["business"] }, rolloutPercent: 100 });
    expect(evaluateFlag(definition, planCtx({ plan: "free" })).enabled).toBe(false);
    expect(evaluateFlag(definition, planCtx({ plan: "business" })).enabled).toBe(true);
  });

  it("rollout beats the global baseline", () => {
    expect(evaluateFlag(def({ enabled: true, rolloutPercent: 0 }), planCtx({ userId: "u1" }))).toEqual({
      enabled: false,
      reason: "rollout",
    });
    expect(evaluateFlag(def({ enabled: false, rolloutPercent: 100 }), planCtx({ userId: "u1" }))).toEqual({
      enabled: true,
      reason: "rollout",
    });
  });

  it("an empty allowlist never matches", () => {
    expect(
      evaluateFlag(def({ enabled: true, allowlist: { userIds: [] } }), planCtx({ userId: "u1", plan: "free" })),
    ).toEqual({ enabled: true, reason: "global" });
  });
});

describe("evaluateFlag - rollout edges and determinism", () => {
  it("0% turns every user off and 100% turns every user on", () => {
    for (const userId of ["user-1", "user-2", "user-3", "alpha", ""]) {
      expect(evaluateFlag(def({ enabled: true, rolloutPercent: 0 }), planCtx({ userId }))).toEqual({
        enabled: false,
        reason: "rollout",
      });
      expect(evaluateFlag(def({ enabled: false, rolloutPercent: 100 }), planCtx({ userId }))).toEqual({
        enabled: true,
        reason: "rollout",
      });
    }
  });

  it("includes a user exactly when their bucket is below the percentage", () => {
    expect(bucketOf("user-1", "beta")).toBe(28);
    expect(evaluateFlag(def({ key: "beta", rolloutPercent: 28 }), planCtx({ userId: "user-1" })).enabled).toBe(false);
    expect(evaluateFlag(def({ key: "beta", rolloutPercent: 29 }), planCtx({ userId: "user-1" })).enabled).toBe(true);
  });

  it("is stable across repeated calls", () => {
    const definition = def({ key: "beta", enabled: false, rolloutPercent: 50 });
    const first = evaluateFlag(definition, planCtx({ userId: "user-3" }));
    for (let i = 0; i < 5; i += 1) {
      expect(evaluateFlag(definition, planCtx({ userId: "user-3" }))).toEqual(first);
    }
  });

  it("keys the rollout so the same user can differ per flag", () => {
    expect(evaluateFlag(def({ key: "beta", rolloutPercent: 82 }), planCtx({ userId: "u1" })).enabled).toBe(false);
    expect(evaluateFlag(def({ key: "other", rolloutPercent: 82 }), planCtx({ userId: "u1" })).enabled).toBe(true);
  });

  it("fails closed on an unknown definition", () => {
    expect(evaluateFlag(undefined, planCtx({ plan: "free" }))).toEqual({ enabled: false, reason: "invalid" });
    expect(evaluateFlag(null, planCtx({ plan: "free" }))).toEqual({ enabled: false, reason: "invalid" });
    expect(evaluateFlag("nope", planCtx({ plan: "free" }))).toEqual({ enabled: false, reason: "invalid" });
  });
});

describe("evaluateFlag - the legacy targeting surface is unchanged", () => {
  it("keeps the shipped engine's decisions intact", () => {
    expect(evaluateFlag(flag({ enabled: true }), ctx("u1"))).toEqual({ enabled: true, reason: "enabled" });
    expect(evaluateFlag(flag({ enabled: false }), ctx("u1"))).toEqual({ enabled: false, reason: "disabled" });
    expect(evaluateFlag(flag({ rollout: 100 }), ctx("u1"))).toEqual({ enabled: true, reason: "rollout" });
    expect(evaluateFlag(flag({ allowlist: ["u1"] }), ctx("u1"))).toEqual({ enabled: true, reason: "allowlist" });
    expect(evaluateFlag(flag({ denylist: ["u1"], enabled: true }), ctx("u1"))).toEqual({
      enabled: false,
      reason: "denylist",
    });
  });
});
