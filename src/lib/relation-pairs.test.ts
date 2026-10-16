import { describe, expect, it } from "vitest";
import {
  ROLLUP_FUNCTIONS,
  computeRollup,
  createRelationPair,
  createRelationState,
  describeRollup,
  linkRows,
  setRollupConfig,
  symmetricPairs,
  unlinkRows,
  validateRelationPair,
  type RelationState,
} from "@/lib/relation-pairs";

const dbA = "db-a";
const dbB = "db-b";

function pair(cardinality?: "one" | "many") {
  return createRelationPair({
    a: { databaseId: dbA, propertyId: "a-rel" },
    b: { databaseId: dbB, propertyId: "b-rel" },
    cardinality,
  });
}

function pairOne() {
  return createRelationPair({
    a: { databaseId: dbA, propertyId: "a-one" },
    b: { databaseId: dbB, propertyId: "b-one" },
    cardinality: "one",
  });
}

const rows = [
  { id: "a1", databaseId: dbA },
  { id: "a2", databaseId: dbA },
  { id: "b1", databaseId: dbB, values: { score: 10, name: "Beta", done: true } },
  { id: "b2", databaseId: dbB, values: { score: 20, name: "Gamma", done: false } },
  { id: "b3", databaseId: dbB, values: { score: null, name: "" } },
];

function baseState(): RelationState {
  return createRelationState({ pairs: [pair(), pairOne()], rows });
}

