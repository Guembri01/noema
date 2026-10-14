import { describe, expect, it } from "vitest";
import {
  collectBlocks,
  copyReference,
  detectReferenceCycles,
  extractReferences,
  missingReferences,
  replaceSyncedMirrors,
  resolveSynced,
  type Block,
} from "./block-refs";

/** A plain block; `children` only added when given so snapshots stay exact. */
const b = (id: string, type = "paragraph", children?: Block[]): Block =>
  children ? { id, type, children } : { id, type };

/** A reference block holding a singular `refBlockId`. */
const ref = (id: string, refBlockId: string): Block => ({ id, type: "block_ref", refBlockId });

/** A reference block holding an array `refBlockIds`. */
const refMulti = (id: string, refBlockIds: string[]): Block => ({
  id,
  type: "block_ref",
  refBlockIds,
});

describe("collectBlocks", () => {
  const doc: Block[] = [b("a", "page", [b("a1", "paragraph", [b("a1x")]), b("a2")]), b("b")];

  it("indexes every block by id in document order", () => {
    const { byId } = collectBlocks(doc);
    expect([...byId.keys()]).toEqual(["a", "a1", "a1x", "a2", "b"]);
    expect(byId.get("a1x")?.id).toBe("a1x");
  });

  it("records each block's parent, null for roots", () => {
    const { parentOf } = collectBlocks(doc);
    expect(parentOf.get("a")).toBeNull();
    expect(parentOf.get("b")).toBeNull();
    expect(parentOf.get("a1")).toBe("a");
    expect(parentOf.get("a1x")).toBe("a1");
    expect(parentOf.get("a2")).toBe("a");
    expect(parentOf.has("nope")).toBe(false);
  });

  it("keeps the first block when ids collide", () => {
    const { byId } = collectBlocks([b("a"), b("a", "heading")]);
    expect(byId.size).toBe(1);
    expect(byId.get("a")?.type).toBe("paragraph");
  });

  it("returns empty structures for an empty doc", () => {
    const { byId, parentOf } = collectBlocks([]);
    expect(byId.size).toBe(0);
    expect(parentOf.size).toBe(0);
  });
});

describe("extractReferences", () => {
  it("returns nothing when no block references another", () => {
    expect(extractReferences([b("a", "page", [b("b")])])).toEqual([]);
  });

  it("reads a singular refBlockId", () => {
    expect(extractReferences([b("a"), ref("r", "a")])).toEqual([
      { blockId: "r", refBlockIds: ["a"] },
    ]);
  });

  it("reads an array refBlockIds", () => {
    expect(extractReferences([refMulti("r", ["a", "b", "c"])])).toEqual([
      { blockId: "r", refBlockIds: ["a", "b", "c"] },
    ]);
  });

  it("merges refBlockId and refBlockIds, deduping", () => {
    const doc: Block[] = [{ id: "r", type: "block_ref", refBlockId: "a", refBlockIds: ["a", "b"] }];
    expect(extractReferences(doc)).toEqual([{ blockId: "r", refBlockIds: ["a", "b"] }]);
  });

  it("walks nested blocks in document order", () => {
    const doc = [b("a", "page", [ref("r1", "a"), b("x", "page", [refMulti("r2", ["a", "x"])])])];
    expect(extractReferences(doc)).toEqual([
      { blockId: "r1", refBlockIds: ["a"] },
      { blockId: "r2", refBlockIds: ["a", "x"] },
    ]);
  });
});

describe("resolveSynced", () => {
  const source: Block = {
    id: "a",
    type: "page",
    children: [{ id: "a1", type: "paragraph", text: "hi" }],
  };
  const doc = [source, b("b")];

  it("returns a deep clone equal to the subtree", () => {
    const resolved = resolveSynced(doc, "a");
    expect(resolved).toEqual(source);
    expect(resolved).not.toBe(source);
    expect(resolved?.children?.[0]).not.toBe(source.children?.[0]);
  });

  it("is independent: mutating the clone leaves the doc untouched", () => {
    const resolved = resolveSynced(doc, "a")!;
    resolved.children![0].text = "changed";
    resolved.children!.push({ id: "a2", type: "paragraph" });
    expect(source.children).toHaveLength(1);
    expect(source.children?.[0].text).toBe("hi");
  });

  it("returns null for an unknown id", () => {
    expect(resolveSynced(doc, "missing")).toBeNull();
  });

  it("clones a leaf without children", () => {
    const leaf = resolveSynced(doc, "b");
    expect(leaf).toEqual({ id: "b", type: "paragraph" });
    expect(leaf).not.toBe(doc[1]);
  });
});

