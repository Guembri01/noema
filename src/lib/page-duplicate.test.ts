import { describe, expect, it, vi } from "vitest";
import {
  defaultIdFactory,
  planPageDuplicate,
  validatePageDuplicate,
} from "@/lib/page-duplicate";
import type { IdFactory, PageDuplicatePlan, PageNode } from "@/lib/page-duplicate";

/** Deterministic factory: `new-1`, `new-2`, … in allocation order. */
function seqFactory(start = 1): IdFactory {
  let n = start - 1;
  return () => {
    n += 1;
    return `new-${n}`;
  };
}

/**
 * A small page tree. Input order is deliberately *not* topologically sorted
 * (`p-a1` follows its parent, but a caller may pass any order) so order
 * preservation is observable.
 *
 * Allocation order for `planPageDuplicate(pages, "p-root")`: page ids first in
 * subtree order — p-root=new-1, p-a=new-2, p-b=new-3, p-a1=new-4 — then block
 * ids depth-first per page: b1=new-5, b2=new-6, b3=new-7, b4=new-8.
 */
function basePages(): PageNode[] {
  return [
    {
      id: "p-root",
      parentId: null,
      title: "Notes",
      blocks: [
        { id: "b1", type: "paragraph", text: "hello" },
        { id: "b2", type: "list", children: [{ id: "b3", type: "listItem" }] },
      ],
    },
    { id: "p-a", parentId: "p-root", title: "Alpha", blocks: [{ id: "b4", type: "heading" }] },
    { id: "p-b", parentId: "p-root", title: "Beta" },
    { id: "p-a1", parentId: "p-a", title: "Alpha child" },
    { id: "p-other", parentId: null, title: "Other" },
  ];
}

function validPlan(): PageDuplicatePlan {
  return planPageDuplicate(basePages(), "p-root", { idFactory: seqFactory() });
}