function codesOf(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("createRelationPair", () => {
  it("writes reciprocal inverse metadata on both descriptors", () => {
    const p = pair();
    expect(p.a.config.targetDatabaseId).toBe(dbB);
    expect(p.b.config.targetDatabaseId).toBe(dbA);
    expect(p.a.config.inversePropertyId).toBe(p.b.id);
    expect(p.b.config.inversePropertyId).toBe(p.a.id);
    expect(p.a.config.pairId).toBe(p.id);
    expect(p.b.config.pairId).toBe(p.id);
    expect(p.a.type).toBe("RELATION");
    expect(p.b.type).toBe("RELATION");
  });

  it("maps cardinality onto the multi flag and defaults to many", () => {
    expect(pair("many").a.config.multi).toBe(true);
    expect(pair("one").a.config.multi).toBe(false);
    expect(pair().cardinality).toBe("many");
    expect(pair().a.config.multi).toBe(true);
  });

  it("derives an order-independent pair id", () => {
    const p = createRelationPair({
      a: { databaseId: dbA, propertyId: "x" },
      b: { databaseId: dbB, propertyId: "y" },
    });
    const q = createRelationPair({
      a: { databaseId: dbB, propertyId: "y" },
      b: { databaseId: dbA, propertyId: "x" },
    });
    expect(p.id).toBe(q.id);
    expect(p.id.length).toBeGreaterThan(0);
  });

  it("allows a self-relation across two properties of one database", () => {
    const self = createRelationPair({
      a: { databaseId: dbA, propertyId: "p1" },
      b: { databaseId: dbA, propertyId: "p2" },
    });
    expect(self.a.config.targetDatabaseId).toBe(dbA);
    expect(self.b.config.inversePropertyId).toBe(self.a.id);
  });

  it("rejects blank ids and pairing a property with itself", () => {
    expect(() =>
      createRelationPair({
        a: { databaseId: "", propertyId: "x" },
        b: { databaseId: dbB, propertyId: "y" },
      }),
    ).toThrow();
    expect(() =>
      createRelationPair({
        a: { databaseId: dbA, propertyId: "x" },
        b: { databaseId: dbB, propertyId: "  " },
      }),
    ).toThrow();
    expect(() =>
      createRelationPair({
        a: { databaseId: dbA, propertyId: "same" },
        b: { databaseId: dbA, propertyId: "same" },
      }),
    ).toThrow();
  });
});

describe("linkRows", () => {
  it("links both sides and reports the inverse links", () => {
    const p = pair();
    const result = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b2"], pairId: p.id });
    expect(result.state.links["a-rel"].a1).toEqual(["b1", "b2"]);
    expect(result.state.links["b-rel"].b1).toEqual(["a1"]);
    expect(result.state.links["b-rel"].b2).toEqual(["a1"]);
    expect(result.inverseLinks).toEqual([
      { propertyId: "b-rel", rowId: "b1", targetIds: ["a1"] },
      { propertyId: "b-rel", rowId: "b2", targetIds: ["a1"] },
    ]);
  });

  it("de-duplicates repeated target ids", () => {
    const p = pair();
    const result = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b1", "b1"], pairId: p.id });
    expect(result.state.links["a-rel"].a1).toEqual(["b1"]);
  });

  it("appends to an existing multi link and is idempotent", () => {
    const p = pair();
    const first = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id });
    const second = linkRows(first.state, { fromId: "a1", toIds: ["b2"], pairId: p.id });
    expect(second.state.links["a-rel"].a1).toEqual(["b1", "b2"]);
    const again = linkRows(second.state, { fromId: "a1", toIds: ["b2"], pairId: p.id });
    expect(again.state.links["a-rel"].a1).toEqual(["b1", "b2"]);
    expect(again.state.links["b-rel"].b2).toEqual(["a1"]);
  });

  it("clamps a single relation to the first target", () => {
    const p = pairOne();
    const result = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b2"], pairId: p.id });
    expect(result.state.links["a-one"].a1).toEqual(["b1"]);
    expect(result.state.links["b-one"].b1).toEqual(["a1"]);
    expect(result.state.links["b-one"].b2).toBeUndefined();
  });

  it("replaces the prior link on the source side for a single relation", () => {
    const p = pairOne();
    const first = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id });
    const second = linkRows(first.state, { fromId: "a1", toIds: ["b2"], pairId: p.id });
    expect(second.state.links["a-one"].a1).toEqual(["b2"]);
    expect(second.state.links["b-one"].b1).toBeUndefined();
    expect(second.state.links["b-one"].b2).toEqual(["a1"]);
  });

  it("replaces a prior link on the inverse side for a single relation", () => {
    const p = pairOne();
    const first = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id });
    const second = linkRows(first.state, { fromId: "a2", toIds: ["b1"], pairId: p.id });
    expect(second.state.links["a-one"].a1).toBeUndefined();
    expect(second.state.links["a-one"].a2).toEqual(["b1"]);
    expect(second.state.links["b-one"].b1).toEqual(["a2"]);
  });

  it("resolves the side from the row's database and writes the reciprocal pair", () => {
    const p = pair();
    const result = linkRows(baseState(), { fromId: "b1", toIds: ["a1", "a2"], pairId: p.id });
    expect(result.state.links["b-rel"].b1).toEqual(["a1", "a2"]);
    expect(result.state.links["a-rel"].a1).toEqual(["b1"]);
    expect(result.state.links["a-rel"].a2).toEqual(["b1"]);
    expect(result.inverseLinks).toEqual([
      { propertyId: "a-rel", rowId: "a1", targetIds: ["b1"] },
      { propertyId: "a-rel", rowId: "a2", targetIds: ["b1"] },
    ]);
  });

  it("drops a self-link", () => {
    const p = pair();
    const result = linkRows(baseState(), { fromId: "a1", toIds: ["a1", "b1"], pairId: p.id });
    expect(result.state.links["a-rel"].a1).toEqual(["b1"]);
  });

  it("treats an empty target list as a no-op for a multi relation", () => {
    const p = pair();
    const first = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id });
    const cleared = linkRows(first.state, { fromId: "a1", toIds: [], pairId: p.id });
    expect(cleared.state.links["a-rel"].a1).toEqual(["b1"]);
    expect(cleared.state.links["b-rel"].b1).toEqual(["a1"]);
  });

  it("clears a single relation when linked to an empty target list", () => {
    const p = pairOne();
    const first = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id });
    const cleared = linkRows(first.state, { fromId: "a1", toIds: [], pairId: p.id });
    expect(cleared.state.links["a-one"]?.a1).toBeUndefined();
    expect(cleared.state.links["b-one"]?.b1).toBeUndefined();
  });

  it("is a no-op for an unknown pair", () => {
    const state = baseState();
    const result = linkRows(state, { fromId: "a1", toIds: ["b1"], pairId: "missing" });
    expect(result.state.links).toEqual({});
    expect(result.inverseLinks).toEqual([]);
  });

  it("links rows the state does not know about", () => {
    const p = pair();
    const sparse = createRelationState({ pairs: [p] });
    const result = linkRows(sparse, { fromId: "a1", toIds: ["b1"], pairId: p.id });
    expect(result.state.links["a-rel"].a1).toEqual(["b1"]);
  });

  it("never mutates the input state", () => {
    const state = baseState();
    const snapshot = JSON.stringify(state.links);
    linkRows(state, { fromId: "a1", toIds: ["b1"], pairId: pair().id });
    expect(JSON.stringify(state.links)).toBe(snapshot);
  });
});