describe("detectReferenceCycles", () => {
  it("reports a self reference", () => {
    expect(detectReferenceCycles([ref("a", "a")])).toEqual([["a", "a"]]);
  });

  it("reports a two-node cycle", () => {
    expect(detectReferenceCycles([ref("a", "b"), ref("b", "a")])).toEqual([["a", "b", "a"]]);
  });

  it("reports a longer cycle", () => {
    const doc = [ref("a", "b"), ref("b", "c"), ref("c", "a")];
    expect(detectReferenceCycles(doc)).toEqual([["a", "b", "c", "a"]]);
  });

  it("does not mistake a diamond for a cycle", () => {
    const doc = [ref("a", "b"), ref("a", "c"), ref("b", "d"), ref("c", "d"), b("d")];
    expect(detectReferenceCycles(doc)).toEqual([]);
  });

  it("dedupes the same cycle reached from several ids", () => {
    const doc = [ref("a", "b"), ref("b", "a"), ref("c", "a")];
    expect(detectReferenceCycles(doc)).toEqual([["a", "b", "a"]]);
  });

  it("reports each independent cycle, smallest id first", () => {
    expect(detectReferenceCycles([ref("b", "b"), ref("a", "a")])).toEqual([
      ["a", "a"],
      ["b", "b"],
    ]);
  });

  it("ignores dangling references", () => {
    expect(detectReferenceCycles([ref("a", "ghost")])).toEqual([]);
  });

  it("detects cycles through nested blocks", () => {
    const doc = [b("p", "page", [ref("a", "b")]), ref("b", "a")];
    expect(detectReferenceCycles(doc)).toEqual([["a", "b", "a"]]);
  });
});

describe("replaceSyncedMirrors", () => {
  const updated: Block = {
    id: "s",
    type: "page",
    children: [{ id: "s1", type: "paragraph" }],
  };

  it("replaces every mirror with a clone of the updated subtree", () => {
    const doc = [b("s"), ref("m1", "s"), b("x", "page", [ref("m2", "s")])];
    expect(replaceSyncedMirrors(doc, "s", updated)).toEqual([
      { id: "s", type: "paragraph" },
      { id: "s", type: "page", children: [{ id: "s1", type: "paragraph" }] },
      {
        id: "x",
        type: "page",
        children: [{ id: "s", type: "page", children: [{ id: "s1", type: "paragraph" }] }],
      },
    ]);
  });

  it("leaves the input doc untouched", () => {
    const doc = [b("s"), ref("m1", "s")];
    const snapshot = JSON.parse(JSON.stringify(doc)) as Block[];
    const out = replaceSyncedMirrors(doc, "s", updated);
    expect(doc).toEqual(snapshot);
    expect(doc[1]).toEqual({ id: "m1", type: "block_ref", refBlockId: "s" });
    expect(out).not.toBe(doc);
    expect(out[1]).not.toBe(updated);
  });

  it("gives each mirror its own deep copy", () => {
    const doc = [b("s"), ref("m1", "s"), ref("m2", "s")];
    const out = replaceSyncedMirrors(doc, "s", updated);
    expect(out[1]).toEqual(out[2]);
    expect(out[1]).not.toBe(out[2]);
    out[1].children!.push({ id: "extra", type: "paragraph" });
    expect(out[2].children).toHaveLength(1);
    expect(updated.children).toHaveLength(1);
  });

  it("uses the updated subtree's ids, not the stale ones", () => {
    const doc = [b("s"), ref("m", "s")];
    const fresh: Block = { id: "s2", type: "page", children: [{ id: "s2a", type: "paragraph" }] };
    const out = replaceSyncedMirrors(doc, "s", fresh);
    expect(out[1].id).toBe("s2");
    expect(out[1].children?.[0].id).toBe("s2a");
  });

  it("matches references declared in a refBlockIds array", () => {
    const doc = [b("s"), refMulti("m", ["x", "s"])];
    expect(replaceSyncedMirrors(doc, "s", { id: "s", type: "page" })[1]).toEqual({
      id: "s",
      type: "page",
    });
  });

  it("is a no-op when the source is missing", () => {
    const doc = [ref("m", "ghost"), b("x")];
    const out = replaceSyncedMirrors(doc, "ghost", { id: "ghost", type: "page" });
    expect(out).toEqual(doc);
    expect(out).not.toBe(doc);
    expect(out[0]).not.toBe(doc[0]);
  });
});

describe("copyReference", () => {
  const doc: Block[] = [{ id: "s", type: "page", children: [{ id: "s1", type: "paragraph" }] }];

  it("returns a block_ref node pointing at the source", () => {
    const { ref: node } = copyReference(doc, "s");
    expect(node.type).toBe("block_ref");
    expect(node.refBlockId).toBe("s");
    expect(typeof node.id).toBe("string");
    expect(node.id).not.toBe("s");
  });

  it("returns an independent deep clone of the source subtree", () => {
    const { subtree } = copyReference(doc, "s");
    expect(subtree).toEqual(doc[0]);
    expect(subtree).not.toBe(doc[0]);
    subtree!.children![0].type = "heading";
    expect(doc[0].children?.[0].type).toBe("paragraph");
  });

  it("returns a null subtree for a missing source", () => {
    const copy = copyReference(doc, "nope");
    expect(copy.subtree).toBeNull();
    expect(copy.ref.refBlockId).toBe("nope");
  });
});

describe("missingReferences", () => {
  it("lists referenced ids that do not exist, sorted", () => {
    const doc = [b("a"), ref("r1", "a"), ref("r2", "ghost"), refMulti("r3", ["ghost", "other"])];
    expect(missingReferences(doc)).toEqual(["ghost", "other"]);
  });

  it("dedupes repeated dangling ids", () => {
    expect(missingReferences([ref("r1", "ghost"), ref("r2", "ghost")])).toEqual(["ghost"]);
  });

  it("returns nothing when every reference resolves", () => {
    expect(missingReferences([b("a"), ref("r", "a")])).toEqual([]);
  });
});
