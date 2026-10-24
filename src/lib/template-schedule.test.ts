import { describe, expect, it } from "vitest";
import {
  advanceTemplateSchedule,
  describeTemplateSchedule,
  formatTemplateNextRun,
  isTemplateDue,
  isUniqueConstraintError,
  nextRunForSchedule,
  resolveTemplateActorId,
  resolveTemplateContent,
  resolveTemplateText,
  resolveTemplateValue,
  templateAnchorFromConfig,
  templateOccurrenceKey,
  templatePropertyDefaults,
  templateScheduleAnchor,
  templateVariableContext,
  validateTemplateScheduleInput,
} from "./template-schedule";

/**
 * R31.20-R31.23 — schedule validation, anchor pinning, catch-up, pause and the
 * durable occurrence key. Pure: no clock, no database.
 */

describe("validateTemplateScheduleInput (R31.20)", () => {
  it("clears the schedule for null/off", () => {
    expect(validateTemplateScheduleInput({ recurrence: null })).toEqual({
      ok: true,
      recurrence: null,
      hour: null,
      minute: null,
    });
    expect(validateTemplateScheduleInput({ recurrence: "off", hour: 9 })).toEqual({
      ok: true,
      recurrence: null,
      hour: null,
      minute: null,
    });
  });

  it("accepts a cadence with a pinned wall clock", () => {
    expect(
      validateTemplateScheduleInput({ recurrence: "weekly", hour: 9, minute: 30 }),
    ).toEqual({ ok: true, recurrence: "weekly", hour: 9, minute: 30 });
  });

  it("refuses an unknown cadence instead of coercing it", () => {
    expect(validateTemplateScheduleInput({ recurrence: "yearly" })).toEqual({
      ok: false,
      error: "Choose a valid schedule.",
    });
  });

  it("refuses out-of-range times and a minute without an hour", () => {
    expect(
      validateTemplateScheduleInput({ recurrence: "daily", hour: 24 }),
    ).toMatchObject({ ok: false });
    expect(
      validateTemplateScheduleInput({ recurrence: "daily", hour: 9, minute: 60 }),
    ).toMatchObject({ ok: false });
    expect(
      validateTemplateScheduleInput({ recurrence: "daily", minute: 30 }),
    ).toMatchObject({ ok: false });
  });
});

describe("nextRunForSchedule / advanceTemplateSchedule (R31.20-R31.22)", () => {
  it("pins the next run to the schedule wall clock", () => {
    const now = new Date(2026, 0, 1, 9, 37, 12);
    const anchor = templateScheduleAnchor(now, 9, 0);
    expect(nextRunForSchedule("daily", now, anchor)).toEqual(
      new Date(2026, 0, 2, 9, 0, 0, 0),
    );
  });

  it("clamps a monthly schedule anchored on the 31st without skipping February", () => {
    const now = new Date(2026, 0, 31, 9, 0);
    const anchor = templateScheduleAnchor(now, 9, 0);
    const feb = nextRunForSchedule("monthly", now, anchor);
    expect(feb).toEqual(new Date(2026, 1, 28, 9, 0));
    expect(nextRunForSchedule("monthly", feb as Date, anchor)).toEqual(
      new Date(2026, 2, 31, 9, 0),
    );
  });

  it("catch-up is single-row: stale schedule jumps past now, pinned", () => {
    const now = new Date(2026, 0, 1, 9, 37);
    const stale = new Date(2025, 11, 20, 9, 0);
    const anchor = new Date(2025, 11, 20, 9, 0);
    const next = advanceTemplateSchedule("daily", stale, anchor, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next).toEqual(new Date(2026, 0, 2, 9, 0));
  });

  it("manual schedules have no next run", () => {
    expect(nextRunForSchedule(null, new Date())).toBeNull();
  });
});

describe("isTemplateDue (R31.22 pause)", () => {
  const now = new Date(2026, 0, 1, 9, 37);

  it("is true only for an unpaused, due schedule", () => {
    expect(
      isTemplateDue({ recurrence: "daily", nextRunAt: new Date(2026, 0, 1, 9, 0) }, now),
    ).toBe(true);
    expect(
      isTemplateDue(
        { recurrence: "daily", nextRunAt: new Date(2026, 0, 1, 9, 0), paused: true },
        now,
      ),
    ).toBe(false);
    expect(
      isTemplateDue({ recurrence: "daily", nextRunAt: new Date(2026, 0, 2, 9, 0) }, now),
    ).toBe(false);
    expect(isTemplateDue({ recurrence: null, nextRunAt: new Date(2026, 0, 1) }, now)).toBe(
      false,
    );
  });
});