describe("unlinkRows", () => {
  it("removes a link from both sides and reports the inverse", () => {
    const p = pair();
    const linked = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b2"], pairId: p.id });
    const result = unlinkRows(linked.state, { fromId: "a1", toIds: ["b1"], pairId: p.id });
    expect(result.state.links["a-rel"].a1).toEqual(["b2"]);
    expect(result.state.links["b-rel"].b1).toBeUndefined();
    expect(result.state.links["b-rel"].b2).toEqual(["a1"]);
    expect(result.inverseLinks).toEqual([
      { propertyId: "b-rel", rowId: "b1", targetIds: [] },
    ]);
  });

  it("removes every link when no targets are given", () => {
    const p = pair();
    let state = linkRows(baseState(), { fromId: "a1", toIds: ["b1"], pairId: p.id }).state;
    state = linkRows(state, { fromId: "a1", toIds: ["b2"], pairId: p.id }).state;
    const result = unlinkRows(state, { fromId: "a1", pairId: p.id });
    expect(result.state.links["a-rel"]?.a1).toBeUndefined();
    expect(result.state.links["b-rel"]?.b1).toBeUndefined();
    expect(result.state.links["b-rel"]?.b2).toBeUndefined();
  });

  it("is a no-op for an unknown pair and never mutates", () => {
    const state = baseState();
    const snapshot = JSON.stringify(state.links);
    const result = unlinkRows(state, { fromId: "a1", toIds: ["b1"], pairId: "missing" });
    expect(result.state.links).toEqual({});
    expect(JSON.stringify(state.links)).toBe(snapshot);
  });
});

describe("symmetricPairs", () => {
  it("returns each mutually-linked edge once", () => {
    const p = pair();
    let state = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b2"], pairId: p.id }).state;
    state = linkRows(state, { fromId: "a2", toIds: ["b1"], pairId: p.id }).state;
    expect(symmetricPairs(state, p.id)).toEqual([
      { aRowId: "a1", bRowId: "b1", aPropertyId: "a-rel", bPropertyId: "b-rel" },
      { aRowId: "a1", bRowId: "b2", aPropertyId: "a-rel", bPropertyId: "b-rel" },
      { aRowId: "a2", bRowId: "b1", aPropertyId: "a-rel", bPropertyId: "b-rel" },
    ]);
  });

  it("reports nothing when only one direction is stored", () => {
    const p = pair();
    const oneSided = createRelationState({
      pairs: [p],
      rows,
      links: { "a-rel": { a1: ["b1"] } },
    });
    expect(symmetricPairs(oneSided, p.id)).toEqual([]);
    const otherSided = createRelationState({
      pairs: [p],
      rows,
      links: { "b-rel": { b1: ["a1"] } },
    });
    expect(symmetricPairs(otherSided, p.id)).toEqual([]);
  });

  it("de-duplicates repeated stored ids and ignores an unknown pair", () => {
    const p = pair();
    const state = createRelationState({
      pairs: [p],
      rows,
      links: { "a-rel": { a1: ["b1", "b1"] }, "b-rel": { b1: ["a1", "a1"] } },
    });
    expect(symmetricPairs(state, p.id)).toEqual([
      { aRowId: "a1", bRowId: "b1", aPropertyId: "a-rel", bPropertyId: "b-rel" },
    ]);
    expect(symmetricPairs(state, "missing")).toEqual([]);
  });
});

