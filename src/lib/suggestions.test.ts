import { describe, expect, it } from "vitest";
import {
  applyOne,
  applySuggestions,
  createSuggestions,
  deserialize,
  filterByAuthor,
  pendingCount,
  serialize,
  type Block,
  type Suggestion,
} from "./suggestions";

/**
 * B-? — block-level Suggestions mode (docs/MISSING_FEATURES.md §7, "Suggestions
 * mode" / "Accept/reject suggestion", read-only "propose edits for approval").
 *
 * Red-first: this file was written BEFORE `src/lib/suggestions.ts` existed, so
 * the whole suite failed at import (module-not-found). After the implementation
 * the suite is green. Pure logic only — no DB, routes, or React.
 *
 * Model: a `Suggestion` is one block-level edit (`insert` / `delete` /
 * `replace`) matched by block id. `applySuggestions` accepts or rejects the
 * whole ordered edit list and is immutable; accept-all reconstructs the proposed
 * document and reject-all reconstructs the base document, order-stable.
 */

const a: Block = { id: "a", type: "paragraph", text: "Alpha" };
const b: Block = { id: "b", type: "paragraph", text: "Bravo" };
const c: Block = { id: "c", type: "paragraph", text: "Charlie" };
const x: Block = { id: "x", type: "paragraph", text: "Inserted" };
const y: Block = { id: "y", type: "paragraph", text: "Appended" };
const b2: Block = { id: "b", type: "paragraph", text: "Bravo edited" };
const c2: Block = { id: "c", type: "paragraph", text: "Charlie edited" };

const byId = (list: readonly Suggestion[]): Map<string, Suggestion> =>
  new Map(list.map((suggestion) => [suggestion.blockId, suggestion]));

describe("createSuggestions — edit detection", () => {
  it("detects inserts, deletes and replaces and carries before/after", () => {
    const edits = createSuggestions([a, b, c], [a, x, b2], { authorId: "u1" });

    expect(edits).toHaveLength(3);
    const map = byId(edits);

    const insert = map.get("x");
    expect(insert?.kind).toBe("insert");
    expect(insert?.after).toEqual(x);
    expect(insert?.before).toEqual(a); // anchor: nearest surviving block before it
    expect(insert?.before?.id).toBe("a");

    const replace = map.get("b");
    expect(replace?.kind).toBe("replace");
    expect(replace?.before).toEqual(b);
    expect(replace?.after).toEqual(b2);

    const remove = map.get("c");
    expect(remove?.kind).toBe("delete");
    expect(remove?.before).toEqual(c);
    expect(remove?.after).toBeUndefined();

    expect(edits.every((suggestion) => suggestion.authorId === "u1")).toBe(true);
  });

  it("emits nothing for unchanged documents", () => {
    expect(createSuggestions([a, b, c], [{ ...a }, { ...b }, { ...c }])).toEqual([]);
    expect(createSuggestions([a], [a])).toEqual([]);
    expect(createSuggestions([], [])).toEqual([]);
  });

  it("treats a type-only change as a replace too", () => {
    const heading: Block = { id: "a", type: "heading", text: "Alpha" };
    const edits = createSuggestions([a], [heading]);
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("replace");
    expect(edits[0].after).toEqual(heading);
  });

  it("orders the edit list in document order", () => {
    const edits = createSuggestions([a, b, c], [a, x, b2]);
    expect(edits.map((suggestion) => suggestion.kind)).toEqual([
      "insert",
      "replace",
      "delete",
    ]);
  });

  it("ignores pure reordering (no move kind exists)", () => {
    expect(createSuggestions([a, b], [b, a])).toEqual([]);
  });
});

describe("applySuggestions — accept / reject", () => {
  const proposed = [a, x, b2];

  it("accept-all reconstructs the proposed document (order-stable)", () => {
    const edits = createSuggestions([a, b, c], proposed);
    const result = applySuggestions([a, b, c], edits, "accept");
    expect(result).toEqual(proposed);
    expect(result.map((block) => block.id)).toEqual(["a", "x", "b"]);
  });

  it("reject-all reconstructs the base document (order-stable)", () => {
    const base = [a, b, c];
    const edits = createSuggestions(base, proposed);
    const result = applySuggestions(base, edits, "reject");
    expect(result).toEqual(base);
    expect(result.map((block) => block.id)).toEqual(["a", "b", "c"]);
  });

  it("handles simultaneous add + remove", () => {
    const base = [a, b];
    const target = [x, b];
    const edits = createSuggestions(base, target);
    expect(applySuggestions(base, edits, "accept")).toEqual(target);
    expect(applySuggestions(base, edits, "reject")).toEqual(base);
  });

  it("round-trips a mixed multi-suggestion document", () => {
    const base = [a, b, c];
    // b deleted, x inserted after a, c edited, y appended after c.
    const target = [a, x, c2, y];
    const edits = createSuggestions(base, target);
    expect(edits).toHaveLength(4);
    expect(applySuggestions(base, edits, "accept")).toEqual(target);
    expect(applySuggestions(base, edits, "reject")).toEqual(base);
  });

  it("anchors an insert at the start when nothing survives before it", () => {
    const edits = createSuggestions([a, b], [x, a, b]);
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("insert");
    expect(edits[0].before).toBeUndefined();
    expect(applySuggestions([a, b], edits, "accept")).toEqual([x, a, b]);
  });

  it("anchors an append to the final surviving block", () => {
    const edits = createSuggestions([a, b], [a, b, y]);
    expect(edits[0].before?.id).toBe("b");
    expect(applySuggestions([a, b], edits, "accept")).toEqual([a, b, y]);
  });
});

