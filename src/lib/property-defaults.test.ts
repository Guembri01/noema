import { describe, expect, it } from "vitest";
import {
  defaultValueFor,
  initializeRowValues,
  isComputedType,
} from "./property-defaults";

/* Pure default-value resolution for a fresh database row.

   `defaultValueFor` returns the JSON shape the app stores on
   `PropertyValue.value` (mirroring the mapping at the top of
   `src/server/actions/database.ts`): TEXT|URL|EMAIL|PHONE `{ text }`,
   NUMBER `{ number }`, CHECKBOX `{ checked }`, DATE `{ start }`,
   SELECT|STATUS `{ optionId }`, MULTI_SELECT `{ optionIds }`,
   PEOPLE `{ names }`, FILES `{ files }`, RELATION `{ pageIds }`.
   An empty cell is `null` (nothing is stored), computed/derived types can
   never hold a default, and `config.default` may supply a concrete value. */

const options = [
  { id: "opt-todo", name: "Todo" },
  { id: "opt-done", name: "Done" },
];

const COMPUTED = [
  "FORMULA",
  "ROLLUP",
  "RELATION",
  "CREATED_TIME",
  "CREATED_BY",
  "LAST_EDITED_TIME",
  "LAST_EDITED_BY",
  "UNIQUE_ID",
  "BUTTON",
  "AI_AUTOFILL",
];

const EMPTY_TYPES = [
  "TEXT",
  "NUMBER",
  "SELECT",
  "STATUS",
  "DATE",
  "URL",
  "EMAIL",
  "PHONE",
  "PLACE",
];

describe("isComputedType", () => {
  it("flags every derived/server-managed type", () => {
    for (const type of COMPUTED) expect(isComputedType(type), type).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isComputedType("formula")).toBe(true);
    expect(isComputedType("  rollup ")).toBe(true);
  });

  it("reports user-editable types as not computed", () => {
    for (const type of ["TEXT", "NUMBER", "CHECKBOX", "SELECT", "MULTI_SELECT", "DATE", "PEOPLE", "FILES"]) {
      expect(isComputedType(type), type).toBe(false);
    }
  });

  it("never treats a non-string as computed", () => {
    expect(isComputedType(undefined)).toBe(false);
    expect(isComputedType(null)).toBe(false);
    expect(isComputedType(42)).toBe(false);
  });
});

describe("defaultValueFor — empty stored shapes", () => {
  it("returns null for text and single-value types", () => {
    for (const type of EMPTY_TYPES) expect(defaultValueFor(type), type).toBeNull();
  });

  it("returns the concrete empty shape for container types", () => {
    expect(defaultValueFor("CHECKBOX")).toStrictEqual({ checked: false });
    expect(defaultValueFor("MULTI_SELECT")).toStrictEqual({ optionIds: [] });
    expect(defaultValueFor("PEOPLE")).toStrictEqual({ names: [] });
    expect(defaultValueFor("FILES")).toStrictEqual({ files: [] });
  });

  it("returns null for computed types even when a default is configured", () => {
    for (const type of COMPUTED) {
      expect(defaultValueFor(type, { default: "x" }), type).toBeNull();
    }
  });

  it("returns null for unknown or blank types", () => {
    expect(defaultValueFor("GEO")).toBeNull();
    expect(defaultValueFor("")).toBeNull();
    expect(defaultValueFor(undefined)).toBeNull();
  });
});

