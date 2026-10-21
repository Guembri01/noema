import { describe, expect, it } from "vitest";
import {
  isRequiredMissing,
  summarizeIssues,
  validateCell,
  validateRow,
  validateValues,
  type CellValidation,
  type PropertyIssue,
} from "@/lib/cell-validation";

/* Fixtures mirror the property shape the database views store: a generic
   `{ id, name, type, required?, config? }` record. Values follow the app's
   wrapped cell shapes (`{ text }`, `{ number }`, `{ optionId }`, …) but the
   validators must also tolerate raw strings/arrays and junk. */

type TestProperty = {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  config?: {
    min?: number;
    max?: number;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    primary?: boolean;
    options?: { id: string }[];
  };
};

const title: TestProperty = {
  id: "title",
  name: "Title",
  type: "TEXT",
  required: true,
  config: { primary: true, minLength: 3, maxLength: 8 },
};
const estimate: TestProperty = {
  id: "estimate",
  name: "Estimate",
  type: "NUMBER",
  required: true,
  config: { min: 0, max: 100 },
};
const code: TestProperty = {
  id: "code",
  name: "Code",
  type: "TEXT",
  config: { pattern: "^[A-Z]{2}-\\d{3}$" },
};
const badPattern: TestProperty = {
  id: "bad",
  name: "Bad",
  type: "TEXT",
  config: { pattern: "([unclosed" },
};
/** A quantified group with an alternation: the classic exponential blow-up. */
const riskyPattern: TestProperty = {
  id: "risky",
  name: "Risky",
  type: "TEXT",
  config: { pattern: "(a|aa)+$" },
};
/** A quantified group with an inner quantifier: the second blow-up. */
const nestedPattern: TestProperty = {
  id: "nested",
  name: "Nested",
  type: "TEXT",
  config: { pattern: "(a+)+$" },
};
/** An alternation that is not quantified: ordinary and harmless. */
const petPattern: TestProperty = {
  id: "pet",
  name: "Pet",
  type: "TEXT",
  config: { pattern: "^(cat|dog)$" },
};
/** A quantified group whose body holds a class, not an alternation. */
const classPattern: TestProperty = {
  id: "class",
  name: "Class",
  type: "TEXT",
  config: { pattern: "^([a|b])+$" },
};
/** Quantified groups that a literal pins apart: linear and harmless. */
const pinnedPattern: TestProperty = {
  id: "pinned",
  name: "Pinned",
  type: "TEXT",
  config: { pattern: "^(\\d+)-(\\d+)$" },
};
const status: TestProperty = {
  id: "status",
  name: "Status",
  type: "SELECT",
  required: true,
  config: { options: [{ id: "todo" }, { id: "done" }] },
};
const tags: TestProperty = {
  id: "tags",
  name: "Tags",
  type: "MULTI_SELECT",
  required: true,
  config: { options: [{ id: "web" }, { id: "api" }] },
};
const freeSelect: TestProperty = {
  id: "free",
  name: "Free",
  type: "SELECT",
  config: {},
};
const due: TestProperty = {
  id: "due",
  name: "Due",
  type: "DATE",
  required: true,
};
const range: TestProperty = { id: "range", name: "Range", type: "DATE" };
const agree: TestProperty = {
  id: "agree",
  name: "Agree",
  type: "CHECKBOX",
  required: true,
};
const gadget: TestProperty = { id: "gadget", name: "Gadget", type: "GADGET" };
const gadgetRequired: TestProperty = {
  id: "gadget",
  name: "Gadget",
  type: "GADGET",
  required: true,
};

const allProps: TestProperty[] = [
  title,
  estimate,
  code,
  status,
  tags,
  due,
  agree,
  gadget,
];

const codes = (result: CellValidation): string[] =>
  result.ok ? [] : result.errors.map((error) => error.code);