describe("setRollupConfig", () => {
  it("accepts every catalogued rollup function and trims ids", () => {
    expect(ROLLUP_FUNCTIONS.map((fn) => fn.id)).toEqual([
      "count",
      "sum",
      "average",
      "min",
      "max",
      "median",
      "join",
      "unique",
      "checked",
      "percentEmpty",
    ]);
    for (const fn of ROLLUP_FUNCTIONS) {
      const config = setRollupConfig({
        relationPropertyId: " a-rel ",
        targetPropertyId: " score ",
        fn: fn.id,
      });
      expect(config.fn).toBe(fn.id);
      expect(config.relationPropertyId).toBe("a-rel");
      expect(config.targetPropertyId).toBe("score");
    }
  });

  it("defaults and overrides the join separator", () => {
    expect(setRollupConfig({ relationPropertyId: "r", targetPropertyId: "t", fn: "join" }).separator).toBe(
      ", ",
    );
    expect(
      setRollupConfig({ relationPropertyId: "r", targetPropertyId: "t", fn: "join", separator: " | " })
        .separator,
    ).toBe(" | ");
  });

  it("rejects unknown functions and missing ids", () => {
    expect(() =>
      setRollupConfig({ relationPropertyId: "r", targetPropertyId: "t", fn: "bogus" }),
    ).toThrow();
    expect(() => setRollupConfig({ relationPropertyId: "", targetPropertyId: "t", fn: "sum" })).toThrow();
    expect(() =>
      setRollupConfig({ relationPropertyId: "r", targetPropertyId: "   ", fn: "sum" }),
    ).toThrow();
  });
});

describe("describeRollup", () => {
  it("renders the function, target and relation", () => {
    const config = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "average" });
    expect(describeRollup(config)).toBe("Average of score via a-rel");
  });

  it("mentions the separator for a join", () => {
    const config = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "name", fn: "join" });
    expect(describeRollup(config)).toBe('Join of name via a-rel (separated by ", ")');
  });
});

function rollupState(linked: string[]): RelationState {
  const p = pair();
  return createRelationState({ pairs: [p], rows, links: { "a-rel": { a1: linked } } });
}

describe("computeRollup", () => {
  it("computes numeric aggregates over the linked rows", () => {
    const state = rollupState(["b1", "b2"]);
    const sum = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "sum" });
    const average = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "average" });
    const min = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "min" });
    const max = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "max" });
    const median = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "median" });
    expect(computeRollup(state, "a1", sum)).toEqual({ value: 30, type: "number", empty: false });
    expect(computeRollup(state, "a1", average)).toEqual({ value: 15, type: "number", empty: false });
    expect(computeRollup(state, "a1", min)).toEqual({ value: 10, type: "number", empty: false });
    expect(computeRollup(state, "a1", max)).toEqual({ value: 20, type: "number", empty: false });
    expect(computeRollup(state, "a1", median)).toEqual({ value: 15, type: "number", empty: false });
  });

  it("counts linked rows and ignores blanks for numeric math", () => {
    const state = rollupState(["b1", "b2", "b3"]);
    const count = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "count" });
    const sum = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "sum" });
    expect(computeRollup(state, "a1", count)).toEqual({ value: 3, type: "number", empty: false });
    expect(computeRollup(state, "a1", sum)).toEqual({ value: 30, type: "number", empty: false });
  });

  it("returns null with empty=true for an empty relation set", () => {
    const state = rollupState([]);
    const sum = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "sum" });
    const count = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "score", fn: "count" });
    const join = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "name", fn: "join" });
    expect(computeRollup(state, "a1", sum)).toEqual({ value: null, type: "number", empty: true });
    expect(computeRollup(state, "a1", count)).toEqual({ value: 0, type: "number", empty: true });
    expect(computeRollup(state, "a1", join)).toEqual({ value: null, type: "string", empty: true });
  });

  it("computes percentEmpty over all linked cells", () => {
    const percent = setRollupConfig({
      relationPropertyId: "a-rel",
      targetPropertyId: "score",
      fn: "percentEmpty",
    });
    expect(computeRollup(rollupState(["b1", "b2"]), "a1", percent)).toEqual({
      value: 0,
      type: "number",
      empty: false,
    });
    expect(computeRollup(rollupState(["b1", "b2", "b3"]), "a1", percent)).toEqual({
      value: 33,
      type: "number",
      empty: false,
    });
    expect(computeRollup(rollupState([]), "a1", percent)).toEqual({
      value: 0,
      type: "number",
      empty: true,
    });
  });

  it("computes unique and checked", () => {
    const state = rollupState(["b1", "b2", "b3"]);
    const unique = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "name", fn: "unique" });
    const checked = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "done", fn: "checked" });
    expect(computeRollup(state, "a1", unique)).toEqual({ value: 2, type: "number", empty: false });
    expect(computeRollup(state, "a1", checked)).toEqual({ value: 1, type: "number", empty: false });
  });

  it("joins present values with the configured separator", () => {
    const state = rollupState(["b1", "b2", "b3"]);
    const join = setRollupConfig({ relationPropertyId: "a-rel", targetPropertyId: "name", fn: "join" });
    const piped = setRollupConfig({
      relationPropertyId: "a-rel",
      targetPropertyId: "name",
      fn: "join",
      separator: " | ",
    });
    expect(computeRollup(state, "a1", join)).toEqual({ value: "Beta, Gamma", type: "string", empty: false });
    expect(computeRollup(state, "a1", piped)).toEqual({ value: "Beta | Gamma", type: "string", empty: false });
  });
});

