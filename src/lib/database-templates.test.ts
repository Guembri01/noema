import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_COUNT,
  applyTemplate,
  buildRecurringSchedule,
  resolveDefaultTemplate,
  type DatabaseTemplate,
  type TemplateOverrides,
} from "./database-templates";

/**
 * B-F3 — pure database-template planner (docs/specs/templates.md
 * R31.13/R31.20, docs/specs/database-deep.md R89.16/R89.17).
 *
 * Red-first: written against the missing `./database-templates` module. The
 * module owns the *pure* half of the template subsystem — merging a saved
 * template's property defaults + body with row overrides, resolving a
 * database's default template, and turning a recurrence rule into the next N
 * fire times. No Prisma/React/time-of-day IO; the server actions keep the IO.
 */

const at = (y: number, m: number, d: number, h = 9, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0);

const bugTemplate = (over: Partial<DatabaseTemplate> = {}): DatabaseTemplate => ({
  id: "t1",
  name: "Bug report",
  icon: "🐛",
  propertyDefaults: {
    p_status: { optionId: "open" },
    p_priority: { text: "High" },
  },
  content: [{ type: "paragraph", content: [{ type: "text", text: "Steps" }] }],
  ...over,
});

const valueOf = (result: ReturnType<typeof applyTemplate>, propertyId: string) =>
  result.values.find((entry) => entry.propertyId === propertyId)?.value;

describe("applyTemplate — merge", () => {
  it("materializes the template's property defaults", () => {
    const result = applyTemplate(bugTemplate(), {});
    expect(result.templateId).toBe("t1");
    expect(result.name).toBe("Bug report");
    expect(result.icon).toBe("🐛");
    expect(result.values).toEqual([
      { propertyId: "p_priority", value: { text: "High" } },
      { propertyId: "p_status", value: { optionId: "open" } },
    ]);
  });

  it("lets a row override win over the template default", () => {
    const result = applyTemplate(bugTemplate(), {
      propertyValues: { p_status: { optionId: "closed" } },
    });
    expect(valueOf(result, "p_status")).toEqual({ optionId: "closed" });
    expect(result.values).toHaveLength(2);
  });

  it("merges override-only properties the template never declared", () => {
    const result = applyTemplate(bugTemplate(), {
      propertyValues: { p_owner: { names: ["Ada"] } },
    });
    expect(result.values).toHaveLength(3);
    expect(valueOf(result, "p_owner")).toEqual({ names: ["Ada"] });
  });

  it("treats an undefined override as 'not provided' and keeps the default", () => {
    const result = applyTemplate(bugTemplate(), {
      propertyValues: { p_status: undefined },
    });
    expect(valueOf(result, "p_status")).toEqual({ optionId: "open" });
    expect(result.values).toHaveLength(2);
  });

  it("stores an explicit null override instead of the default", () => {
    const result = applyTemplate(bugTemplate(), {
      propertyValues: { p_status: null },
    });
    expect(result.values).toHaveLength(2);
    expect(valueOf(result, "p_status")).toBeNull();
  });

  it("emits a deterministic order sorted by property id", () => {
    const result = applyTemplate(
      bugTemplate({
        propertyDefaults: {
          p_zeta: { text: "z" },
          p_alpha: { text: "a" },
          p_mid: { text: "m" },
        },
      }),
      {},
    );
    expect(result.values.map((entry) => entry.propertyId)).toEqual([
      "p_alpha",
      "p_mid",
      "p_zeta",
    ]);
  });
});

