import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  CONDITION_OPS,
  DEFAULT_MAX_DEPTH,
  MAX_ACTIONS,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  TRIGGER_TYPES,
  describeAutomation,
  evaluateConditions,
  isValidAutomation,
  matchesTrigger,
  parseAutomation,
  runAutomation,
  validateAutomation,
  type Action,
  type AutomationEvent,
  type AutomationRow,
  type AutomationRule,
  type Conditions,
} from "@/lib/automation-engine";

/*
 * Automation rule engine (pure) — docs/specs/automations.md (§13 Automation
 * engine / Database automations / Button actions / Zapier connectors-via-
 * webhooks and §20 Automations). Red-first unit coverage for the parser, the
 * validator (unknown trigger/action, empty actions, self-referential setProp),
 * trigger matching, the AND/OR condition DSL, the pure action planner with its
 * cycle/recursion guard, and the human describer.
 */

const row: AutomationRow = {
  id: "row_1",
  values: { status: "Todo", priority: "Low", labels: ["l1", "l2"], estimate: 3 },
};

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "rule_1",
    trigger: { type: "row.created" },
    actions: [{ type: "setProp", propertyId: "status", value: "Done" }],
    ...over,
  };
}

function event(over: Partial<AutomationEvent> = {}): AutomationEvent {
  return { type: "row.created", rowId: "row_1", ...over };
}

describe("automation-engine vocabulary", () => {
  it("lists the four trigger types", () => {
    expect(TRIGGER_TYPES).toEqual(["row.created", "row.updated", "prop.changed", "schedule"]);
  });

  it("lists the four action types", () => {
    expect(ACTION_TYPES).toEqual(["setProp", "notify", "createRow", "webhook"]);
  });

  it("lists the condition operators", () => {
    expect(CONDITION_OPS).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
      "contains",
      "startsWith",
      "endsWith",
      "exists",
      "notExists",
      "isEmpty",
      "notEmpty",
    ]);
  });

  it("exposes the bounded limits", () => {
    expect(MAX_ACTIONS).toBe(5);
    expect(MAX_CONDITION_DEPTH).toBe(3);
    expect(MAX_CONDITION_LEAVES).toBe(8);
    expect(DEFAULT_MAX_DEPTH).toBe(2);
  });
});

