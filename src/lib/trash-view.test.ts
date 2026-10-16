import { describe, expect, test } from "vitest";
import {
  buildTrashView,
  describeDeleteImpact,
  emptyTrash,
  filterTrash,
  planPermanentDelete,
  planRestore,
  restoreTargets,
  summarizeTrash,
} from "@/lib/trash-view";

/**
 * Trash list / restore / permanent-delete view model (MISSING_FEATURES §9
 * "Trash / recently deleted", "Restore from trash", "Permanent delete";
 * FEATURE_MATRIX rows `:422,:423,:424`).
 *
 * Red-first: `src/lib/trash-view.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the view model lands. These
 * are the pure, time-injected rules a `/w/<slug>/trash` UI renders from: the
 * module consumes soft-deleted records (the `deletedAt` / `deletedById` /
 * `parentId` shape `src/server/queries.ts#getTrash` returns) and never touches
 * the DB, React or the clock.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-04-15T12:00:00.000Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const policy = (retentionDays = 30) => ({ retentionDays });

type RecordInput = {
  id: string;
  parentId?: string | null;
  title?: string | null;
  icon?: string | null;
  deletedAt?: Date | null;
  deletedById?: string | null;
};

/** A trashed page with sensible defaults; override per test. */
function rec(overrides: RecordInput & { id: string }): Required<RecordInput> {
  return {
    parentId: null,
    title: "Page",
    icon: null,
    deletedAt: daysAgo(1),
    deletedById: "user_1",
    ...overrides,
  };
}

