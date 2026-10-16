import { describe, expect, it } from "vitest";
import {
  AUTOMATION_EVENT_KINDS,
  AUTOMATION_FILTER_OPS,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_DEPTH,
  MAX_AUTOMATION_FILTERS,
  isValidAutomation,
  matchesFilter,
  matchesTrigger,
  planAutomation,
  validateAutomation,
  type AutomationEvent,
  type AutomationRule,
} from "@/lib/automations";
import type { ButtonAction } from "@/lib/row-buttons";

/*
 * Automation engine (pure) — docs/specs/automations.md (R27.1, R27.5-R27.6,
 * R27.11, R27.17). These tests pin the canonical-event vocabulary, the trigger
 * filter DSL, the validator and the side-effect-free action plan, including the
 * depth/visited loop guard. `src/lib/row-buttons.ts` owns the actions; this
 * module only decides when they run and what the plan looks like.
 */

const row = { id: "row_1", title: "Fix login", values: { status: "Todo", estimate: 3 } };

const notifyRule: AutomationRule = {
  id: "rule_ping",
  name: "Ping owner",
  trigger: { event: "ticket.status_changed" },
  actions: [{ kind: "notify", message: "{{title}} changed" }],
};

const event = (over: Partial<AutomationEvent> = {}): AutomationEvent => ({
  kind: "ticket.status_changed",
  ticketId: "t_1",
  fields: { status: "Blocked" },
  previous: { status: "Todo" },
  ...over,
});

describe("automation vocabulary", () => {
  it("lists the five canonical events", () => {
    expect(AUTOMATION_EVENT_KINDS).toEqual([
      "ticket.status_changed",
      "ticket.label_added",
      "ticket.label_removed",
      "ticket.assigned",
      "schedule",
    ]);
  });

  it("lists the six filter operators", () => {
    expect(AUTOMATION_FILTER_OPS).toEqual([
      "eq",
      "neq",
      "in",
      "exists",
      "changed_to",
      "changed_from",
    ]);
  });

  it("exposes bounded action, filter and depth limits", () => {
    expect(MAX_AUTOMATION_ACTIONS).toBe(5);
    expect(MAX_AUTOMATION_FILTERS).toBe(8);
    expect(MAX_AUTOMATION_DEPTH).toBe(2);
  });
});