describe("validateAutomation", () => {
  it("accepts a well-formed rule of every trigger type", () => {
    expect(validateAutomation(rule())).toEqual([]);
    expect(validateAutomation(rule({ trigger: { type: "row.updated" } }))).toEqual([]);
    expect(
      validateAutomation(rule({ trigger: { type: "prop.changed", propertyId: "priority" } })),
    ).toEqual([]);
    expect(validateAutomation(rule({ trigger: { type: "schedule", cron: "0 9 * * 1" } }))).toEqual(
      [],
    );
    expect(isValidAutomation(rule())).toBe(true);
  });

  it("accepts every action type", () => {
    const actions: Action[] = [
      { type: "setProp", propertyId: "priority", value: "High" },
      { type: "notify", message: "hello", level: "warning", targets: ["u1"] },
      { type: "createRow", values: { status: "Todo" }, title: "Follow up" },
      { type: "webhook", url: "https://example.com/hook", method: "POST", body: { a: 1 } },
    ];
    expect(validateAutomation(rule({ actions }))).toEqual([]);
  });

  it("flags a non-object rule", () => {
    const issues = validateAutomation(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("not_an_object");
  });

  it("flags a missing id and a missing trigger", () => {
    expect(validateAutomation({ trigger: { type: "row.created" }, actions: [] }).map((i) => i.path))
      .toContain("id");
    expect(validateAutomation({ id: "r", actions: [] }).map((i) => i.path)).toContain("trigger");
  });

  it("flags an unknown trigger type", () => {
    const issues = validateAutomation(rule({ trigger: { type: "cron.whatever" } as never }));
    expect(issues.some((i) => i.code === "unknown_trigger" && i.path === "trigger.type")).toBe(true);
  });

  it("flags an invalid cron on a schedule trigger", () => {
    const issues = validateAutomation(rule({ trigger: { type: "schedule", cron: "not cron" } }));
    expect(issues.some((i) => i.code === "invalid_cron" && i.path === "trigger.cron")).toBe(true);
  });

  it("allows a schedule trigger without a cron", () => {
    expect(validateAutomation(rule({ trigger: { type: "schedule" } }))).toEqual([]);
  });

  it("flags an unknown action type", () => {
    const issues = validateAutomation(
      rule({ actions: [{ type: "deleteRow" } as never] }),
    );
    expect(issues.some((i) => i.code === "unknown_action" && i.path === "actions.0.type")).toBe(true);
  });

  it("requires at least one action and caps the count", () => {
    expect(validateAutomation(rule({ actions: [] })).some((i) => i.code === "no_actions")).toBe(true);
    const many: Action[] = Array.from({ length: MAX_ACTIONS + 1 }, () => ({
      type: "notify",
      message: "x",
    }));
    expect(validateAutomation(rule({ actions: many })).some((i) => i.code === "too_many_actions")).toBe(
      true,
    );
  });

  it("flags a self-referential setProp on the triggering property", () => {
    const issues = validateAutomation(
      rule({
        trigger: { type: "prop.changed", propertyId: "status" },
        actions: [{ type: "setProp", propertyId: "status", value: "Done" }],
      }),
    );
    expect(issues.some((i) => i.code === "self_reference")).toBe(true);
    expect(issues.some((i) => i.path === "actions.0.propertyId")).toBe(true);
  });

  it("allows setProp on a different property than the triggered one", () => {
    expect(
      validateAutomation(
        rule({
          trigger: { type: "prop.changed", propertyId: "status" },
          actions: [{ type: "setProp", propertyId: "priority", value: "High" }],
        }),
      ),
    ).toEqual([]);
  });

  it("requires propertyId and value on a setProp action", () => {
    const issues = validateAutomation(rule({ actions: [{ type: "setProp" } as never] }));
    expect(issues.some((i) => i.path === "actions.0.propertyId")).toBe(true);
    expect(issues.some((i) => i.path === "actions.0.value")).toBe(true);
  });

  it("requires a message on notify and a url on webhook", () => {
    expect(validateAutomation(rule({ actions: [{ type: "notify" } as never] })).some((i) => i.path === "actions.0.message")).toBe(
      true,
    );
    expect(validateAutomation(rule({ actions: [{ type: "webhook" } as never] })).some((i) => i.path === "actions.0.url")).toBe(
      true,
    );
  });

  it("flags an unknown condition operator", () => {
    const issues = validateAutomation(
      rule({ conditions: { propertyId: "status", op: "regex" } as never }),
    );
    expect(issues.some((i) => i.code === "invalid_condition" && i.path === "conditions.op")).toBe(true);
  });

  it("requires a value for value-taking condition operators", () => {
    const issues = validateAutomation(
      rule({ conditions: { propertyId: "status", op: "eq" } as never }),
    );
    expect(issues.some((i) => i.path === "conditions.value")).toBe(true);
  });

  it("flags a condition tree that nests past the depth cap", () => {
    const deep = {
      all: [{ any: [{ all: [{ any: [{ propertyId: "status", op: "eq", value: "x" }] }] }] }],
    } as unknown as Conditions;
    const issues = validateAutomation(rule({ conditions: deep }));
    expect(issues.some((i) => i.code === "too_deep")).toBe(true);
  });

  it("accepts nesting within the depth cap", () => {
    const nested = {
      all: [{ any: [{ propertyId: "status", op: "eq", value: "Todo" }] }],
    } as Conditions;
    expect(validateAutomation(rule({ conditions: nested }))).toEqual([]);
  });

  it("flags too many condition leaves", () => {
    const many = {
      all: Array.from({ length: MAX_CONDITION_LEAVES + 1 }, (_, i) => ({
        propertyId: `p${i}`,
        op: "exists" as const,
      })),
    };
    const issues = validateAutomation(rule({ conditions: many }));
    expect(issues.some((i) => i.code === "too_many_leaves")).toBe(true);
  });

  it("flags a condition group that declares no branch", () => {
    const issues = validateAutomation(rule({ conditions: {} as Conditions }));
    expect(issues.some((i) => i.code === "invalid_condition")).toBe(true);
  });
});

describe("parseAutomation", () => {
  it("parses a valid rule and applies defaults", () => {
    const parsed = parseAutomation({
      id: "r1",
      trigger: { type: "row.created" },
      actions: [{ type: "notify", message: "hi" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.issues).toEqual([]);
    expect(parsed.rule.enabled).toBe(true);
    expect(parsed.rule.conditions).toBeNull();
    expect(parsed.rule.id).toBe("r1");
  });

  it("preserves an explicit enabled:false and conditions", () => {
    const parsed = parseAutomation({
      id: "r1",
      enabled: false,
      trigger: { type: "row.updated" },
      conditions: { propertyId: "status", op: "eq", value: "Done" },
      actions: [{ type: "notify", message: "hi" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rule.enabled).toBe(false);
    expect(parsed.rule.conditions).toEqual({ propertyId: "status", op: "eq", value: "Done" });
  });

  it("returns a null rule plus issues for an invalid input", () => {
    const parsed = parseAutomation({ id: "r1", trigger: { type: "nope" }, actions: [] });
    expect(parsed.ok).toBe(false);
    expect(parsed.rule).toBeNull();
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("never throws on hostile input", () => {
    expect(() => parseAutomation(undefined)).not.toThrow();
    expect(() => parseAutomation("nope")).not.toThrow();
    expect(parseAutomation(42).ok).toBe(false);
  });
});

describe("matchesTrigger", () => {
  it("matches on the canonical trigger type", () => {
    expect(matchesTrigger(rule(), event())).toBe(true);
    expect(matchesTrigger(rule(), event({ type: "row.updated" }))).toBe(false);
  });

  it("matches prop.changed only for the configured property", () => {
    const r = rule({ trigger: { type: "prop.changed", propertyId: "status" } });
    expect(matchesTrigger(r, event({ type: "prop.changed", propertyId: "status", from: "a", to: "b" }))).toBe(true);
    expect(matchesTrigger(r, event({ type: "prop.changed", propertyId: "priority", from: "a", to: "b" }))).toBe(false);
  });

  it("returns false for a prop.changed event that did not actually change", () => {
    const r = rule({ trigger: { type: "prop.changed", propertyId: "status" } });
    expect(matchesTrigger(r, event({ type: "prop.changed", propertyId: "status", from: "x", to: "x" }))).toBe(false);
    expect(matchesTrigger(r, event({ type: "prop.changed", propertyId: "status" }))).toBe(false);
  });

  it("matches a schedule event against a cron expression (UTC)", () => {
    const r = rule({ trigger: { type: "schedule", cron: "0 9 * * 1" } });
    const monday = new Date(Date.UTC(2026, 0, 5, 9, 0)); // 2026-01-05 is a Monday
    expect(matchesTrigger(r, event({ type: "schedule", at: monday }))).toBe(true);
    expect(matchesTrigger(r, event({ type: "schedule", at: new Date(Date.UTC(2026, 0, 6, 9, 0)) }))).toBe(false);
  });

  it("matches any schedule when no cron is configured", () => {
    const r = rule({ trigger: { type: "schedule" } });
    expect(matchesTrigger(r, event({ type: "schedule" }))).toBe(true);
  });

  it("fails closed for malformed rules and events", () => {
    expect(matchesTrigger(null, event())).toBe(false);
    expect(matchesTrigger(rule(), null)).toBe(false);
    expect(matchesTrigger(rule(), { type: "bogus" })).toBe(false);
    expect(matchesTrigger({ id: "r" }, event())).toBe(false);
  });
});

describe("evaluateConditions", () => {
  it("treats absent conditions as always-true", () => {
    expect(evaluateConditions(null, row)).toBe(true);
    expect(evaluateConditions(undefined, row)).toBe(true);
  });

  it("evaluates a leaf equality", () => {
    expect(evaluateConditions({ propertyId: "status", op: "eq", value: "Todo" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "status", op: "eq", value: "Done" }, row)).toBe(false);
    expect(evaluateConditions({ propertyId: "status", op: "neq", value: "Done" }, row)).toBe(true);
  });

  it("evaluates in and notIn", () => {
    expect(evaluateConditions({ propertyId: "status", op: "in", value: ["Todo", "Doing"] }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "status", op: "in", value: ["Done"] }, row)).toBe(false);
    expect(evaluateConditions({ propertyId: "status", op: "notIn", value: ["Done"] }, row)).toBe(true);
  });

  it("evaluates numeric comparisons", () => {
    expect(evaluateConditions({ propertyId: "estimate", op: "gt", value: 2 }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "estimate", op: "gte", value: 3 }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "estimate", op: "lt", value: 3 }, row)).toBe(false);
  });

  it("evaluates string operators and array membership", () => {
    expect(evaluateConditions({ propertyId: "status", op: "startsWith", value: "To" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "status", op: "endsWith", value: "do" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "labels", op: "contains", value: "l2" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "status", op: "contains", value: "zzz" }, row)).toBe(false);
  });

  it("evaluates existence and emptiness", () => {
    expect(evaluateConditions({ propertyId: "status", op: "exists" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "missing", op: "notExists" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "missing", op: "isEmpty" }, row)).toBe(true);
    expect(evaluateConditions({ propertyId: "status", op: "notEmpty" }, row)).toBe(true);
  });

  it("evaluates a nested all group", () => {
    const conditions: Conditions = {
      all: [
        { propertyId: "status", op: "eq", value: "Todo" },
        { propertyId: "priority", op: "eq", value: "Low" },
      ],
    };
    expect(evaluateConditions(conditions, row)).toBe(true);
    expect(
      evaluateConditions(
        {
          all: [
            { propertyId: "status", op: "eq", value: "Todo" },
            { propertyId: "priority", op: "eq", value: "High" },
          ],
        },
        row,
      ),
    ).toBe(false);
  });

  it("evaluates a nested any group", () => {
    const conditions: Conditions = {
      any: [
        { propertyId: "status", op: "eq", value: "Done" },
        { propertyId: "priority", op: "eq", value: "Low" },
      ],
    };
    expect(evaluateConditions(conditions, row)).toBe(true);
    expect(
      evaluateConditions({ any: [{ propertyId: "status", op: "eq", value: "Done" }] }, row),
    ).toBe(false);
  });

  it("evaluates a none group", () => {
    expect(
      evaluateConditions({ none: [{ propertyId: "status", op: "eq", value: "Done" }] }, row),
    ).toBe(true);
    expect(
      evaluateConditions({ none: [{ propertyId: "status", op: "eq", value: "Todo" }] }, row),
    ).toBe(false);
  });

  it("evaluates a mixed nested AND/OR tree", () => {
    const conditions: Conditions = {
      all: [
        { any: [{ propertyId: "status", op: "eq", value: "Todo" }, { propertyId: "status", op: "eq", value: "Done" }] },
        { none: [{ propertyId: "priority", op: "eq", value: "High" }] },
      ],
    };
    expect(evaluateConditions(conditions, row)).toBe(true);
    const failing: Conditions = {
      all: [
        { any: [{ propertyId: "status", op: "eq", value: "Blocked" }] },
        { none: [{ propertyId: "priority", op: "eq", value: "Low" }] },
      ],
    };
    expect(evaluateConditions(failing, row)).toBe(false);
  });

  it("treats an empty all as true and an empty any as false", () => {
    expect(evaluateConditions({ all: [] }, row)).toBe(true);
    expect(evaluateConditions({ any: [] }, row)).toBe(false);
  });

  it("treats an array of conditions as an implicit all", () => {
    expect(
      evaluateConditions(
        [
          { propertyId: "status", op: "eq", value: "Todo" },
          { propertyId: "priority", op: "eq", value: "Low" },
        ],
        row,
      ),
    ).toBe(true);
  });

  it("fails closed on unknown operators and malformed nodes", () => {
    expect(evaluateConditions({ propertyId: "status", op: "regex", value: ".*" } as never, row)).toBe(false);
    expect(evaluateConditions({} as Conditions, row)).toBe(false);
    expect(evaluateConditions({ propertyId: "", op: "eq", value: "x" }, row)).toBe(false);
  });

  it("is deterministic and does not mutate the row", () => {
    const before = JSON.stringify(row);
    const conditions: Conditions = { all: [{ propertyId: "status", op: "exists" }] };
    expect(evaluateConditions(conditions, row)).toBe(evaluateConditions(conditions, row));
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("runAutomation", () => {
  it("plans ordered effects for a matched rule", () => {
    const r = rule({
      actions: [
        { type: "setProp", propertyId: "priority", value: "High" },
        { type: "notify", message: "{{status}} updated", targets: ["u1"] },
      ],
    });
    const result = runAutomation(r, event(), { row });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.runnable).toBe(true);
    expect(result.effects.map((e) => e.type)).toEqual(["setProp", "notify"]);
    expect(result.visited).toEqual(["rule_1"]);
  });

  it("produces a setProp effect carrying the row id", () => {
    const result = runAutomation(rule(), event(), { row });
    if (result.status !== "planned") throw new Error("expected planned");
    const effect = result.effects[0];
    expect(effect.type).toBe("setProp");
    if (effect.type === "setProp") {
      expect(effect.propertyId).toBe("status");
      expect(effect.value).toBe("Done");
      expect(effect.rowId).toBe("row_1");
    }
  });

  it("interpolates notify messages from the row and variables", () => {
    const result = runAutomation(
      rule({ actions: [{ type: "notify", message: "{{status}} / {{name}}", targets: ["u1", "u2"] }] }),
      event(),
      { row, variables: { name: "Ada" } },
    );
    if (result.status !== "planned") throw new Error("expected planned");
    const effect = result.effects[0];
    if (effect.type === "notify") {
      expect(effect.message).toBe("Todo / Ada");
      expect(effect.targets).toEqual(["u1", "u2"]);
    }
  });

  it("does not let the user data change the prototype of the scope", () => {
    // `Object.assign` sets the `__proto__` key of its source — with a
    // `__proto__` in the data the scope would inherit the injected members,
    // and a template would resolve a key that was never there.
    const result = runAutomation(
      rule({ actions: [{ type: "notify", message: "{{injected}}", targets: ["u1"] }] }),
      event(),
      { row, variables: JSON.parse('{"__proto__": {"injected": "yes"}}') as Record<string, string> },
    );
    if (result.status !== "planned") throw new Error("expected planned");
    const effect = result.effects[0];
    if (effect.type === "notify") {
      // The placeholder stays a placeholder: the scope has no prototype the
      // injected members could hang on.
      expect(effect.message).toBe("{{injected}}");
    }
  });

  it("planes createRow and webhook effects with defaults", () => {
    const result = runAutomation(
      rule({
        actions: [
          { type: "createRow", title: "{{status}} follow-up", values: { priority: "High" } },
          { type: "webhook", url: "https://example.com/hook" },
        ],
      }),
      event(),
      { row },
    );
    if (result.status !== "planned") throw new Error("expected planned");
    const created = result.effects[0];
    if (created.type === "createRow") {
      expect(created.values).toEqual({ priority: "High", title: "Todo follow-up" });
    }
    const hook = result.effects[1];
    if (hook.type === "webhook") {
      expect(hook.url).toBe("https://example.com/hook");
      expect(hook.method).toBe("POST");
    }
  });

  it("skips when the trigger does not match", () => {
    const result = runAutomation(rule(), event({ type: "row.updated" }), { row });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("trigger");
  });

  it("skips when conditions fail", () => {
    const r = rule({ conditions: { propertyId: "status", op: "eq", value: "Blocked" } });
    const result = runAutomation(r, event(), { row });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("conditions");
  });

  it("skips a disabled rule", () => {
    const result = runAutomation(rule({ enabled: false }), event(), { row });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("disabled");
  });

  it("skips an invalid rule and never throws", () => {
    const result = runAutomation({ id: "r", trigger: { type: "nope" }, actions: [] }, event(), { row });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("invalid");
  });

  it("skips a rule already visited in the chain (cycle guard)", () => {
    const result = runAutomation(rule(), event(), { row, visited: ["rule_1"] });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("visited");
  });

  it("skips when the chain reaches its depth cap", () => {
    const atCap = runAutomation(rule(), event(), { row, depth: DEFAULT_MAX_DEPTH });
    expect(atCap.status).toBe("skipped");
    if (atCap.status === "skipped") expect(atCap.reason).toBe("max_depth");

    const within = runAutomation(rule(), event(), { row, depth: DEFAULT_MAX_DEPTH - 1 });
    expect(within.status).toBe("planned");

    const override = runAutomation(rule(), event(), { row, depth: 2, maxDepth: 5 });
    expect(override.status).toBe("planned");
  });

  it("threads depth and visited so a caller can chain safely", () => {
    const first = runAutomation(rule(), event(), { row });
    if (first.status !== "planned") throw new Error("expected planned");
    expect(first.visited).toEqual(["rule_1"]);
    const looped = runAutomation(rule(), event(), {
      row,
      visited: first.visited,
      depth: first.depth + 1,
    });
    expect(looped.status).toBe("skipped");
    if (looped.status === "skipped") expect(looped.reason).toBe("visited");
  });

  it("drops a setProp effect that would not change the row (no-op guard)", () => {
    const r = rule({ actions: [{ type: "setProp", propertyId: "status", value: "Todo" }] });
    const result = runAutomation(r, event(), { row });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("no_op");
  });

  it("keeps the runnable effects when only some are no-ops", () => {
    const r = rule({
      actions: [
        { type: "setProp", propertyId: "status", value: "Todo" },
        { type: "setProp", propertyId: "priority", value: "High" },
      ],
    });
    const result = runAutomation(r, event(), { row });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.effects).toHaveLength(1);
  });

  it("is pure: deterministic, non-mutating and side-effect free", () => {
    const visited = ["other"];
    const before = JSON.stringify({ row, visited });
    const a = runAutomation(rule(), event(), { row, visited });
    const b = runAutomation(rule(), event(), { row, visited });
    expect(a).toEqual(b);
    expect(JSON.stringify({ row, visited })).toBe(before);
    expect(visited).toEqual(["other"]);
  });
});

describe("describeAutomation", () => {
  it("describes a row-created rule and its actions", () => {
    const text = describeAutomation(rule());
    expect(text).toContain("created");
    expect(text).toContain("status");
    expect(text).toContain("Done");
  });

  it("describes a prop.changed rule with conditions", () => {
    const text = describeAutomation(
      rule({
        trigger: { type: "prop.changed", propertyId: "status" },
        conditions: { propertyId: "priority", op: "eq", value: "High" },
        actions: [{ type: "notify", message: "ping" }],
      }),
    );
    expect(text).toContain("status");
    expect(text).toContain("priority");
    expect(text).toContain("notify");
  });

  it("describes a schedule rule using the cron human summary", () => {
    const text = describeAutomation(
      rule({ trigger: { type: "schedule", cron: "0 9 * * 1" }, actions: [{ type: "createRow" }] }),
    );
    expect(text).toContain("Monday");
  });

  it("fails safe for an invalid rule", () => {
    const text = describeAutomation({ id: "r", trigger: { type: "nope" }, actions: [] });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(describeAutomation(rule())).toBe(describeAutomation(rule()));
  });
});
