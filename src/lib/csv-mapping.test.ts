import { describe, expect, it } from "vitest";
import {
  buildCreatePlan,
  detectDuplicateHeaders,
  inferColumnType,
  placeholderFor,
  suggestPropertyMapping,
  type ColumnMapping,
  type ExistingProperty,
} from "./csv-mapping";

/* Pure CSV header-mapping core for the R23.1/R23.2 import flow
   (docs/specs/import-export.md, docs/MISSING_FEATURES.md §12 "CSV import").
   Fixtures use a matrix already produced by `csvToMatrix` (string[][]). */

const existing: ExistingProperty[] = [
  { id: "p-name", name: "Name", type: "TEXT" },
  { id: "p-estimate", name: "Estimate", type: "NUMBER" },
];

describe("inferColumnType", () => {
  it("detects plain numbers", () => {
    expect(inferColumnType(["1", "2", "3.5", "-4"])).toBe("number");
  });

  it("detects formatted numbers (currency, thousands, percent)", () => {
    expect(inferColumnType(["$1,234.50", "$2,000", "7.5%"])).toBe("number");
  });

  it("treats 1/0 columns as numbers, not booleans", () => {
    expect(inferColumnType(["1", "0", "1", "0"])).toBe("number");
  });

  it("detects ISO dates", () => {
    expect(inferColumnType(["2026-01-15", "2026-02-01", "2026-12-31"])).toBe("date");
  });

  it("detects slash dates", () => {
    expect(inferColumnType(["01/15/2026", "02/01/2026"])).toBe("date");
  });

  it("detects boolean-like columns", () => {
    expect(inferColumnType(["true", "false", "yes", "no"])).toBe("checkbox");
  });

  it("detects email columns", () => {
    expect(inferColumnType(["a@b.com", "c.d@example.org"])).toBe("email");
  });

  it("detects url columns", () => {
    expect(inferColumnType(["https://noema.example.com", "http://x.io", "www.example.com"])).toBe("url");
  });

  it("falls back to text for an empty column", () => {
    expect(inferColumnType(["", "  ", ""])).toBe("text");
  });

  it("falls back to text for a mixed/ambiguous column", () => {
    expect(inferColumnType(["hello", "42", "2026-01-15"])).toBe("text");
  });

  it("detects low-cardinality repeated strings as select", () => {
    expect(inferColumnType(["To-do", "Done", "To-do", "Done"])).toBe("select");
  });

  it("keeps a single distinct value as ambiguous text", () => {
    expect(inferColumnType(["Only"])).toBe("text");
  });

  it("accepts the 90% number threshold but not below it", () => {
    expect(inferColumnType(["1", "2", "3", "4", "5", "6", "7", "8", "9", "n/a"])).toBe("number");
    expect(inferColumnType(["1", "2", "3", "4", "5", "6", "7", "8", "n/a", "maybe"])).toBe(
      "text",
    );
  });

  it("returns text for an empty sample array", () => {
    expect(inferColumnType([])).toBe("text");
  });
});

describe("suggestPropertyMapping", () => {
  it("matches existing properties case-insensitively and infers the rest", () => {
    const mapping = suggestPropertyMapping(
      ["name", "ESTIMATE", "Due Date", "Notes"],
      [
        ["Alice", "3", "2026-01-15", "x"],
        ["Bob", "5", "2026-02-01", "1"],
      ],
      existing,
    );
    expect(mapping.map((m) => m.header)).toEqual(["name", "ESTIMATE", "Due Date", "Notes"]);
    expect(mapping.map((m) => m.suggestedType)).toEqual(["text", "number", "date", "text"]);
    expect(mapping.map((m) => m.matchesExistingId)).toEqual([
      "p-name",
      "p-estimate",
      undefined,
      undefined,
    ]);
  });

  it("uses the existing property type when a header matches", () => {
    const [entry] = suggestPropertyMapping(["Estimate"], [["42"]], existing);
    expect(entry.suggestedType).toBe("number");
    expect(entry.matchesExistingId).toBe("p-estimate");
  });

  it("orders confidence: name match > typed column > ambiguous > empty", () => {
    const mapping = suggestPropertyMapping(
      ["Name", "Due Date", "Notes", "Blank"],
      [
        ["Alice", "2026-01-15", "hello", ""],
        ["Bob", "2026-02-01", "42", ""],
      ],
      existing,
    );
    const byHeader = Object.fromEntries(mapping.map((m) => [m.header, m.confidence]));
    expect(byHeader.Name).toBe(1);
    expect(byHeader.Name).toBeGreaterThan(byHeader["Due Date"]);
    expect(byHeader["Due Date"]).toBeGreaterThan(byHeader.Notes);
    expect(byHeader.Notes).toBeGreaterThan(byHeader.Blank);
    expect(byHeader.Blank).toBe(0);
  });

  it("returns empty suggestions for empty headers", () => {
    expect(suggestPropertyMapping([], [], existing)).toEqual([]);
  });

  it("reports no matches when there are no existing properties", () => {
    const mapping = suggestPropertyMapping(["A", "B"], [["1", "x"]], []);
    expect(mapping.every((m) => m.matchesExistingId === undefined)).toBe(true);
    expect(mapping[0].suggestedType).toBe("number");
  });

  it("handles empty sample rows with zero confidence", () => {
    const mapping = suggestPropertyMapping(["A", "B"], [], []);
    expect(mapping.every((m) => m.confidence === 0)).toBe(true);
    expect(mapping.every((m) => m.suggestedType === "text")).toBe(true);
  });
});

