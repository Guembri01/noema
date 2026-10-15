import { describe, expect, it } from "vitest";
import {
  ROLLUP_FUNCTIONS,
  allowedRollupFunctions,
  describeRollup,
  normalizeRollupConfig,
  validateRollupConfig,
} from "@/lib/rollup-config";

const relation = {
  id: "rel1",
  name: "Projects",
  type: "RELATION",
  config: { targetDatabaseId: "db2" },
};
const targetNumber = { id: "num1", name: "Points", type: "NUMBER", databaseId: "db2" };
const targetText = { id: "txt1", name: "Notes", type: "TEXT", databaseId: "db2" };
const targetDate = { id: "date1", name: "Due", type: "DATE", databaseId: "db2" };
const targetCheckbox = { id: "chk1", name: "Done", type: "CHECKBOX", databaseId: "db2" };
const sourceNumber = { id: "src1", name: "Local", type: "NUMBER", databaseId: "db1" };
const props = [relation, targetNumber, targetText, targetDate, targetCheckbox, sourceNumber];

const codesOf = (config: unknown): string[] =>
  validateRollupConfig(config, props).map((issue) => issue.code);

describe("normalizeRollupConfig", () => {
  it("coerces a raw config into the canonical shape", () => {
    expect(
      normalizeRollupConfig({
        relationPropertyId: " rel1 ",
        targetPropertyId: " num1 ",
        aggregateFn: "sum",
      }),
    ).toEqual({ relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "sum" });
  });

  it("accepts the persisted `function` key and defaults the function", () => {
    expect(
      normalizeRollupConfig({ relationPropertyId: "rel1", targetPropertyId: "num1", function: "avg" })
        .aggregateFn,
    ).toBe("avg");
    expect(normalizeRollupConfig({ relationPropertyId: "rel1" }).aggregateFn).toBe("count");
    expect(
      normalizeRollupConfig({ relationPropertyId: "rel1", aggregateFn: "not-a-function" }).aggregateFn,
    ).toBe("count");
  });

  it("tolerates JSON strings, null and primitives without throwing", () => {
    expect(
      normalizeRollupConfig(
        '{"relationPropertyId":"rel1","targetPropertyId":"num1","aggregateFn":"max"}',
      ),
    ).toEqual({ relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "max" });
    expect(normalizeRollupConfig("not json")).toEqual({
      relationPropertyId: "",
      targetPropertyId: "",
      aggregateFn: "count",
    });
    expect(normalizeRollupConfig(null)).toEqual({
      relationPropertyId: "",
      targetPropertyId: "",
      aggregateFn: "count",
    });
    expect(normalizeRollupConfig(42)).toEqual({
      relationPropertyId: "",
      targetPropertyId: "",
      aggregateFn: "count",
    });
  });

  it("is idempotent", () => {
    const once = normalizeRollupConfig({
      relationPropertyId: "rel1",
      targetPropertyId: "num1",
      aggregateFn: "sum",
    });
    expect(normalizeRollupConfig(once)).toEqual(once);
  });
});