describe("buildTrashView", () => {
  test("includes only soft-deleted records", () => {
    const view = buildTrashView(
      [rec({ id: "a" }), rec({ id: "live", deletedAt: null })],
      { now: NOW },
    );
    expect(view.items.map((i) => i.id)).toEqual(["a"]);
  });

  test("maps the record fields onto a view item", () => {
    const view = buildTrashView(
      [rec({ id: "a", title: "Home", icon: "🏠", deletedAt: daysAgo(2), deletedById: "u9" })],
      { now: NOW },
    );
    expect(view.items[0]).toMatchObject({
      id: "a",
      title: "Home",
      icon: "🏠",
      deletedAt: daysAgo(2),
      deletedBy: "u9",
      daysLeft: 28,
      restorable: true,
      nested: false,
    });
    expect(view.items[0].ageLabel).toBe("2 days ago");
  });

  test("omits the icon when the record has none", () => {
    const view = buildTrashView([rec({ id: "a", icon: null })], { now: NOW });
    expect(view.items[0].icon).toBeUndefined();
    expect("icon" in view.items[0]).toBe(false);
  });

  test("falls back to Untitled for a blank title", () => {
    const view = buildTrashView([rec({ id: "a", title: "   " })], { now: NOW });
    expect(view.items[0].title).toBe("Untitled");
  });

  test("sorts top-level items newest-first", () => {
    const view = buildTrashView(
      [
        rec({ id: "old", deletedAt: daysAgo(5) }),
        rec({ id: "newer", deletedAt: daysAgo(1) }),
        rec({ id: "mid", deletedAt: daysAgo(3) }),
      ],
      { now: NOW },
    );
    expect(view.items.map((i) => i.id)).toEqual(["newer", "mid", "old"]);
  });

  test("groups nested children under their deleted ancestor, newest-first", () => {
    const view = buildTrashView(
      [
        rec({ id: "root", deletedAt: daysAgo(1) }),
        rec({ id: "childA", parentId: "root", deletedAt: daysAgo(5) }),
        rec({ id: "grand", parentId: "childA", deletedAt: daysAgo(6) }),
        rec({ id: "childB", parentId: "root", deletedAt: daysAgo(3) }),
        rec({ id: "other", deletedAt: daysAgo(2) }),
      ],
      { now: NOW },
    );
    expect(view.items.map((i) => i.id)).toEqual([
      "root",
      "childB",
      "childA",
      "grand",
      "other",
    ]);
  });

  test("marks descendants nested and roots not nested", () => {
    const view = buildTrashView(
      [
        rec({ id: "root" }),
        rec({ id: "child", parentId: "root", deletedAt: daysAgo(2) }),
        rec({ id: "grand", parentId: "child", deletedAt: daysAgo(3) }),
      ],
      { now: NOW },
    );
    expect(view.items.map((i) => [i.id, i.nested])).toEqual([
      ["root", false],
      ["child", true],
      ["grand", true],
    ]);
  });

  test("treats a missing parent as a root", () => {
    const view = buildTrashView([rec({ id: "orphan", parentId: "gone" })], { now: NOW });
    expect(view.items.map((i) => [i.id, i.nested])).toEqual([["orphan", false]]);
  });

  test("still surfaces records trapped in a parent cycle", () => {
    const view = buildTrashView(
      [
        rec({ id: "a", parentId: "b", deletedAt: daysAgo(1) }),
        rec({ id: "b", parentId: "a", deletedAt: daysAgo(2) }),
      ],
      { now: NOW },
    );
    expect(view.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(view.items.every((i) => !i.nested)).toBe(true);
  });

  test("marks expired items not restorable and counts them", () => {
    const view = buildTrashView(
      [
        rec({ id: "fresh", deletedAt: daysAgo(1) }),
        rec({ id: "expired", deletedAt: daysAgo(40) }),
      ],
      { now: NOW },
    );
    expect(view.items.find((i) => i.id === "expired")).toMatchObject({
      restorable: false,
      daysLeft: -10,
    });
    expect(view.counts).toEqual({ total: 2, restorable: 1, expired: 1, nested: 0 });
  });

  test("a non-positive retention window disables expiry", () => {
    const view = buildTrashView([rec({ id: "ancient", deletedAt: daysAgo(400) })], {
      now: NOW,
      policy: policy(0),
    });
    expect(view.items[0].daysLeft).toBeNull();
    expect(view.items[0].restorable).toBe(true);
  });

  test("counts agree with summarizeTrash and never mutate the input", () => {
    const records = [
      rec({ id: "root", deletedAt: daysAgo(1) }),
      rec({ id: "child", parentId: "root", deletedAt: daysAgo(40) }),
    ];
    const before = records.map((r) => r.id);
    const view = buildTrashView(records, { now: NOW });
    expect(view.counts).toEqual(summarizeTrash(view.items));
    expect(view.counts).toEqual({ total: 2, restorable: 1, expired: 1, nested: 1 });
    expect(records.map((r) => r.id)).toEqual(before);
  });
});

describe("filterTrash", () => {
  const items = buildTrashView(
    [
      rec({ id: "home", title: "Home", deletedById: "u1", deletedAt: daysAgo(1) }),
      rec({ id: "roadmap", title: "Roadmap", deletedById: "u2", deletedAt: daysAgo(2) }),
      rec({ id: "homework", title: "homework", deletedById: "u1", deletedAt: daysAgo(3) }),
    ],
    { now: NOW },
  ).items;

  test("matches the title case-insensitively", () => {
    expect(filterTrash(items, { query: "HOME" }).map((i) => i.id)).toEqual([
      "home",
      "homework",
    ]);
  });

  test("a blank or missing query keeps every item", () => {
    expect(filterTrash(items).map((i) => i.id)).toEqual(["home", "roadmap", "homework"]);
    expect(filterTrash(items, { query: "   " })).toHaveLength(3);
  });

  test("filters by the deleting user", () => {
    expect(filterTrash(items, { deletedBy: "u1" }).map((i) => i.id)).toEqual([
      "home",
      "homework",
    ]);
  });

  test("filters by an inclusive deletion window", () => {
    const ids = filterTrash(items, { from: daysAgo(2.5), to: daysAgo(0.5) }).map((i) => i.id);
    expect(ids).toEqual(["home", "roadmap"]);
  });

  test("combines filters and returns a fresh array", () => {
    const only = filterTrash(items, { query: "home", deletedBy: "u1" });
    expect(only.map((i) => i.id)).toEqual(["home", "homework"]);
    expect(only).not.toBe(items);
  });
});

describe("restoreTargets", () => {
  const items = buildTrashView(
    [
      rec({ id: "root", deletedAt: daysAgo(1) }),
      rec({ id: "child", parentId: "root", deletedAt: daysAgo(2) }),
      rec({ id: "grand", parentId: "child", deletedAt: daysAgo(3) }),
      rec({ id: "lone", deletedAt: daysAgo(4) }),
      rec({ id: "detached", parentId: "live-parent", deletedAt: daysAgo(5) }),
    ],
    { now: NOW },
  ).items;

  test("returns the requested id alone when it has no trashed ancestor", () => {
    expect(restoreTargets(items, ["lone"])).toEqual(["lone"]);
  });

  test("implies the deleted ancestors, ordered root-first", () => {
    expect(restoreTargets(items, ["child"])).toEqual(["root", "child"]);
    expect(restoreTargets(items, ["grand"])).toEqual(["root", "child", "grand"]);
  });

  test("deduplicates when ancestor and descendant are both requested", () => {
    expect(restoreTargets(items, ["root", "grand"])).toEqual(["root", "child", "grand"]);
  });

  test("stops at an ancestor that is not in the trash view", () => {
    expect(restoreTargets(items, ["detached"])).toEqual(["detached"]);
  });

  test("ignores unknown ids and returns no targets for an empty selection", () => {
    expect(restoreTargets(items, ["ghost"])).toEqual([]);
    expect(restoreTargets(items, [])).toEqual([]);
  });
});

describe("planRestore", () => {
  const items = buildTrashView(
    [
      rec({ id: "root", deletedAt: daysAgo(1) }),
      rec({ id: "child", parentId: "root", deletedAt: daysAgo(2) }),
      rec({ id: "detached", parentId: "live-parent", deletedAt: daysAgo(3) }),
    ],
    { now: NOW },
  ).items;

  test("emits ops root-first with no reparenting when ancestors are included", () => {
    expect(planRestore(items, ["child"])).toEqual({
      ops: [
        { id: "root", parentId: null, reparentToRoot: false },
        { id: "child", parentId: "root", reparentToRoot: false },
      ],
      warnings: { parentMissing: [] },
    });
  });

  test("warns and reparents when a target's parent is not recoverable", () => {
    expect(planRestore(items, ["detached"])).toEqual({
      ops: [{ id: "detached", parentId: "live-parent", reparentToRoot: true }],
      warnings: { parentMissing: ["detached"] },
    });
  });

  test("an empty selection plans nothing", () => {
    expect(planRestore(items, [])).toEqual({ ops: [], warnings: { parentMissing: [] } });
  });
});

describe("planPermanentDelete", () => {
  const linear = buildTrashView(
    [
      rec({ id: "root", deletedAt: daysAgo(1) }),
      rec({ id: "child", parentId: "root", deletedAt: daysAgo(2) }),
      rec({ id: "grand", parentId: "child", deletedAt: daysAgo(3) }),
    ],
    { now: NOW },
  ).items;

  test("cascade deletes children before their ancestors", () => {
    expect(planPermanentDelete(linear, ["root"], { cascade: true })).toEqual({
      ops: ["grand", "child", "root"],
      blocked: [],
    });
  });

  test("cascade from a mid-node carries its descendants", () => {
    expect(planPermanentDelete(linear, ["child"], { cascade: true })).toEqual({
      ops: ["grand", "child"],
      blocked: [],
    });
  });

  test("refuses to delete a non-empty ancestor unless cascade is set", () => {
    expect(planPermanentDelete(linear, ["root"])).toEqual({ ops: [], blocked: ["root"] });
  });

  test("allows an ancestor when every descendant is selected too", () => {
    expect(planPermanentDelete(linear, ["root", "child", "grand"])).toEqual({
      ops: ["grand", "child", "root"],
      blocked: [],
    });
  });

  test("a leaf is always deletable and unknown ids are ignored", () => {
    expect(planPermanentDelete(linear, ["grand", "ghost"])).toEqual({
      ops: ["grand"],
      blocked: [],
    });
  });

  test("branches delete children before parents", () => {
    const items = buildTrashView(
      [
        rec({ id: "root", deletedAt: daysAgo(1) }),
        rec({ id: "childB", parentId: "root", deletedAt: daysAgo(3) }),
        rec({ id: "childA", parentId: "root", deletedAt: daysAgo(5) }),
        rec({ id: "grand", parentId: "childA", deletedAt: daysAgo(6) }),
      ],
      { now: NOW },
    ).items;
    const { ops } = planPermanentDelete(items, ["root"], { cascade: true });
    expect(ops).toContain("root");
    expect(ops.indexOf("grand")).toBeLessThan(ops.indexOf("childA"));
    expect(ops.indexOf("childA")).toBeLessThan(ops.indexOf("root"));
    expect(ops.indexOf("childB")).toBeLessThan(ops.indexOf("root"));
    expect(ops).toHaveLength(4);
  });
});

describe("emptyTrash", () => {
  const records = [
    { id: "expired", deletedAt: daysAgo(40) },
    { id: "fresh", deletedAt: daysAgo(1) },
    { id: "boundary", deletedAt: daysAgo(30) },
    { id: "live", deletedAt: null },
  ];

  test("returns only items past the recovery window, keeping input order", () => {
    expect(emptyTrash(records, { now: NOW }).map((i) => i.id)).toEqual(["expired"]);
  });

  test("the boundary item is retained (purging is strict)", () => {
    const ids = emptyTrash(records, { now: NOW }).map((i) => i.id);
    expect(ids).not.toContain("boundary");
    expect(ids).not.toContain("live");
  });

  test("honours a custom window and returns caller references", () => {
    const purged = emptyTrash(records, { now: NOW, retentionDays: 7 });
    expect(purged.map((i) => i.id)).toEqual(["expired", "boundary"]);
    expect(purged[0]).toBe(records[0]);
  });

  test("a non-positive window purges nothing", () => {
    expect(emptyTrash(records, { now: NOW, retentionDays: 0 })).toEqual([]);
  });
});

describe("describeDeleteImpact", () => {
  const items = buildTrashView(
    [
      rec({ id: "root", deletedAt: daysAgo(1) }),
      rec({ id: "childA", parentId: "root", deletedAt: daysAgo(2) }),
      rec({ id: "grand", parentId: "childA", deletedAt: daysAgo(3) }),
      rec({ id: "childB", parentId: "root", deletedAt: daysAgo(4) }),
      rec({ id: "leaf", deletedAt: daysAgo(5) }),
    ],
    { now: NOW },
  ).items;

  test("counts every trashed sub-page", () => {
    expect(describeDeleteImpact(items, "root")).toBe("This will also delete 3 sub-pages");
  });

  test("uses the singular for exactly one sub-page", () => {
    expect(describeDeleteImpact(items, "childA")).toBe("This will also delete 1 sub-page");
  });

  test("says nothing extra for a leaf and is empty for an unknown id", () => {
    expect(describeDeleteImpact(items, "leaf")).toBe("This will only delete this page");
    expect(describeDeleteImpact(items, "ghost")).toBe("");
  });
});

describe("summarizeTrash", () => {
  test("counts total, restorable, expired and nested items", () => {
    const items = buildTrashView(
      [
        rec({ id: "root", deletedAt: daysAgo(1) }),
        rec({ id: "child", parentId: "root", deletedAt: daysAgo(40) }),
        rec({ id: "other", deletedAt: daysAgo(2) }),
      ],
      { now: NOW },
    ).items;
    expect(summarizeTrash(items)).toEqual({ total: 3, restorable: 2, expired: 1, nested: 1 });
  });

  test("an empty trash summarizes to zeros", () => {
    expect(summarizeTrash([])).toEqual({ total: 0, restorable: 0, expired: 0, nested: 0 });
  });
});