describe("validateAutomation", () => {
  it("accepts a well-formed rule of every event kind", () => {
    for (const kind of AUTOMATION_EVENT_KINDS) {
      const rule = { ...notifyRule, trigger: { event: kind } };
      expect(validateAutomation(rule)).toEqual([]);
      expect(isValidAutomation(rule)).toBe(true);
    }
  });

  it("accepts every action kind row-buttons supports", () => {
    const actions: ButtonAction[] = [
      { kind: "open_url", url: "https://example.com" },
      { kind: "set_property", propertyId: "status", value: "Done" },
      { kind: "insert_template", templateId: "tpl_1" },
      { kind: "notify", message: "hi" },
    ];
    expect(validateAutomation({ ...notifyRule, actions })).toEqual([]);
  });

  it("flags a non-object rule", () => {
    const issues = validateAutomation(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("not_an_object");
  });

  it("flags a missing id, missing trigger and unknown event", () => {
    expect(validateAutomation({ ...notifyRule, id: " " }).map((i) => i.path)).toContain("id");
    expect(validateAutomation({ id: "r", actions: [] }).map((i) => i.path)).toContain("trigger");
    const unknown = validateAutomation({ ...notifyRule, trigger: { event: "ticket.exploded" } });
    expect(unknown.some((i) => i.code === "unknown_event")).toBe(true);
  });

  it("accepts a valid filter and flags an unknown operator", () => {
    const ok = {
      ...notifyRule,
      trigger: {
        event: "ticket.status_changed" as const,
        filters: [{ field: "status", op: "changed_to" as const, value: "Blocked" }],
      },
    };
    expect(validateAutomation(ok)).toEqual([]);
    const bad = validateAutomation({
      ...notifyRule,
      trigger: { event: "ticket.status_changed", filters: [{ field: "status", op: "regex", value: "x" }] },
    });
    expect(bad.some((i) => i.path === "trigger.filters.0.op")).toBe(true);
  });

  it("requires an array when filters are present and caps the count", () => {
    expect(
      validateAutomation({ ...notifyRule, trigger: { event: "schedule", filters: "x" } }).some(
        (i) => i.path === "trigger.filters",
      ),
    ).toBe(true);
    const many = Array.from({ length: MAX_AUTOMATION_FILTERS + 1 }, (_, i) => ({
      field: `f${i}`,
      op: "exists" as const,
    }));
    expect(
      validateAutomation({ ...notifyRule, trigger: { event: "schedule", filters: many } }).some(
        (i) => i.code === "too_many_filters",
      ),
    ).toBe(true);
  });

  it("requires `values` for `in` and a `value` for equality filters", () => {
    const inIssues = validateAutomation({
      ...notifyRule,
      trigger: { event: "schedule", filters: [{ field: "labelIds", op: "in" }] },
    });
    expect(inIssues.some((i) => i.path === "trigger.filters.0.values")).toBe(true);
    const eqIssues = validateAutomation({
      ...notifyRule,
      trigger: { event: "schedule", filters: [{ field: "status", op: "eq" }] },
    });
    expect(eqIssues.some((i) => i.path === "trigger.filters.0.value")).toBe(true);
  });

  it("requires at least one action and caps the count", () => {
    expect(validateAutomation({ ...notifyRule, actions: [] }).some((i) => i.code === "no_actions")).toBe(
      true,
    );
    expect(validateAutomation({ ...notifyRule, actions: "nope" }).some((i) => i.path === "actions")).toBe(
      true,
    );
    const many = Array.from({ length: MAX_AUTOMATION_ACTIONS + 1 }, () => ({
      kind: "notify" as const,
      message: "x",
    }));
    expect(
      validateAutomation({ ...notifyRule, actions: many }).some((i) => i.code === "too_many_actions"),
    ).toBe(true);
  });

  it("re-paths an invalid action onto its index", () => {
    const issues = validateAutomation({
      ...notifyRule,
      actions: [{ kind: "open_url" }, { kind: "notify", message: "ok" }],
    });
    expect(issues.some((i) => i.path === "actions.0.action.url")).toBe(true);
    expect(issues.some((i) => i.code === "invalid_action")).toBe(true);
  });

  it("flags wrongly typed optional fields", () => {
    expect(validateAutomation({ ...notifyRule, name: 7 }).map((i) => i.path)).toContain("name");
    expect(validateAutomation({ ...notifyRule, enabled: "yes" }).map((i) => i.path)).toContain(
      "enabled",
    );
    expect(validateAutomation({ ...notifyRule, workspaceId: 9 }).map((i) => i.path)).toContain(
      "workspaceId",
    );
  });
});

describe("matchesTrigger", () => {
  it("matches on the canonical event kind", () => {
    expect(matchesTrigger(notifyRule, event())).toBe(true);
    expect(matchesTrigger(notifyRule, event({ kind: "ticket.assigned" }))).toBe(false);
  });

  it("ignores raw activity kinds it does not recognize", () => {
    expect(matchesTrigger(notifyRule, { kind: "status_changed" })).toBe(false);
    expect(matchesTrigger(notifyRule, { kind: "updated" })).toBe(false);
  });

  it("treats a rule with no filters as matching every event of its kind", () => {
    expect(matchesTrigger(notifyRule, event({ fields: undefined, previous: undefined }))).toBe(true);
  });

  it("requires every filter to pass", () => {
    const rule: AutomationRule = {
      ...notifyRule,
      trigger: {
        event: "ticket.status_changed",
        filters: [{ field: "status", op: "changed_to", value: "Blocked" }],
      },
    };
    expect(matchesTrigger(rule, event())).toBe(true);
    expect(matchesTrigger(rule, event({ fields: { status: "Done" } }))).toBe(false);
  });

  it("is false for malformed rules and events", () => {
    expect(matchesTrigger(null, event())).toBe(false);
    expect(matchesTrigger(notifyRule, null)).toBe(false);
    expect(matchesTrigger({ id: "r" }, event())).toBe(false);
    expect(matchesTrigger(notifyRule, {})).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("supports eq, neq, in and exists", () => {
    expect(matchesFilter({ field: "status", op: "eq", value: "Blocked" }, event())).toBe(true);
    expect(matchesFilter({ field: "status", op: "eq", value: "Done" }, event())).toBe(false);
    expect(matchesFilter({ field: "status", op: "neq", value: "Done" }, event())).toBe(true);
    expect(
      matchesFilter(
        { field: "labelIds", op: "in", values: ["l1", "l2"] },
        { fields: { labelIds: ["l9", "l2"] } },
      ),
    ).toBe(true);
    expect(
      matchesFilter({ field: "labelIds", op: "in", values: ["l1"] }, { fields: { labelIds: ["l9"] } }),
    ).toBe(false);
    expect(matchesFilter({ field: "status", op: "exists" }, event())).toBe(true);
    expect(matchesFilter({ field: "missing", op: "exists" }, event())).toBe(false);
  });

  it("compares only when the field actually changed", () => {
    const changed = { fields: { status: "Blocked" }, previous: { status: "Todo" } };
    expect(matchesFilter({ field: "status", op: "changed_to", value: "Blocked" }, changed)).toBe(true);
    expect(matchesFilter({ field: "status", op: "changed_from", value: "Todo" }, changed)).toBe(true);
    expect(matchesFilter({ field: "status", op: "changed_to", value: "Todo" }, changed)).toBe(false);
    const unchanged = { fields: { status: "Blocked" }, previous: { status: "Blocked" } };
    expect(matchesFilter({ field: "status", op: "changed_to", value: "Blocked" }, unchanged)).toBe(
      false,
    );
  });

  it("fails closed on an unknown operator or malformed filter", () => {
    expect(matchesFilter({ field: "status", op: "regex", value: ".*" }, event())).toBe(false);
    expect(matchesFilter({ field: "", op: "exists" }, event())).toBe(false);
    expect(matchesFilter("nope", event())).toBe(false);
  });
});

describe("planAutomation", () => {
  it("resolves each action into an ordered, side-effect-free step", () => {
    const rule: AutomationRule = {
      ...notifyRule,
      actions: [
        { kind: "notify", message: "{{title}} changed" },
        { kind: "set_property", propertyId: "status", value: "Done" },
      ],
    };
    const plan = planAutomation(rule, { row });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.runnable).toBe(true);
    expect(plan.event).toBe("ticket.status_changed");
    expect(plan.steps.map((s) => s.index)).toEqual([0, 1]);
    const first = plan.steps[0].plan;
    expect(first.kind).toBe("notify");
    if (first.kind === "notify") expect(first.message).toBe("Fix login changed");
    const second = plan.steps[1].plan;
    expect(second.kind).toBe("set_property");
    if (second.kind === "set_property") {
      expect(second.rowId).toBe("row_1");
      expect(second.propertyId).toBe("status");
    }
  });

  it("interpolates a URL action against the row scope", () => {
    const plan = planAutomation(
      { ...notifyRule, actions: [{ kind: "open_url", url: "https://example.com/{{id}}" }] },
      { row },
    );
    if (plan.status === "planned" && plan.steps[0].plan.kind === "open_url") {
      expect(plan.steps[0].plan.href).toBe("https://example.com/row_1");
    } else {
      throw new Error("expected a planned open_url step");
    }
  });

  it("returns an invalid plan carrying every issue, never throwing", () => {
    const plan = planAutomation({ id: "rule_x", trigger: { event: "nope" }, actions: [] }, { row });
    expect(plan.status).toBe("invalid");
    expect(plan.runnable).toBe(false);
    if (plan.status === "invalid") {
      expect(plan.issues.length).toBeGreaterThan(0);
      expect(plan.steps).toEqual([]);
    }
  });

  it("skips a disabled rule", () => {
    const plan = planAutomation({ ...notifyRule, enabled: false }, { row });
    expect(plan.status).toBe("skipped");
    if (plan.status === "skipped") expect(plan.reason).toBe("disabled");
  });

  it("skips a rule already visited in the chain", () => {
    const plan = planAutomation(notifyRule, { row, visited: ["rule_ping"] });
    expect(plan.status).toBe("skipped");
    if (plan.status === "skipped") expect(plan.reason).toBe("visited");
  });

  it("stops the chain at max depth (default and override)", () => {
    const atLimit = planAutomation(notifyRule, { row, depth: MAX_AUTOMATION_DEPTH });
    expect(atLimit.status).toBe("skipped");
    if (atLimit.status === "skipped") expect(atLimit.reason).toBe("max_depth");

    const within = planAutomation(notifyRule, { row, depth: MAX_AUTOMATION_DEPTH - 1 });
    expect(within.status).toBe("planned");
    expect(within.depth).toBe(1);

    const override = planAutomation(notifyRule, { row, depth: 1, maxDepth: 3 });
    expect(override.status).toBe("planned");
  });

  it("threads depth and visited so a caller can chain safely", () => {
    const first = planAutomation(notifyRule, { row });
    expect(first.visited).toEqual(["rule_ping"]);
    const looped = planAutomation(notifyRule, {
      row,
      visited: first.visited,
      depth: first.depth + 1,
    });
    expect(looped.status).toBe("skipped");
    if (looped.status === "skipped") expect(looped.reason).toBe("visited");
  });

  it("never mutates the caller's visited set and is deterministic", () => {
    const visited = ["other_rule"];
    const plan = planAutomation(notifyRule, { row, visited });
    expect(visited).toEqual(["other_rule"]);
    expect(plan.visited).toEqual(["other_rule", "rule_ping"]);
    expect(planAutomation(notifyRule, { row })).toEqual(planAutomation(notifyRule, { row }));
  });

  it("rejects a rule whose actions are empty before it ever runs", () => {
    const plan = planAutomation({ ...notifyRule, actions: [] }, { row });
    expect(plan.status).toBe("invalid");
  });
});