describe("occurrence key (R31.22 idempotency)", () => {
  it("is deterministic in template + scheduled instant and distinct per run", () => {
    const first = new Date(2026, 0, 1, 9, 0);
    const second = new Date(2026, 0, 2, 9, 0);
    expect(templateOccurrenceKey("t-1", first)).toBe(
      `t-1:${first.toISOString()}`,
    );
    expect(templateOccurrenceKey("t-1", first)).toBe(
      templateOccurrenceKey("t-1", first),
    );
    expect(templateOccurrenceKey("t-1", first)).not.toBe(
      templateOccurrenceKey("t-1", second),
    );
    expect(templateOccurrenceKey("t-1", first)).not.toBe(
      templateOccurrenceKey("t-2", first),
    );
  });

  it("recognises Prisma's unique-constraint code only", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false);
    expect(isUniqueConstraintError(new Error("P2002"))).toBe(false);
  });
});

describe("actor + labels (R31.1/R89.17)", () => {
  it("prefers the template creator and falls back to the database creator", () => {
    expect(resolveTemplateActorId({ createdById: "a" }, { createdById: "b" })).toBe("a");
    expect(resolveTemplateActorId({}, { createdById: "b" })).toBe("b");
    expect(resolveTemplateActorId({}, {})).toBeNull();
  });

  it("describes manual, paused and scheduled states", () => {
    expect(describeTemplateSchedule({})).toBe("Manual");
    expect(describeTemplateSchedule({ recurrence: "weekly", paused: true })).toBe(
      "Weekly · paused",
    );
    const next = new Date(2026, 0, 2, 9, 0);
    expect(describeTemplateSchedule({ recurrence: "daily", nextRunAt: next })).toContain(
      "Daily · next",
    );
  });

  it("formats a next run and degrades invalid input to null", () => {
    expect(formatTemplateNextRun("not-a-date")).toBeNull();
    expect(formatTemplateNextRun(null)).toBeNull();
    expect(formatTemplateNextRun(new Date(2026, 0, 2, 9, 0))).toContain("2026");
  });

  it("reads the persisted anchor from config", () => {
    const iso = "2026-01-01T09:00:00.000Z";
    expect(templateAnchorFromConfig({ anchorAt: iso })?.toISOString()).toBe(iso);
    expect(templateAnchorFromConfig({ anchorAt: "nope" })).toBeNull();
    expect(templateAnchorFromConfig(null)).toBeNull();
  });
});

describe("template variables + property defaults (R31.18)", () => {
  const run = new Date(Date.UTC(2026, 0, 5, 12, 0));
  const context = templateVariableContext(run);

  it("stamps the run date, never the authoring date", () => {
    expect(resolveTemplateText("Weekly report {{date}}", context)).toBe(
      "Weekly report 2026-01-05",
    );
  });

  it("resolves strings inside TEXT/DATE-shaped property values", () => {
    const value = resolveTemplateValue(
      { text: "Due {{date}}", start: "{{date}}", nested: ["{{title}}"] },
      context,
    );
    expect(value).toEqual({
      text: "Due 2026-01-05",
      start: "2026-01-05",
      nested: ["2026-01-05"],
    });
  });

  it("keeps a ProseMirror doc wrapper and clones the tree", () => {
    const source = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "{{date}}" }] }],
    };
    const resolved = resolveTemplateContent(source, context) as typeof source;
    expect(resolved).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "2026-01-05" }] }],
    });
    expect(source.content[0].content[0].text).toBe("{{date}}");
  });

  it("collapses config.values to a property map with last-wins", () => {
    expect(
      templatePropertyDefaults({
        values: [
          { propertyId: "a", value: 1 },
          { propertyId: "a", value: 2 },
          { propertyId: "", value: 3 },
          { nope: true },
        ],
      }),
    ).toEqual({ a: 2 });
    expect(templatePropertyDefaults(null)).toEqual({});
  });
});