describe("validateRollupConfig", () => {
  it("accepts a compatible configuration", () => {
    expect(
      validateRollupConfig(
        { relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "sum" },
        props,
      ),
    ).toEqual([]);
    expect(
      validateRollupConfig(
        { relationPropertyId: "rel1", targetPropertyId: "date1", aggregateFn: "latest" },
        props,
      ),
    ).toEqual([]);
    expect(
      validateRollupConfig(
        { relationPropertyId: "rel1", targetPropertyId: "chk1", aggregateFn: "percent_checked" },
        props,
      ),
    ).toEqual([]);
  });

  it("flags a missing relation", () => {
    expect(codesOf({ relationPropertyId: "", targetPropertyId: "num1", aggregateFn: "sum" })).toContain(
      "MISSING_RELATION",
    );
    expect(
      codesOf({ relationPropertyId: "ghost", targetPropertyId: "num1", aggregateFn: "sum" }),
    ).toContain("MISSING_RELATION");
    expect(
      codesOf({ relationPropertyId: "num1", targetPropertyId: "num1", aggregateFn: "sum" }),
    ).toContain("MISSING_RELATION");
  });

  it("flags a target that is not on the related database", () => {
    expect(codesOf({ relationPropertyId: "rel1", targetPropertyId: "", aggregateFn: "sum" })).toContain(
      "TARGET_NOT_ON_RELATED_DB",
    );
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "ghost", aggregateFn: "sum" }),
    ).toContain("TARGET_NOT_ON_RELATED_DB");
    // `src1` exists but lives on the source database (db1), not the relation target (db2).
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "src1", aggregateFn: "sum" }),
    ).toContain("TARGET_NOT_ON_RELATED_DB");
  });

  it("flags an aggregation that is incompatible with the target type", () => {
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "txt1", aggregateFn: "sum" }),
    ).toContain("INCOMPATIBLE_AGGREGATION");
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "earliest" }),
    ).toContain("INCOMPATIBLE_AGGREGATION");
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "date1", aggregateFn: "percent_checked" }),
    ).toContain("INCOMPATIBLE_AGGREGATION");
    expect(
      codesOf({ relationPropertyId: "rel1", targetPropertyId: "chk1", aggregateFn: "sum" }),
    ).toContain("INCOMPATIBLE_AGGREGATION");
  });

  it("reports only the relation issue when the relation is missing", () => {
    const issues = validateRollupConfig(
      { relationPropertyId: "ghost", targetPropertyId: "also-ghost", aggregateFn: "sum" },
      props,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MISSING_RELATION");
  });

  it("never throws and accepts a `{ properties }` wrapper", () => {
    expect(() => validateRollupConfig(undefined, undefined)).not.toThrow();
    expect(codesOf(undefined)).toEqual(["MISSING_RELATION"]);
    expect(
      validateRollupConfig(
        { relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "sum" },
        { properties: props },
      ),
    ).toEqual([]);
    expect(codesOf("totally invalid")).toEqual(["MISSING_RELATION"]);
  });
});

describe("ROLLUP_FUNCTIONS (allowed per target type)", () => {
  it("offers numeric aggregates for NUMBER and rejects the rest", () => {
    expect(ROLLUP_FUNCTIONS.NUMBER).toContain("sum");
    expect(ROLLUP_FUNCTIONS.NUMBER).toContain("avg");
    expect(ROLLUP_FUNCTIONS.NUMBER).toContain("median");
    expect(ROLLUP_FUNCTIONS.NUMBER).not.toContain("checked");
    expect(ROLLUP_FUNCTIONS.NUMBER).not.toContain("earliest");
  });

  it("offers date aggregates for DATE", () => {
    expect(ROLLUP_FUNCTIONS.DATE).toContain("earliest");
    expect(ROLLUP_FUNCTIONS.DATE).toContain("latest");
    expect(ROLLUP_FUNCTIONS.DATE).not.toContain("sum");
  });

  it("offers boolean aggregates for CHECKBOX", () => {
    expect(ROLLUP_FUNCTIONS.CHECKBOX).toContain("checked");
    expect(ROLLUP_FUNCTIONS.CHECKBOX).toContain("percent_checked");
    expect(ROLLUP_FUNCTIONS.CHECKBOX).not.toContain("sum");
  });

  it("always allows counting and never repeats a function", () => {
    for (const functions of Object.values(ROLLUP_FUNCTIONS)) {
      expect(functions).toContain("count");
      expect(new Set(functions).size).toBe(functions.length);
    }
  });

  it("resolves a function list per property type, case-insensitively", () => {
    expect(allowedRollupFunctions("NUMBER")).toBe(ROLLUP_FUNCTIONS.NUMBER);
    expect(allowedRollupFunctions("number")).toBe(ROLLUP_FUNCTIONS.NUMBER);
    expect(allowedRollupFunctions("unknown-type")).toEqual([
      "count",
      "count_empty",
      "unique",
      "show_original",
    ]);
  });
});

describe("describeRollup", () => {
  it("summarises a fully resolved rollup", () => {
    expect(
      describeRollup({ relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "sum" }, props),
    ).toBe("Sum of Points via Projects");
  });

  it("falls back when pieces are unresolved", () => {
    expect(
      describeRollup({ relationPropertyId: "ghost", targetPropertyId: "num1", aggregateFn: "sum" }, props),
    ).toBe("Sum of Points");
    expect(
      describeRollup({ relationPropertyId: "rel1", targetPropertyId: "ghost", aggregateFn: "sum" }, props),
    ).toBe("Sum via Projects");
    expect(
      describeRollup({ relationPropertyId: "rel1", targetPropertyId: "num1", aggregateFn: "nope" }, props),
    ).toBe("Count all of Points via Projects");
    expect(describeRollup(null, props)).toBe("Count all");
  });
});