describe("defaultValueFor — configured defaults", () => {
  it("stores trimmed text defaults and null when blank", () => {
    expect(defaultValueFor("TEXT", { default: "  hello " })).toStrictEqual({ text: "hello" });
    expect(defaultValueFor("URL", { default: "https://noema.app" })).toStrictEqual({
      text: "https://noema.app",
    });
    expect(defaultValueFor("EMAIL", { default: "   " })).toBeNull();
    expect(defaultValueFor("PHONE", { default: 42 })).toBeNull();
  });

  it("accepts finite numbers (zero included) and numeric strings", () => {
    expect(defaultValueFor("NUMBER", { default: 42 })).toStrictEqual({ number: 42 });
    expect(defaultValueFor("NUMBER", { default: 0 })).toStrictEqual({ number: 0 });
    expect(defaultValueFor("NUMBER", { default: "3.5" })).toStrictEqual({ number: 3.5 });
    expect(defaultValueFor("NUMBER", { default: "abc" })).toBeNull();
    expect(defaultValueFor("NUMBER", { default: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("only a real boolean checks a checkbox", () => {
    expect(defaultValueFor("CHECKBOX", { default: true })).toStrictEqual({ checked: true });
    expect(defaultValueFor("CHECKBOX", { default: false })).toStrictEqual({ checked: false });
    expect(defaultValueFor("CHECKBOX", { default: "yes" })).toStrictEqual({ checked: false });
  });

  it("stores a non-empty date string as { start }", () => {
    expect(defaultValueFor("DATE", { default: " 2026-01-15 " })).toStrictEqual({
      start: "2026-01-15",
    });
    expect(defaultValueFor("DATE", { default: "   " })).toBeNull();
  });

  it("resolves a SELECT/STATUS default by option id or by name", () => {
    expect(defaultValueFor("SELECT", { default: "opt-todo", options })).toStrictEqual({
      optionId: "opt-todo",
    });
    expect(defaultValueFor("STATUS", { default: "Done", options })).toStrictEqual({
      optionId: "opt-done",
    });
    expect(defaultValueFor("SELECT", { default: "nope", options })).toBeNull();
  });

  it("keeps a literal id when SELECT has no configured options", () => {
    expect(defaultValueFor("SELECT", { default: "opt-todo" })).toStrictEqual({
      optionId: "opt-todo",
    });
  });

  it("resolves MULTI_SELECT defaults and drops unknown options", () => {
    expect(
      defaultValueFor("MULTI_SELECT", { default: ["Todo", "opt-done"], options }),
    ).toStrictEqual({ optionIds: ["opt-todo", "opt-done"] });
    expect(defaultValueFor("MULTI_SELECT", { default: ["nope"], options })).toStrictEqual({
      optionIds: [],
    });
    expect(defaultValueFor("MULTI_SELECT", { default: "Todo" })).toStrictEqual({
      optionIds: [],
    });
  });

  it("keeps PEOPLE defaults to the string names only", () => {
    expect(defaultValueFor("PEOPLE", { default: ["Ada", 7, "Grace"] })).toStrictEqual({
      names: ["Ada", "Grace"],
    });
    expect(defaultValueFor("PEOPLE")).toStrictEqual({ names: [] });
  });

  it("never throws on malformed config", () => {
    expect(defaultValueFor("TEXT", null)).toBeNull();
    expect(defaultValueFor("SELECT", "nope")).toBeNull();
    expect(defaultValueFor("MULTI_SELECT", [1, 2])).toStrictEqual({ optionIds: [] });
  });
});

describe("initializeRowValues", () => {
  const props = [
    { id: "p-name", type: "TEXT" },
    { id: "p-done", type: "CHECKBOX" },
    { id: "p-est", type: "NUMBER", config: { default: 3 } },
    { id: "p-tags", type: "MULTI_SELECT", config: { options, default: ["Todo"] } },
    { id: "p-created", type: "CREATED_TIME" },
  ];

  it("builds concrete defaults in schema order, skipping empty/computed", () => {
    expect(initializeRowValues(props)).toStrictEqual([
      { propertyId: "p-done", value: { checked: false } },
      { propertyId: "p-est", value: { number: 3 } },
      { propertyId: "p-tags", value: { optionIds: ["opt-todo"] } },
    ]);
  });

  it("returns fresh, unshared containers on every call", () => {
    const first = initializeRowValues([{ id: "p-tags", type: "MULTI_SELECT" }]);
    const second = initializeRowValues([{ id: "p-tags", type: "MULTI_SELECT" }]);
    expect(first).toStrictEqual(second);
    expect(first[0]?.value).not.toBe(second[0]?.value);
    (first[0]?.value as { optionIds: string[] }).optionIds.push("x");
    expect(second[0]?.value).toStrictEqual({ optionIds: [] });
  });

  it("de-duplicates by property id and drops malformed entries", () => {
    expect(
      initializeRowValues([
        { id: "p-done", type: "CHECKBOX" },
        { id: "p-done", type: "CHECKBOX" },
        { id: "", type: "CHECKBOX" },
        { type: "CHECKBOX" },
        null,
        "nope",
      ]),
    ).toStrictEqual([{ propertyId: "p-done", value: { checked: false } }]);
  });

  it("never throws on a non-array input", () => {
    expect(initializeRowValues(undefined)).toStrictEqual([]);
    expect(initializeRowValues({})).toStrictEqual([]);
  });
});