type TestRow = { id?: string; title?: string; propertyValues?: unknown };
const row = (
  id: string,
  values: Record<string, unknown>,
  titleText?: string,
): TestRow => ({
  id,
  ...(titleText === undefined ? {} : { title: titleText }),
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
});

const goodValues = {
  title: { text: "Hello" },
  estimate: { number: 5 },
  code: { text: "AB-123" },
  status: { optionId: "todo" },
  tags: { optionIds: ["web"] },
  due: { start: "2026-01-01" },
  agree: { checked: false },
};

describe("isRequiredMissing", () => {
  it("treats null, undefined, empty string and empty array as missing", () => {
    expect(isRequiredMissing(title, null)).toBe(true);
    expect(isRequiredMissing(title, undefined)).toBe(true);
    expect(isRequiredMissing(title, "")).toBe(true);
    expect(isRequiredMissing(tags, [])).toBe(true);
  });

  it("treats whitespace-only strings and empty wrapped values as missing", () => {
    expect(isRequiredMissing(title, "   ")).toBe(true);
    expect(isRequiredMissing(title, { text: "" })).toBe(true);
    expect(isRequiredMissing(tags, { optionIds: [] })).toBe(true);
    expect(isRequiredMissing(estimate, { number: null })).toBe(true);
  });

  it("treats a filled value as present", () => {
    expect(isRequiredMissing(title, "Hi")).toBe(false);
    expect(isRequiredMissing(title, { text: "Hi" })).toBe(false);
    expect(isRequiredMissing(tags, { optionIds: ["web"] })).toBe(false);
    expect(isRequiredMissing(estimate, { number: 0 })).toBe(false);
  });

  it("ignores the rule when the property is not required", () => {
    expect(isRequiredMissing(code, "")).toBe(false);
  });

  it("counts a checkbox state (even unchecked) as present", () => {
    expect(isRequiredMissing(agree, { checked: false })).toBe(false);
  });
});

describe("validateCell — required per type", () => {
  it("flags required values that are empty, per type", () => {
    expect(codes(validateCell(title, ""))).toEqual(["REQUIRED"]);
    expect(codes(validateCell(estimate, { number: null }))).toEqual(["REQUIRED"]);
    expect(codes(validateCell(status, { optionId: "" }))).toEqual(["REQUIRED"]);
    expect(codes(validateCell(tags, { optionIds: [] }))).toEqual(["REQUIRED"]);
    expect(codes(validateCell(due, { start: "" }))).toEqual(["REQUIRED"]);
  });

  it("accepts required values that are filled", () => {
    expect(validateCell(title, "Hello").ok).toBe(true);
    expect(validateCell(estimate, { number: 5 }).ok).toBe(true);
    expect(validateCell(status, { optionId: "todo" }).ok).toBe(true);
    expect(validateCell(tags, { optionIds: ["web"] }).ok).toBe(true);
    expect(validateCell(due, { start: "2026-01-01" }).ok).toBe(true);
  });

  it("returns machine-readable errors with a message", () => {
    const result = validateCell(title, "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(typeof result.errors[0].code).toBe("string");
      expect(typeof result.errors[0].message).toBe("string");
      expect(result.errors[0].message).toContain("Title");
    }
  });

  it("does not add length errors when a required value is simply missing", () => {
    expect(codes(validateCell(title, ""))).toEqual(["REQUIRED"]);
  });
});

describe("validateCell — number min/max (inclusive)", () => {
  it("accepts the inclusive boundaries", () => {
    expect(validateCell(estimate, { number: 0 }).ok).toBe(true);
    expect(validateCell(estimate, { number: 100 }).ok).toBe(true);
  });

  it("accepts values inside the range", () => {
    expect(validateCell(estimate, { number: 50 }).ok).toBe(true);
  });

  it("rejects values below the minimum", () => {
    expect(codes(validateCell(estimate, { number: -1 }))).toEqual(["MIN"]);
  });

  it("rejects values above the maximum", () => {
    expect(codes(validateCell(estimate, { number: 101 }))).toEqual(["MAX"]);
  });

  it("reads a numeric value supplied as a raw number", () => {
    expect(validateCell(estimate, 42).ok).toBe(true);
    expect(codes(validateCell(estimate, 200))).toEqual(["MAX"]);
  });
});