describe("applyTemplate — unknown / missing property ids", () => {
  it("drops template defaults for ids outside the valid property set", () => {
    const result = applyTemplate(bugTemplate(), {}, ["p_status"]);
    expect(result.values).toEqual([{ propertyId: "p_status", value: { optionId: "open" } }]);
  });

  it("drops overrides for ids outside the valid property set", () => {
    const result = applyTemplate(
      bugTemplate(),
      { propertyValues: { p_status: { optionId: "closed" }, p_ghost: 1 } },
      ["p_status", "p_priority"],
    );
    expect(result.values.map((entry) => entry.propertyId)).toEqual([
      "p_priority",
      "p_status",
    ]);
  });

  it("never invents cells for valid properties the template says nothing about", () => {
    const result = applyTemplate(bugTemplate(), {}, ["p_status", "p_priority", "p_notes"]);
    expect(result.values).toHaveLength(2);
    expect(valueOf(result, "p_notes")).toBeUndefined();
  });

  it("accepts any id when no valid set is supplied", () => {
    const result = applyTemplate(bugTemplate(), {}, undefined);
    expect(result.values).toHaveLength(2);
  });
});

describe("applyTemplate — empty templates and content", () => {
  it("returns an empty plan for an empty template", () => {
    const result = applyTemplate({ id: "e", name: "Empty" }, {});
    expect(result.values).toEqual([]);
    expect(result.content).toEqual([]);
    expect(result.icon).toBeNull();
  });

  it("tolerates a null propertyDefaults and null overrides", () => {
    const result = applyTemplate(
      { id: "e", name: "Empty", propertyDefaults: null },
      { propertyValues: null },
    );
    expect(result.values).toEqual([]);
  });

  it("carries the template body into the plan", () => {
    const result = applyTemplate(bugTemplate(), {});
    expect(result.content).toEqual(bugTemplate().content);
    expect(result.content).toHaveLength(1);
  });

  it("replaces the body when an override supplies its own", () => {
    const replacement = [{ type: "heading", attrs: { level: 1 }, content: [] }];
    const result = applyTemplate(bugTemplate(), { content: replacement });
    expect(result.content).toEqual(replacement);
    expect(result.content).toHaveLength(1);
  });

  it("clears the body when the override is an explicit empty list", () => {
    const result = applyTemplate(bugTemplate(), { content: [] });
    expect(result.content).toEqual([]);
  });
});

describe("applyTemplate — purity and idempotence", () => {
  it("does not mutate the template", () => {
    const template = bugTemplate();
    const snapshot = structuredClone(template);
    applyTemplate(template, { propertyValues: { p_extra: { text: "x" } }, content: [] });
    expect(template).toEqual(snapshot);
  });

  it("does not mutate the overrides", () => {
    const overrides: TemplateOverrides = { propertyValues: { p_status: { optionId: "closed" } } };
    const snapshot = structuredClone(overrides);
    applyTemplate(bugTemplate(), overrides);
    expect(overrides).toEqual(snapshot);
  });

  it("deep-copies values so a caller cannot mutate the template through the plan", () => {
    const template = bugTemplate();
    const result = applyTemplate(template, {});
    (valueOf(result, "p_status") as Record<string, unknown>).optionId = "tampered";
    expect(template.propertyDefaults?.p_status).toEqual({ optionId: "open" });
  });

  it("is idempotent: applying twice yields an equal plan", () => {
    const template = bugTemplate();
    const overrides: TemplateOverrides = { propertyValues: { p_status: { optionId: "closed" } } };
    expect(applyTemplate(template, overrides)).toEqual(applyTemplate(template, overrides));
  });

  it("is idempotent: re-applying its own output as overrides is a no-op", () => {
    const template = bugTemplate();
    const first = applyTemplate(template, { propertyValues: { p_status: { optionId: "closed" } } });
    const second = applyTemplate(
      { ...template, content: [] },
      {
        propertyValues: Object.fromEntries(
          first.values.map((entry) => [entry.propertyId, entry.value]),
        ),
        content: first.content,
      },
    );
    expect(second).toEqual(first);
  });
});

