import { describe, expect, it } from "vitest";
import { dropVerdict } from "@/components/editor/drop-rejection";

/**
 * The invalid-drop decision behind the editor's rejection indicator. Pure and
 * id-only, so the four shapes the editor cares about — a legal neighbour, a
 * self-drop, a drop inside a descendant, and a pointer with no block under it —
 * are pinned here instead of by watching the drag in a browser.
 */

const SUBTREE = ["child", "grandchild"];

describe("dropVerdict", () => {
  it("accepts a neighbouring block as a valid target", () => {
    expect(dropVerdict({ draggingId: "a", targetId: "b", descendants: SUBTREE })).toEqual({
      valid: true,
      reason: "ok",
    });
  });

  it("accepts a valid target even with a populated subtree", () => {
    expect(
      dropVerdict({
        draggingId: "a",
        targetId: "sibling",
        targetParentId: "parent",
        descendants: SUBTREE,
      }),
    ).toEqual({ valid: true, reason: "ok" });
  });

  it("rejects dropping a block onto itself", () => {
    expect(
      dropVerdict({ draggingId: "a", targetId: "a", descendants: SUBTREE }),
    ).toEqual({ valid: false, reason: "self" });
  });

  it("rejects dropping a block into its own descendant", () => {
    expect(dropVerdict({ draggingId: "a", targetId: "grandchild", descendants: SUBTREE })).toEqual({
      valid: false,
      reason: "descendant",
    });
  });

  it("rejects a target whose parent is inside the dragged subtree", () => {
    expect(
      dropVerdict({
        draggingId: "a",
        targetId: "nested",
        targetParentId: "child",
        descendants: SUBTREE,
      }),
    ).toEqual({ valid: false, reason: "descendant" });
  });

  it("rejects a drop with no block under the pointer", () => {
    expect(dropVerdict({ draggingId: "a", targetId: null })).toEqual({
      valid: false,
      reason: "missing-target",
    });
    expect(dropVerdict({ draggingId: "a" })).toEqual({
      valid: false,
      reason: "missing-target",
    });
    expect(dropVerdict({ draggingId: "a", targetId: "   " })).toEqual({
      valid: false,
      reason: "missing-target",
    });
  });

  it("is idle (no rejection) when no block is being dragged", () => {
    expect(dropVerdict({ targetId: "b" })).toEqual({ valid: true, reason: "idle" });
    expect(dropVerdict({ draggingId: null, targetId: "b" })).toEqual({
      valid: true,
      reason: "idle",
    });
    expect(dropVerdict({ draggingId: "  ", targetId: "b" })).toEqual({
      valid: true,
      reason: "idle",
    });
  });

  it("ignores blank descendant ids", () => {
    expect(
      dropVerdict({ draggingId: "a", targetId: "b", descendants: ["", "  ", "child"] }),
    ).toEqual({ valid: true, reason: "ok" });
  });
});