describe("validateCell — text length (inclusive)", () => {
  it("accepts the inclusive length boundaries", () => {
    expect(validateCell(title, "abc").ok).toBe(true);
    expect(validateCell(title, "abcdefgh").ok).toBe(true);
  });

  it("rejects a value shorter than minLength", () => {
    expect(codes(validateCell(title, "ab"))).toEqual(["MIN_LENGTH"]);
  });

  it("rejects a value longer than maxLength", () => {
    expect(codes(validateCell(title, "abcdefghi"))).toEqual(["MAX_LENGTH"]);
  });
});

describe("validateCell — pattern", () => {
  it("accepts a matching value", () => {
    expect(validateCell(code, "AB-123").ok).toBe(true);
  });

  it("rejects a non-matching value", () => {
    expect(codes(validateCell(code, "ab-123"))).toEqual(["PATTERN"]);
  });

  it("ignores an invalid pattern instead of throwing", () => {
    expect(() => validateCell(badPattern, "anything")).not.toThrow();
    expect(validateCell(badPattern, "anything").ok).toBe(true);
  });

  it("ignores a pattern whose backtracking can explode", () => {
    // An alternation inside a quantified group has no inner quantifier, so a
    // quantifier-only guard would let it through — and it is the exponential
    // case. The pattern is not applied at all, so the value is accepted.
    expect(validateCell(riskyPattern, "aaaa!").ok).toBe(true);
    expect(validateCell(riskyPattern, "anything").ok).toBe(true);
  });

  it("ignores a pattern with a nested quantifier", () => {
    expect(validateCell(nestedPattern, "aaaa!").ok).toBe(true);
  });

  it("does not run a risky pattern on a long value", () => {
    // The pattern is refused before the regex engine ever sees the text, so
    // the value is checked in milliseconds instead of freezing the editor.
    const started = Date.now();
    const result = validateCell(riskyPattern, `${"a".repeat(30)}!`);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it("still applies an alternation that is not quantified", () => {
    expect(validateCell(petPattern, "cat").ok).toBe(true);
    expect(codes(validateCell(petPattern, "bird"))).toEqual(["PATTERN"]);
  });

  it("still applies a quantified group that a literal pins apart", () => {
    expect(validateCell(pinnedPattern, "12-34").ok).toBe(true);
    expect(codes(validateCell(pinnedPattern, "12-34x"))).toEqual(["PATTERN"]);
  });

  it("still applies a quantified group whose body is a character class", () => {
    expect(validateCell(classPattern, "a").ok).toBe(true);
    expect(codes(validateCell(classPattern, "c"))).toEqual(["PATTERN"]);
  });
});

describe("validateCell — select option membership", () => {
  it("accepts a known single-select option", () => {
    expect(validateCell(status, { optionId: "todo" }).ok).toBe(true);
  });

  it("rejects an unknown single-select option", () => {
    expect(codes(validateCell(status, { optionId: "nope" }))).toEqual([
      "SELECT_OPTION",
    ]);
  });

  it("accepts a known multi-select option set", () => {
    expect(validateCell(tags, { optionIds: ["web", "api"] }).ok).toBe(true);
  });

  it("rejects an unknown multi-select option", () => {
    expect(codes(validateCell(tags, { optionIds: ["web", "ghost"] }))).toEqual([
      "SELECT_OPTION",
    ]);
  });

  it("is permissive when no options are configured", () => {
    expect(validateCell(freeSelect, { optionId: "anything" }).ok).toBe(true);
  });
});

describe("validateCell — date ordering", () => {
  it("accepts a well-ordered range and a single date", () => {
    expect(validateCell(range, { start: "2026-01-01", end: "2026-01-05" }).ok).toBe(
      true,
    );
    expect(validateCell(range, { start: "2026-01-01" }).ok).toBe(true);
  });

  it("accepts an equal start and end", () => {
    expect(validateCell(range, { start: "2026-01-01", end: "2026-01-01" }).ok).toBe(
      true,
    );
  });

  it("rejects an end before the start", () => {
    expect(
      codes(validateCell(range, { start: "2026-01-05", end: "2026-01-01" })),
    ).toEqual(["DATE_RANGE"]);
  });
});

describe("validateCell — checkbox and unknown types", () => {
  it("accepts any checkbox state", () => {
    expect(validateCell(agree, { checked: false }).ok).toBe(true);
    expect(validateCell(agree, { checked: true }).ok).toBe(true);
  });

  it("is permissive for an unknown property type", () => {
    expect(validateCell(gadget, { anything: "goes" }).ok).toBe(true);
    expect(validateCell(gadget, 12345).ok).toBe(true);
  });

  it("still enforces required for an unknown type", () => {
    expect(codes(validateCell(gadgetRequired, ""))).toEqual(["REQUIRED"]);
    expect(validateCell(gadgetRequired, "x").ok).toBe(true);
  });
});

describe("validateCell - the stored pattern budget", () => {
  const polynomial = {
    id: "poly",
    name: "Poly",
    type: "TEXT",
    config: { pattern: "a*a*a*a*a*a*a*a*b" },
  };

  it("ignores a polynomial pattern instead of freezing on it", () => {
    // The group scan misses this shape; the formula step estimate must refuse
    // it, so the constraint is skipped and the cell is accepted.
    expect(validateCell(polynomial, { text: "a".repeat(30) }).ok).toBe(true);
  });

  it("still applies a safe pattern", () => {
    expect(
      validateCell(
        { id: "safe", name: "Safe", type: "TEXT", config: { pattern: "^[a-z]+$" } },
        { text: "abc" },
      ).ok,
    ).toBe(true);
    expect(
      validateCell(
        { id: "safe", name: "Safe", type: "TEXT", config: { pattern: "^[a-z]+$" } },
        { text: "ABC" },
      ).ok,
    ).toBe(false);
  });
});

describe("validateCell - never throws on odd input", () => {
  it("is permissive for a null or undefined property", () => {
    expect(validateCell(null, "value")).toEqual({ ok: true });
    expect(validateCell(undefined, undefined)).toEqual({ ok: true });
  });

  it("handles malformed property shapes", () => {
    expect(() => validateCell({} as TestProperty, {})).not.toThrow();
    expect(validateCell({} as TestProperty, {}).ok).toBe(true);
    expect(() =>
      validateCell({ id: 7, name: 8, type: 9, config: "nope" } as unknown as TestProperty, "x"),
    ).not.toThrow();
  });

  it("handles exotic and circular values without throwing", () => {
    expect(() => validateCell(title, () => undefined)).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateCell(title, circular)).not.toThrow();
  });
});

describe("validateRow", () => {
  it("returns no issues for a valid row", () => {
    expect(validateRow(allProps, row("r1", goodValues))).toEqual([]);
  });

  it("returns one entry per failing property", () => {
    const issues = validateRow(
      allProps,
      row("r2", {
        ...goodValues,
        title: { text: "" },
        estimate: { number: 200 },
        status: { optionId: "nope" },
      }),
    );
    expect(issues.map((issue) => issue.propertyId).sort()).toEqual([
      "estimate",
      "status",
      "title",
    ]);
    expect(issues.find((i) => i.propertyId === "estimate")?.errors[0].code).toBe(
      "MAX",
    );
  });

  it("reads a plain propertyId map as well as a propertyValues row", () => {
    const issues = validateRow(allProps, {
      ...goodValues,
      title: { text: "" },
    } as unknown as TestRow);
    expect(issues.map((issue) => issue.propertyId)).toEqual(["title"]);
  });

  it("falls back to row.title for the primary property", () => {
    const viaTitle = row(
      "r3",
      {
        estimate: { number: 5 },
        status: { optionId: "todo" },
        tags: { optionIds: ["web"] },
        due: { start: "2026-01-01" },
        agree: { checked: false },
      },
      "Hello",
    );
    expect(validateRow(allProps, viaTitle)).toEqual([]);
    const emptyTitle = { ...viaTitle, title: "" };
    expect(validateRow(allProps, emptyTitle).map((i) => i.propertyId)).toEqual([
      "title",
    ]);
  });

  it("never throws on malformed rows", () => {
    const junk = [null, undefined, "junk", 42, { propertyValues: [null, 7] }];
    for (const candidate of junk) {
      expect(() => validateRow(allProps, candidate as unknown as TestRow)).not.toThrow();
    }
    expect(validateRow(null as unknown as TestProperty[], {})).toEqual([]);
  });
});

describe("validateValues", () => {
  it("reports only the rows that have issues", () => {
    const rows = [
      row("ok", goodValues),
      row("bad-required", { ...goodValues, title: { text: "" } }),
      row("bad-max", { ...goodValues, estimate: { number: 500 } }),
    ];
    const result = validateValues(allProps, rows);
    expect(result.map((entry) => entry.rowId)).toEqual([
      "bad-required",
      "bad-max",
    ]);
    expect(result[0].issues[0].propertyId).toBe("title");
  });

  it("returns an empty list when every row is valid", () => {
    expect(validateValues(allProps, [row("a", goodValues), row("b", goodValues)])).toEqual(
      [],
    );
  });

  it("never throws on an empty or malformed batch", () => {
    expect(validateValues(allProps, [])).toEqual([]);
    expect(() => validateValues(allProps, null as unknown as TestRow[])).not.toThrow();
    expect(() =>
      validateValues(allProps, [null, undefined, "junk"] as unknown as TestRow[]),
    ).not.toThrow();
  });
});

describe("summarizeIssues", () => {
  const issue = (
    propertyId: string,
    count: number,
  ): PropertyIssue => ({
    propertyId,
    propertyName: propertyId,
    errors: Array.from({ length: count }, () => ({
      code: "REQUIRED" as const,
      message: "missing",
    })),
  });

  it("counts issues per property, most frequent first", () => {
    expect(summarizeIssues([issue("title", 3), issue("estimate", 1)])).toEqual([
      { propertyId: "title", count: 3 },
      { propertyId: "estimate", count: 1 },
    ]);
  });

  it("merges repeated properties", () => {
    expect(summarizeIssues([issue("title", 1), issue("title", 2)])).toEqual([
      { propertyId: "title", count: 3 },
    ]);
  });

  it("aggregates a batch flattened from validateValues", () => {
    const rows = [
      row("bad-required", {
        ...goodValues,
        title: { text: "" },
        estimate: { number: 200 },
      }),
      row("bad-max", { ...goodValues, estimate: { number: 500 } }),
    ];
    const flat = validateValues(allProps, rows).flatMap((entry) => entry.issues);
    expect(summarizeIssues(flat)).toEqual([
      { propertyId: "estimate", count: 2 },
      { propertyId: "title", count: 1 },
    ]);
  });

  it("never throws on malformed input", () => {
    expect(summarizeIssues(null as unknown as PropertyIssue[])).toEqual([]);
    expect(summarizeIssues([null, undefined, "junk"] as unknown as PropertyIssue[])).toEqual(
      [],
    );
    expect(
      summarizeIssues([
        { propertyId: "x", errors: [] } as unknown as PropertyIssue,
      ]),
    ).toEqual([]);
  });
});