describe("resolveDefaultTemplate", () => {
  const a: DatabaseTemplate = { id: "a", name: "A" };
  const b: DatabaseTemplate = { id: "b", name: "B", isDefault: true };
  const c: DatabaseTemplate = { id: "c", name: "C" };

  it("resolves the id stored in the database config", () => {
    expect(resolveDefaultTemplate([a, b, c], { defaultTemplateId: "c" })?.id).toBe("c");
  });

  it("falls back to the template flagged isDefault when no id is configured", () => {
    expect(resolveDefaultTemplate([a, b, c], {})?.id).toBe("b");
  });

  it("prefers the explicit id over the flagged default", () => {
    expect(resolveDefaultTemplate([a, b, c], { defaultTemplateId: "a" })?.id).toBe("a");
  });

  it("falls back to the flag when the configured id is stale", () => {
    expect(resolveDefaultTemplate([a, b, c], { defaultTemplateId: "gone" })?.id).toBe("b");
  });

  it("returns null when the configured id is unknown and nothing is flagged", () => {
    expect(resolveDefaultTemplate([a, c], { defaultTemplateId: "gone" })).toBeNull();
  });

  it("returns null for an empty database, config or not", () => {
    expect(resolveDefaultTemplate([], { defaultTemplateId: "a" })).toBeNull();
    expect(resolveDefaultTemplate([], {})).toBeNull();
  });

  it("returns null when nothing is configured or flagged", () => {
    expect(resolveDefaultTemplate([a, c], {})).toBeNull();
    expect(resolveDefaultTemplate([a, c], null)).toBeNull();
  });

  it("ignores an empty-string id", () => {
    expect(resolveDefaultTemplate([a, b], { defaultTemplateId: "" })?.id).toBe("b");
  });
});

describe("buildRecurringSchedule", () => {
  it("lists the next N daily fire times strictly after `from`", () => {
    const times = buildRecurringSchedule(
      { freq: "daily", start: at(2026, 1, 1, 9) },
      at(2026, 1, 1, 9),
      3,
    );
    expect(times).toEqual([at(2026, 1, 2, 9), at(2026, 1, 3, 9), at(2026, 1, 4, 9)]);
  });

  it("keeps the weekday for a weekly rule", () => {
    const times = buildRecurringSchedule(
      { freq: "weekly", start: at(2026, 1, 7, 9) },
      at(2026, 1, 7, 9),
      2,
    );
    expect(times).toEqual([at(2026, 1, 14, 9), at(2026, 1, 21, 9)]);
    expect(times.every((time) => time.getDay() === 3)).toBe(true); // Wednesday
  });

  it("clamps a monthly schedule to each month's last day (Jan 31 chain)", () => {
    const times = buildRecurringSchedule(
      { freq: "monthly", start: at(2026, 1, 31, 9) },
      at(2026, 1, 31, 9),
      3,
    );
    expect(times).toEqual([at(2026, 2, 28, 9), at(2026, 3, 31, 9), at(2026, 4, 30, 9)]);
  });

  it("returns an empty schedule for a non-positive count", () => {
    expect(buildRecurringSchedule({ freq: "daily" }, at(2026, 1, 1), 0)).toEqual([]);
    expect(buildRecurringSchedule({ freq: "daily" }, at(2026, 1, 1), -4)).toEqual([]);
  });

  it("floors a fractional count", () => {
    expect(buildRecurringSchedule({ freq: "daily" }, at(2026, 1, 1, 9), 2.9)).toHaveLength(2);
  });

  it("defaults to a small preview window", () => {
    expect(DEFAULT_SCHEDULE_COUNT).toBeGreaterThan(1);
    expect(
      buildRecurringSchedule({ freq: "daily" }, at(2026, 1, 1, 9)),
    ).toHaveLength(DEFAULT_SCHEDULE_COUNT);
  });

  it("never emits a fire time at or before `from`", () => {
    const from = at(2026, 1, 1, 9);
    const times = buildRecurringSchedule({ freq: "daily", start: from }, from, 5);
    expect(times.every((time) => time.getTime() > from.getTime())).toBe(true);
  });

  it("returns an empty schedule for an invalid `from`", () => {
    expect(buildRecurringSchedule({ freq: "daily" }, new Date(Number.NaN), 3)).toEqual([]);
  });
});