describe("applySuggestions — purity", () => {
  it("does not mutate the input blocks or suggestions", () => {
    const base = [a, b, c];
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    const proposed = [a, x, b2];
    const edits = createSuggestions(base, proposed);
    const editsSnapshot = JSON.parse(JSON.stringify(edits));

    applySuggestions(base, edits, "accept");
    applySuggestions(base, edits, "reject");

    expect(base).toEqual(baseSnapshot);
    expect(edits).toEqual(editsSnapshot);
  });

  it("returns a fresh array rather than the input reference", () => {
    const base = [a, b];
    const reject = applySuggestions(base, [], "reject");
    const accept = applySuggestions(base, [], "accept");
    expect(reject).not.toBe(base);
    expect(accept).not.toBe(base);
  });
});

describe("applyOne — single suggestion", () => {
  it("applies just one insert / replace / delete", () => {
    const base = [a, b, c];
    const edits = createSuggestions(base, [a, x, b2]);
    const map = byId(edits);

    expect(applyOne(base, map.get("x")!, "accept")).toEqual([a, x, b, c]);
    expect(applyOne(base, map.get("b")!, "accept")).toEqual([a, b2, c]);
    expect(applyOne(base, map.get("c")!, "accept")).toEqual([a, b]);
  });

  it("rejecting a single suggestion is a no-op", () => {
    const base = [a, b, c];
    const edits = createSuggestions(base, [a, x, b2]);
    expect(applyOne(base, edits[0], "reject")).toEqual(base);
  });
});

describe("pendingCount / filterByAuthor", () => {
  it("counts every unresolved suggestion", () => {
    expect(pendingCount([])).toBe(0);
    const edits = createSuggestions([a, b, c], [a, x, b2]);
    expect(pendingCount(edits)).toBe(3);
    expect(pendingCount(edits.filter((suggestion) => suggestion.kind !== "delete"))).toBe(2);
  });

  it("filters by author id and supports anonymous suggestions", () => {
    const mine = createSuggestions([a, b], [a, x, b2], { authorId: "u1" });
    const theirs = createSuggestions([a, b], [x, b], { authorId: "u2" });
    const anon = createSuggestions([a, b], [a, b, y]);
    const all = [...mine, ...theirs, ...anon];

    expect(filterByAuthor(all, "u1")).toEqual(mine);
    expect(filterByAuthor(all, "u2")).toEqual(theirs);
    expect(filterByAuthor(all, "u3")).toEqual([]);
    expect(filterByAuthor(all, undefined)).toEqual(anon);
    expect(filterByAuthor(all, null)).toEqual(anon);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips the full edit list through JSON", () => {
    const edits = createSuggestions([a, b, c], [a, x, b2], { authorId: "u1" });
    const json = serialize(edits);
    expect(typeof json).toBe("string");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(deserialize(json)).toEqual(edits);
  });

  it("is stable and defensive against malformed input", () => {
    const edits = createSuggestions([a, b], [a, b, y]);
    expect(serialize(edits)).toBe(serialize(edits));
    expect(deserialize("not json")).toEqual([]);
    expect(deserialize("{}")).toEqual([]);
    expect(deserialize("[]")).toEqual([]);
  });
});

describe("deterministic ids", () => {
  it("derives stable ids from kind + blockId by default", () => {
    const first = createSuggestions([a, b, c], [a, x, b2]);
    const second = createSuggestions([a, b, c], [a, x, b2]);
    expect(first.map((suggestion) => suggestion.id)).toEqual(
      second.map((suggestion) => suggestion.id),
    );
    expect(first.map((suggestion) => suggestion.id)).toEqual([
      "insert:x",
      "replace:b",
      "delete:c",
    ]);
  });

  it("accepts a custom id factory", () => {
    const edits = createSuggestions([a], [x], {
      idFactory: (kind, blockId) => `sug-${kind}-${blockId}`,
    });
    expect(edits[0].id).toBe("sug-insert-x");
  });
});