describe("validateRelationPair", () => {
  it("accepts a well-formed, mutually linked pair", () => {
    const p = pair();
    const linked = linkRows(baseState(), { fromId: "a1", toIds: ["b1", "b2"], pairId: p.id }).state;
    expect(validateRelationPair(linked, p)).toEqual([]);
  });

  it("flags a pair that is not registered in the state", () => {
    const p = pair();
    expect(codesOf(validateRelationPair(createRelationState({}), p))).toContain("PAIR_NOT_IN_STATE");
  });

  it("flags non-reciprocal inverse metadata", () => {
    const p = pair();
    const broken = {
      ...p,
      a: { ...p.a, config: { ...p.a.config, inversePropertyId: "wrong" } },
    };
    expect(codesOf(validateRelationPair(createRelationState({ pairs: [broken] }), broken))).toContain(
      "INVERSE_NOT_RECIPROCAL",
    );
  });

  it("flags a target database mismatch", () => {
    const p = pair();
    const broken = {
      ...p,
      a: { ...p.a, config: { ...p.a.config, targetDatabaseId: "db-x" } },
    };
    expect(codesOf(validateRelationPair(createRelationState({ pairs: [broken] }), broken))).toContain(
      "TARGET_DATABASE_MISMATCH",
    );
  });

  it("flags cardinality that disagrees with the multi flag", () => {
    const p = pair();
    const broken = { ...p, a: { ...p.a, config: { ...p.a.config, multi: false } } };
    expect(codesOf(validateRelationPair(createRelationState({ pairs: [broken] }), broken))).toContain(
      "CARDINALITY_MISMATCH",
    );
  });

  it("flags an asymmetric link", () => {
    const p = pair();
    const oneSided = createRelationState({
      pairs: [p],
      rows,
      links: { "a-rel": { a1: ["b1"] } },
    });
    expect(codesOf(validateRelationPair(oneSided, p))).toContain("ASYMMETRIC_LINK");
  });

  it("flags a single-cardinality link that holds more than one target", () => {
    const p = pairOne();
    const state = createRelationState({
      pairs: [p],
      rows,
      links: { "a-one": { a1: ["b1", "b2"] }, "b-one": { b1: ["a1"], b2: ["a1"] } },
    });
    expect(codesOf(validateRelationPair(state, p))).toContain("CARDINALITY_MISMATCH");
  });
});