describe("defaultIdFactory", () => {
  it("keeps the `page_<counter>_<random>` shape the page ids have always had", () => {
    expect(defaultIdFactory()).toMatch(/^page_[0-9a-z]+_[0-9a-z]{8}$/);
  });

  it("never hands out the same id twice", () => {
    const ids = new Set(Array.from({ length: 500 }, () => defaultIdFactory()));
    expect(ids.size).toBe(500);
  });

  it("draws the random part from the CSPRNG, never from Math.random", () => {
    // The id ends up as the primary key of the copy and in its URL, so a weak
    // PRNG would make the copied page enumerable.
    const spy = vi.spyOn(Math, "random");
    try {
      defaultIdFactory();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("planPageDuplicate", () => {
  it("copies the whole subtree, root last in position but first link intact", () => {
    const plan = validPlan();
    expect(plan.pages).toHaveLength(4);
    expect(plan.pages.map((p) => p.id)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
  });

  it("remaps every internal parent link and keeps the root's parent", () => {
    const plan = validPlan();
    const [root, a, b, a1] = plan.pages;
    expect(root.parentId).toBeNull();
    expect(a.parentId).toBe("new-1");
    expect(b.parentId).toBe("new-1");
    expect(a1.parentId).toBe("new-2");
  });

  it("suffixes the title of every copied page with the default suffix", () => {
    const plan = validPlan();
    expect(plan.pages.map((p) => p.title)).toEqual([
      "Notes (copy)",
      "Alpha (copy)",
      "Beta (copy)",
      "Alpha child (copy)",
    ]);
  });

  it("exposes an old → new page id map covering only the subtree", () => {
    const plan = validPlan();
    expect(plan.idMap.get("p-root")).toBe("new-1");
    expect(plan.idMap.get("p-a")).toBe("new-2");
    expect(plan.idMap.get("p-a1")).toBe("new-4");
    expect(plan.idMap.has("p-other")).toBe(false);
    expect(plan.idMap.size).toBe(4);
  });

  it("never reuses a page id from the original", () => {
    const original = basePages();
    const plan = planPageDuplicate(original, "p-root", { idFactory: seqFactory() });
    const originalIds = new Set(original.map((p) => p.id));
    for (const page of plan.pages) expect(originalIds.has(page.id)).toBe(false);
  });

  it("deep-copies blocks with fresh ids, in order, preserving extra fields", () => {
    const plan = validPlan();
    const root = plan.pages[0];
    expect(root.blocks?.map((b) => b.id)).toEqual(["new-5", "new-6"]);
    expect(root.blocks?.[0].text).toBe("hello");
    expect(root.blocks?.[1].children?.[0].id).toBe("new-7");
  });

  it("gives the cloned blocks their own fresh ids on the child page too", () => {
    const plan = validPlan();
    expect(plan.pages[1].blocks?.map((b) => b.id)).toEqual(["new-8"]);
  });

  it("preserves input order for the subtree, however the pages arrive", () => {
    const shuffled = [...basePages()].reverse();
    const plan = planPageDuplicate(shuffled, "p-root", { idFactory: seqFactory() });
    // reversed input ⇒ reversed subtree order, but ids still map consistently
    expect(plan.pages.map((p) => p.id)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    expect(plan.pages[0].id).toBe(plan.idMap.get("p-a1"));
    expect(plan.pages[3].id).toBe(plan.idMap.get("p-root"));
    expect(plan.pages[0].parentId).toBe(plan.idMap.get("p-a"));
  });

  it("does not mutate the input and returns fully independent clones", () => {
    const original = basePages();
    const before = JSON.stringify(original);
    const plan = planPageDuplicate(original, "p-root", { idFactory: seqFactory() });

    expect(JSON.stringify(original)).toBe(before);
    plan.pages[0].blocks![0].text = "changed";
    plan.pages[1].title = "changed";
    expect(original[0].blocks![0].text).toBe("hello");
    expect(original[1].title).toBe("Alpha");
  });

  it("accepts a custom title suffix", () => {
    const plan = planPageDuplicate(basePages(), "p-root", {
      idFactory: seqFactory(),
      titleSuffix: " (dup)",
    });
    expect(plan.pages[0].title).toBe("Notes (dup)");
  });

  it("accepts a custom id factory", () => {
    const plan = planPageDuplicate(basePages(), "p-root", {
      idFactory: () => "x",
    });
    // a constant factory still yields the identity remap for parents
    expect(plan.idMap.get("p-root")).toBe("x");
    expect(plan.pages[1].parentId).toBe("x");
  });

  it("keeps an external parent id when duplicating a nested subtree", () => {
    const plan = planPageDuplicate(basePages(), "p-a", { idFactory: seqFactory() });
    expect(plan.pages.map((p) => p.id)).toEqual(["new-1", "new-2"]);
    expect(plan.pages[0].parentId).toBe("p-root");
    expect(plan.pages[1].parentId).toBe("new-1");
  });

  it("copies a leaf page on its own", () => {
    const plan = planPageDuplicate(basePages(), "p-a1", { idFactory: seqFactory() });
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].id).toBe("new-1");
    expect(plan.pages[0].parentId).toBe("p-a");
  });

  it("returns an empty plan for an unknown root", () => {
    const plan = planPageDuplicate(basePages(), "nope", { idFactory: seqFactory() });
    expect(plan.pages).toEqual([]);
    expect(plan.idMap.size).toBe(0);
  });

  it("tolerates pages without blocks and empty input", () => {
    const bare = planPageDuplicate(
      [
        { id: "r", parentId: null, title: "R" },
        { id: "c", parentId: "r", title: "C" },
      ],
      "r",
      { idFactory: seqFactory() },
    );
    expect(bare.pages.map((p) => p.blocks)).toEqual([undefined, undefined]);
    expect(planPageDuplicate([], "r", { idFactory: seqFactory() }).pages).toEqual([]);
  });
});

describe("validatePageDuplicate", () => {
  it("accepts a plan produced by planPageDuplicate", () => {
    const result = validatePageDuplicate(basePages(), validPlan());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags a page id reused from the original", () => {
    const plan = validPlan();
    plan.pages[1].id = "p-a";
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("id reused from original: p-a");
  });

  it("flags a duplicate id inside the copy", () => {
    const plan = validPlan();
    plan.pages[1].id = plan.pages[0].id;
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`duplicate id: ${plan.pages[0].id}`);
  });

  it("flags a parent link that was not remapped", () => {
    const plan = validPlan();
    plan.pages[2].parentId = "new-2"; // Beta should sit under new-1
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("parent not remapped: new-3");
  });

  it("flags a copied page the id map forgot", () => {
    const plan = validPlan();
    plan.pages.pop(); // drop the p-a1 copy, idMap still lists new-4
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("missing copy page:"))).toBe(true);
  });

  it("flags a copied page absent from the id map", () => {
    const plan = validPlan();
    plan.pages.push({ id: "ghost", parentId: "new-1", title: "Ghost" });
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("copy page not in id map: ghost");
  });

  it("flags a page that cannot be reached from the subtree root", () => {
    const plan = validPlan();
    // close a 2-cycle between the p-a copy and its child, detaching both from the root
    plan.pages[1].parentId = plan.pages[3].id;
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("unreachable page:"))).toBe(true);
  });

  it("flags a block id reused from the original", () => {
    const plan = validPlan();
    plan.pages[0].blocks![0].id = "b1";
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("block id reused from original: b1");
  });

  it("flags duplicate block ids inside the copy", () => {
    const plan = validPlan();
    plan.pages[0].blocks![1].id = plan.pages[0].blocks![0].id;
    const result = validatePageDuplicate(basePages(), plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`duplicate block id: ${plan.pages[0].blocks![0].id}`);
  });

  it("flags an id map that does not describe the copy's originals", () => {
    const plan = validPlan();
    const tampered: PageDuplicatePlan = {
      pages: plan.pages,
      idMap: new Map([["p-root", "new-1"]]),
    };
    const result = validatePageDuplicate(basePages(), tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("copy page not in id map:"))).toBe(true);
  });
});
