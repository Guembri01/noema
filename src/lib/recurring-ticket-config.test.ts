import { describe, expect, it } from "vitest";
import {
  MAX_RECURRING_LABELS,
  readLabelIds,
  readRecurringAction,
  readRecurringRule,
  recurringScheduleSummary,
  ruleFromForm,
  serializeRecurringAction,
  serializeRecurringRule,
} from "./recurring-ticket-config";
import { parseRule } from "./recurring-tickets";

/**
 * The mapping layer between the pure recurrence engine and its two homes:
 * the `Automation` JSON columns and the tracker's create form. Pinned here so
 * a malformed stored rule/action fails closed and a form value can never emit
 * a rule `parseRule` would reject.
 */

describe("rule serialization", () => {
  it("round-trips a normalized rule through the JSON column", () => {
    const rule = parseRule({
      freq: "monthly",
      interval: 2,
      byMonthDay: [1, 15],
      count: 6,
      until: "2027-01-01T00:00:00.000Z",
      start: "2026-01-01T00:00:00.000Z",
    });
    const stored = serializeRecurringRule(rule);

    expect(stored).toEqual({
      freq: "monthly",
      interval: 2,
      byMonthDay: [1, 15],
      count: 6,
      until: "2027-01-01T00:00:00.000Z",
      start: "2026-01-01T00:00:00.000Z",
    });
    expect(readRecurringRule({ rule: stored })).toEqual(rule);
  });

  it("accepts a bare stored rule and rejects an invalid one", () => {
    expect(readRecurringRule({ freq: "daily" })).toEqual({ freq: "daily", interval: 1 });
    expect(() => readRecurringRule({ rule: { freq: "hourly" } })).toThrow(/freq/i);
    expect(() => readRecurringRule(null)).toThrow(/object/i);
  });
});

describe("action serialization", () => {
  it("round-trips a template and normalizes its label ids", () => {
    const action = serializeRecurringAction({
      templateId: "tmpl-1",
      title: "Weekly report",
      projectId: "p1",
      priority: "high",
      labels: ["l1", " l1 ", "l2"],
    });
    expect(action.template.labels).toEqual(["l1", "l2"]);
    expect(readRecurringAction(action)).toEqual(action);
  });

  it("fails closed on an unknown action kind or a malformed template", () => {
    expect(() => readRecurringAction({ kind: "notify", template: {} })).toThrow(/not valid/i);
    expect(() => readRecurringAction({ kind: "create_ticket" })).toThrow(/template/i);
    expect(() =>
      readRecurringAction({ kind: "create_ticket", template: { templateId: "t" } }),
    ).toThrow(/title/i);
    expect(() =>
      readRecurringAction({ kind: "create_ticket", template: { title: "No id" } }),
    ).toThrow(/id or title/i);
  });

  it("coerces labels to unique trimmed strings and caps the list", () => {
    expect(readLabelIds(["a", 2, " b ", "a", ""])).toEqual(["a", "b"]);
    expect(readLabelIds("not-an-array")).toEqual([]);
    expect(readLabelIds(Array.from({ length: MAX_RECURRING_LABELS + 5 }, (_, i) => `l${i}`)))
      .toHaveLength(MAX_RECURRING_LABELS);
  });
});

describe("ruleFromForm", () => {
  it("maps a daily cadence with an interval", () => {
    const result = ruleFromForm({ freq: "daily", interval: "3" });
    expect(result).toEqual({ ok: true, rule: { freq: "daily", interval: 3 } });
  });

  it("maps the weekly weekday and the monthly day", () => {
    expect(ruleFromForm({ freq: "weekly", interval: "1", weekday: "thu" })).toEqual({
      ok: true,
      rule: { freq: "weekly", interval: 1, byWeekday: ["thu"] },
    });
    expect(ruleFromForm({ freq: "monthly", monthDay: "15" })).toEqual({
      ok: true,
      rule: { freq: "monthly", interval: 1, byMonthDay: [15] },
    });
  });

  it("omits blank optional fields and never leaks a frequency-inappropriate one", () => {
    expect(ruleFromForm({ freq: "weekly", interval: "" })).toEqual({
      ok: true,
      rule: { freq: "weekly", interval: 1 },
    });
    // A weekday left in state after switching to daily must not be stored.
    expect(ruleFromForm({ freq: "daily", interval: "1", weekday: "mon" })).toEqual({
      ok: true,
      rule: { freq: "daily", interval: 1 },
    });
  });

  it("returns a friendly error instead of throwing for bad input", () => {
    const unknown = ruleFromForm({ freq: "hourly" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/freq/i);

    const interval = ruleFromForm({ freq: "daily", interval: "0" });
    expect(interval.ok).toBe(false);
    if (!interval.ok) expect(interval.error).toMatch(/interval/i);

    const weekday = ruleFromForm({ freq: "weekly", weekday: "funday" });
    expect(weekday.ok).toBe(false);
    if (!weekday.ok) expect(weekday.error).toMatch(/weekday/i);
  });
});

describe("recurringScheduleSummary", () => {
  it("renders the engine's one-line summary", () => {
    expect(
      recurringScheduleSummary(parseRule({ freq: "weekly", interval: 2, byWeekday: ["tue", "thu"] })),
    ).toBe("Every 2 weeks on Tue, Thu");
    expect(recurringScheduleSummary(parseRule({ freq: "daily" }))).toBe("Every day");
  });
});
