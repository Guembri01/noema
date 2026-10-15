import { describe, expect, it } from "vitest";
import {
  coerceCsvValue,
  coerceRow,
  isCoercible,
  type CsvProperty,
} from "./csv-value-coercion";

/* Pure CSV cell → stored-value coercion, the client-side twin of
   `coerceCsvValue` in `src/server/actions/database.ts` (docs/specs/import-export.md
   R23.2 type inference / R23.5 round-trip). Shapes mirror the comment at the
   top of that action: TEXT|URL|EMAIL|PHONE `{ text }`, NUMBER `{ number }`,
   CHECKBOX `{ checked }`, DATE `{ start }`, SELECT|STATUS `{ optionId }`,
   MULTI_SELECT `{ optionIds }`, PEOPLE `{ names }`. */

const options = [
  { id: "opt-todo", name: "Todo" },
  { id: "opt-done", name: "Done" },
];

describe("isCoercible", () => {
  it("recognises the value-bearing property types (case-insensitive)", () => {
    expect(isCoercible("TEXT")).toBe(true);
    expect(isCoercible("number")).toBe(true);
    expect(isCoercible("multi_select")).toBe(true);
    expect(isCoercible("people")).toBe(true);
    expect(isCoercible("PLACE")).toBe(true);
  });

  it("rejects types a CSV cell cannot supply", () => {
    expect(isCoercible("FILES")).toBe(false);
    expect(isCoercible("RELATION")).toBe(false);
    expect(isCoercible("")).toBe(false);
  });
});

describe("coerceCsvValue — empty cells", () => {
  it("returns null for blank and non-string cells, never throws", () => {
    expect(coerceCsvValue("", "TEXT")).toBeNull();
    expect(coerceCsvValue("   ", "NUMBER")).toBeNull();
    expect(coerceCsvValue(undefined as unknown as string, "DATE")).toBeNull();
  });
});

describe("coerceCsvValue — text-shaped types", () => {
  it("trims and stores TEXT, URL, EMAIL and PHONE as { text }", () => {
    expect(coerceCsvValue("  hello  ", "TEXT")).toStrictEqual({ text: "hello" });
    expect(coerceCsvValue("https://noema.app", "URL")).toStrictEqual({
      text: "https://noema.app",
    });
    expect(coerceCsvValue(" a@b.com ", "EMAIL")).toStrictEqual({ text: "a@b.com" });
    expect(coerceCsvValue("+33 6 12 34 56 78", "PHONE")).toStrictEqual({
      text: "+33 6 12 34 56 78",
    });
  });
});

describe("coerceCsvValue — NUMBER", () => {
  it("coerces plain and display-formatted numbers", () => {
    expect(coerceCsvValue("42", "NUMBER")).toStrictEqual({ number: 42 });
    expect(coerceCsvValue("$1,234.50", "NUMBER")).toStrictEqual({ number: 1234.5 });
  });

  it("reads a percent cell as a fraction (format-aware)", () => {
    expect(coerceCsvValue("7.5%", "NUMBER")).toStrictEqual({ number: 0.075 });
    expect(coerceCsvValue("25", "NUMBER", { format: "percent" })).toStrictEqual({
      number: 0.25,
    });
  });

  it("returns null when the cell is not numeric", () => {
    expect(coerceCsvValue("abc", "NUMBER")).toBeNull();
  });
});

describe("coerceCsvValue — CHECKBOX / DATE", () => {
  it("treats truthy tokens as checked and everything else as unchecked", () => {
    expect(coerceCsvValue("yes", "CHECKBOX")).toStrictEqual({ checked: true });
    expect(coerceCsvValue("TRUE", "CHECKBOX")).toStrictEqual({ checked: true });
    expect(coerceCsvValue("no", "CHECKBOX")).toStrictEqual({ checked: false });
  });

  it("stores DATE as an ISO { start } string", () => {
    expect(coerceCsvValue(" 2026-01-15 ", "DATE")).toStrictEqual({
      start: "2026-01-15",
    });
  });
});

describe("coerceCsvValue — SELECT / STATUS", () => {
  it("resolves an option id case-insensitively", () => {
    expect(coerceCsvValue("todo", "SELECT", { options })).toStrictEqual({
      optionId: "opt-todo",
    });
    expect(coerceCsvValue(" DONE ", "STATUS", { options })).toStrictEqual({
      optionId: "opt-done",
    });
  });

  it("returns null for an unknown option or a missing option map", () => {
    expect(coerceCsvValue("nope", "SELECT", { options })).toBeNull();
    expect(coerceCsvValue("Todo", "SELECT")).toBeNull();
  });
});