describe("buildCreatePlan", () => {
  it("maps inferred types to Prisma property type names", () => {
    const mapping: ColumnMapping[] = [
      { header: "Title", suggestedType: "text", confidence: 0.3 },
      { header: "Amount", suggestedType: "number", confidence: 0.9 },
      { header: "When", suggestedType: "date", confidence: 0.85 },
      { header: "Done", suggestedType: "checkbox", confidence: 0.9 },
      { header: "Status", suggestedType: "select", confidence: 0.6 },
      { header: "Link", suggestedType: "url", confidence: 0.9 },
      { header: "Email", suggestedType: "email", confidence: 0.9 },
    ];
    const plan = buildCreatePlan(mapping);
    expect(plan.map((p) => p.type)).toEqual([
      "TEXT",
      "NUMBER",
      "DATE",
      "CHECKBOX",
      "SELECT",
      "URL",
      "EMAIL",
    ]);
    expect(plan.map((p) => p.name)).toEqual(mapping.map((m) => m.header));
    expect(plan.map((p) => p.id)).toEqual([
      "title",
      "amount",
      "when",
      "done",
      "status",
      "link",
      "email",
    ]);
  });

  it("slugs multi-word headers", () => {
    const [descriptor] = buildCreatePlan([
      { header: "Due Date", suggestedType: "date", confidence: 0.8 },
    ]);
    expect(descriptor.id).toBe("due-date");
  });

  it("skips columns already matched to an existing property", () => {
    const plan = buildCreatePlan([
      { header: "Name", suggestedType: "text", matchesExistingId: "p-name", confidence: 1 },
      { header: "Extra", suggestedType: "text", confidence: 0.3 },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe("Extra");
  });

  it("names unnamed headers with their column placeholder", () => {
    const plan = buildCreatePlan([
      { header: "", suggestedType: "text", confidence: 0.3 },
      { header: "", suggestedType: "number", confidence: 0.9 },
    ]);
    expect(plan.map((p) => p.name)).toEqual(["Column 1", "Column 2"]);
    expect(plan.map((p) => p.id)).toEqual(["column-1", "column-2"]);
  });

  it("returns an empty plan for empty input", () => {
    expect(buildCreatePlan([])).toEqual([]);
  });
});

describe("detectDuplicateHeaders", () => {
  it("returns an empty list when headers are unique", () => {
    expect(detectDuplicateHeaders(["Name", "Email", "Age"])).toEqual([]);
  });

  it("detects duplicates case-insensitively using the first spelling", () => {
    expect(detectDuplicateHeaders(["Name", "Age", "name"])).toEqual(["Name"]);
  });

  it("lists multiple duplicates in first-seen order", () => {
    expect(detectDuplicateHeaders(["Email", "Name", "email", "NAME"])).toEqual(["Email", "Name"]);
  });

  it("ignores blank headers", () => {
    expect(detectDuplicateHeaders(["", "", "Name", "  "])).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(detectDuplicateHeaders([])).toEqual([]);
  });
});

describe("placeholderFor", () => {
  it("renders a 1-based column label", () => {
    expect(placeholderFor(0)).toBe("Column 1");
    expect(placeholderFor(4)).toBe("Column 5");
    expect(placeholderFor(25)).toBe("Column 26");
  });
});