describe("coerceCsvValue — MULTI_SELECT / PEOPLE", () => {
  it("resolves comma-separated option ids, dropping unknown parts", () => {
    expect(coerceCsvValue("Todo, Done", "MULTI_SELECT", { options })).toStrictEqual({
      optionIds: ["opt-todo", "opt-done"],
    });
    expect(coerceCsvValue("Todo, Nope", "MULTI_SELECT", { options })).toStrictEqual({
      optionIds: ["opt-todo"],
    });
    expect(coerceCsvValue("Nope", "MULTI_SELECT", { options })).toBeNull();
  });

  it("splits PEOPLE into trimmed { names }", () => {
    expect(coerceCsvValue("Ada Lovelace, Grace Hopper", "PEOPLE")).toStrictEqual({
      names: ["Ada Lovelace", "Grace Hopper"],
    });
    expect(coerceCsvValue(" , ", "PEOPLE")).toBeNull();
  });
});

describe("coerceCsvValue — PLACE", () => {
  it("parses `lat,lng` into { lat, lng }", () => {
    expect(coerceCsvValue("48.8566,2.3522", "PLACE")).toStrictEqual({
      lat: 48.8566,
      lng: 2.3522,
    });
    expect(coerceCsvValue(" -33.8688 , 151.2093 ", "PLACE")).toStrictEqual({
      lat: -33.8688,
      lng: 151.2093,
    });
  });

  it("keeps an optional label, even one containing commas", () => {
    expect(coerceCsvValue("48.8566,2.3522,Paris HQ", "PLACE")).toStrictEqual({
      lat: 48.8566,
      lng: 2.3522,
      label: "Paris HQ",
    });
    expect(coerceCsvValue("48.8566,2.3522,Paris, France", "PLACE")).toStrictEqual({
      lat: 48.8566,
      lng: 2.3522,
      label: "Paris, France",
    });
  });

  it("normalizes the coordinate like the PLACE cell editor", () => {
    expect(coerceCsvValue("0,180", "PLACE")).toStrictEqual({ lat: 0, lng: -180 });
  });

  it("returns null for values that are not a coordinate", () => {
    expect(coerceCsvValue("not-a-coordinate", "PLACE")).toBeNull();
    expect(coerceCsvValue("48.8566", "PLACE")).toBeNull();
    expect(coerceCsvValue("91,0", "PLACE")).toBeNull();
    expect(coerceCsvValue(",", "PLACE")).toBeNull();
  });
});

describe("coerceCsvValue — unknown types", () => {
  it("falls back to { text } like the server default branch", () => {
    expect(coerceCsvValue("raw", "FILES")).toStrictEqual({ text: "raw" });
  });
});

describe("coerceRow", () => {
  const props: CsvProperty[] = [
    { id: "p-name", name: "Name", type: "TEXT" },
    { id: "p-est", name: "Estimate", type: "NUMBER" },
    { id: "p-done", name: "Done", type: "CHECKBOX" },
  ];

  it("matches headers to properties by name and omits empty cells", () => {
    expect(coerceRow(["Name", "Estimate", "Done"], ["Roadmap", "12.5", "yes"], props)).toStrictEqual([
      { propertyId: "p-name", value: { text: "Roadmap" } },
      { propertyId: "p-est", value: { number: 12.5 } },
      { propertyId: "p-done", value: { checked: true } },
    ]);
    expect(coerceRow(["Name", "Estimate", "Done"], ["", "12.5", ""], props)).toStrictEqual([
      { propertyId: "p-est", value: { number: 12.5 } },
    ]);
  });

  it("honours an explicit per-column mapping and skips unknown ids", () => {
    expect(coerceRow(["a", "b"], ["3", "hello"], props, ["p-est", "p-name"])).toStrictEqual([
      { propertyId: "p-est", value: { number: 3 } },
      { propertyId: "p-name", value: { text: "hello" } },
    ]);
    expect(coerceRow(["a", "b"], ["3", "hello"], props, ["ghost", "p-name"])).toStrictEqual([
      { propertyId: "p-name", value: { text: "hello" } },
    ]);
  });

  it("never throws on ragged rows", () => {
    expect(coerceRow(["Name", "Estimate", "Done"], ["only-name"], props)).toStrictEqual([
      { propertyId: "p-name", value: { text: "only-name" } },
    ]);
    expect(coerceRow([], [], props)).toStrictEqual([]);
  });
});
