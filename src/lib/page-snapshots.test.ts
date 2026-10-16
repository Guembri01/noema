import { describe, expect, it } from "vitest";
import {
  BACKUP_VERSION,
  MAX_SNAPSHOT_LABEL_LENGTH,
  buildBackup,
  contentHashOf,
  createSnapshot,
  dedupeSnapshots,
  planRestore,
  restoreFromSnapshot,
  snapshotDiff,
  validateBackup,
  type BackupBundle,
  type PageSnapshot,
  type PageSnapshotBlock,
  type SnapshotPage,
} from "./page-snapshots";

/**
 * Page snapshot + backup/restore engine (§17 "Page snapshots" / "Restore from
 * backup").
 *
 * Red-first: this file predates `src/lib/page-snapshots.ts`, so every import
 * resolves to module-not-found and the suite fails to collect. It pins the
 * pure core a restore path needs — a stable content hash, snapshot creation
 * with injectable time/actor/label, consecutive-hash dedupe, block-level diff,
 * a restore patch that reuses current ids for unchanged content, a workspace
 * backup bundle, its integrity validator and a restore plan.
 */

const FIXED_NOW = new Date("2026-02-03T04:05:06.000Z");

/** Terse block builder. */
const block = (id: string, text: string): PageSnapshotBlock => ({
  id,
  type: "paragraph",
  text,
});

/** Terse page builder. */
const page = (id: string, blocks: PageSnapshotBlock[] = [], title = "Untitled"): SnapshotPage => ({
  id,
  title,
  blocks,
});

/** A snapshot record shaped by hand, for pure dedupe/diff fixtures. */
const record = (
  id: string,
  contentHash: string,
  takenAt: string,
  label: string | null = null,
): PageSnapshot => ({
  id,
  pageId: "p1",
  takenAt,
  contentHash,
  blocks: [],
  meta: { actorId: "u1", label, title: null },
});

describe("contentHashOf", () => {
  it("is stable across calls and returns 8 lowercase hex chars", () => {
    const first = contentHashOf({ a: 1, b: 2 });
    expect(contentHashOf({ a: 1, b: 2 })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  it("treats object key order as irrelevant but array order as significant", () => {
    expect(contentHashOf({ a: 1, b: 2 })).toBe(contentHashOf({ b: 2, a: 1 }));
    expect(contentHashOf([1, 2])).not.toBe(contentHashOf([2, 1]));
  });

  it("separates different payloads and primitive types", () => {
    expect(contentHashOf("a")).not.toBe(contentHashOf("b"));
    expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
    expect(contentHashOf(null)).not.toBe(contentHashOf(0));
  });

  it("serialises Dates to their ISO string form", () => {
    expect(contentHashOf({ at: new Date("2026-01-01T00:00:00.000Z") })).toBe(
      contentHashOf({ at: "2026-01-01T00:00:00.000Z" }),
    );
  });

  it("ignores undefined object fields so they never change the hash", () => {
    expect(contentHashOf({ a: 1, b: undefined })).toBe(contentHashOf({ a: 1 }));
  });
});

describe("createSnapshot", () => {
  it("builds the documented shape", () => {
    const snap = createSnapshot(page("p1", [block("b1", "hello")], "Doc"), {
      actorId: "u1",
      now: FIXED_NOW,
      idFactory: () => "snap-1",
    });
    expect(snap.id).toBe("snap-1");
    expect(snap.pageId).toBe("p1");
    expect(snap.takenAt).toBe("2026-02-03T04:05:06.000Z");
    expect(snap.blocks).toHaveLength(1);
    expect(snap.meta.actorId).toBe("u1");
    expect(snap.meta.label).toBeNull();
    expect(snap.meta.title).toBe("Doc");
    expect(snap.contentHash).toBe(
      contentHashOf({ title: "Doc", blocks: [block("b1", "hello")] }),
    );
  });

  it("accepts epoch millis for `now`", () => {
    const snap = createSnapshot(page("p1"), { actorId: "u1", now: 0, idFactory: () => "s" });
    expect(snap.takenAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("trims a label and treats a blank one as unnamed", () => {
    const named = createSnapshot(page("p1"), {
      actorId: "u1",
      now: FIXED_NOW,
      label: "  Release  ",
      idFactory: () => "s",
    });
    expect(named.meta.label).toBe("Release");
    const blank = createSnapshot(page("p1"), {
      actorId: "u1",
      now: FIXED_NOW,
      label: "   ",
      idFactory: () => "s",
    });
    expect(blank.meta.label).toBeNull();
  });

  it("rejects an over-long label", () => {
    expect(() =>
      createSnapshot(page("p1"), {
        actorId: "u1",
        now: FIXED_NOW,
        label: "x".repeat(MAX_SNAPSHOT_LABEL_LENGTH + 1),
        idFactory: () => "s",
      }),
    ).toThrow(RangeError);
  });

  it("deep-clones blocks so later mutation cannot leak in or out", () => {
    const source = [block("b1", "hello")];
    const snap = createSnapshot(page("p1", source), {
      actorId: "u1",
      now: FIXED_NOW,
      idFactory: () => "s",
    });
    source[0].text = "mutated";
    expect(snap.blocks[0].text).toBe("hello");
    snap.blocks[0].text = "other";
    expect(source[0].text).toBe("mutated");
  });

  it("keeps extra metadata supplied by the caller", () => {
    const snap = createSnapshot(page("p1"), {
      actorId: "u1",
      now: FIXED_NOW,
      idFactory: () => "s",
      meta: { reason: "manual" },
    });
    expect(snap.meta.reason).toBe("manual");
  });

  it("degrades on a missing page instead of throwing", () => {
    const snap = createSnapshot(undefined, { actorId: "u1", now: FIXED_NOW, idFactory: () => "s" });
    expect(snap.pageId).toBe("");
    expect(snap.blocks).toEqual([]);
  });

  it("mints unique ids by default", () => {
    const a = createSnapshot(page("p1"), { actorId: "u1", now: FIXED_NOW });
    const b = createSnapshot(page("p1"), { actorId: "u1", now: FIXED_NOW });
    expect(a.id).toBeTruthy();
    expect(b.id).not.toBe(a.id);
  });
});

describe("dedupeSnapshots", () => {
  it("collapses a consecutive run with the same hash, keeping the newest", () => {
    const older = record("s1", "aaa", "2026-01-01T00:00:00.000Z");
    const newer = record("s2", "aaa", "2026-01-02T00:00:00.000Z");
    const tail = record("s3", "bbb", "2026-01-03T00:00:00.000Z");
    expect(dedupeSnapshots([older, newer, tail]).map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("keeps the newer snapshot whichever chronological direction the input uses", () => {
    const older = record("s1", "aaa", "2026-01-01T00:00:00.000Z");
    const newer = record("s2", "aaa", "2026-01-02T00:00:00.000Z");
    expect(dedupeSnapshots([newer, older]).map((s) => s.id)).toEqual(["s2"]);
  });

  it("keeps identical hashes that are not consecutive", () => {
    const a = record("s1", "aaa", "2026-01-01T00:00:00.000Z");
    const b = record("s2", "bbb", "2026-01-02T00:00:00.000Z");
    const c = record("s3", "aaa", "2026-01-03T00:00:00.000Z");
    expect(dedupeSnapshots([a, b, c]).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("ignores malformed input", () => {
    expect(dedupeSnapshots([])).toEqual([]);
    expect(dedupeSnapshots(null)).toEqual([]);
    expect(dedupeSnapshots(undefined)).toEqual([]);
  });

  it("does not mutate its input array", () => {
    const input = [
      record("s1", "aaa", "2026-01-01T00:00:00.000Z"),
      record("s2", "aaa", "2026-01-02T00:00:00.000Z"),
    ];
    const before = input.map((s) => s.id);
    dedupeSnapshots(input);
    expect(input.map((s) => s.id)).toEqual(before);
  });
});

describe("snapshotDiff", () => {
  it("classifies added, removed and changed blocks by id", () => {
    const diff = snapshotDiff([block("x", "one"), block("y", "two")], [block("x", "one!"), block("z", "three")]);
    expect(diff.added).toEqual(["z"]);
    expect(diff.removed).toEqual(["y"]);
    expect(diff.changed).toEqual(["x"]);
  });

  it("reports a reordering as moved", () => {
    const diff = snapshotDiff(
      [block("x", "1"), block("y", "2"), block("z", "3")],
      [block("z", "3"), block("x", "1"), block("y", "2")],
    );
    expect(diff.moved).toEqual(["z"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("lists a block that both changed and moved in both buckets", () => {
    const diff = snapshotDiff([block("x", "1"), block("y", "2")], [block("y", "2!"), block("x", "1")]);
    expect(diff.changed).toContain("y");
    expect(diff.moved).toContain("y");
  });

  it("returns empty buckets with zeroed counts for identical input", () => {
    expect(snapshotDiff([block("x", "1")], [block("x", "1")])).toEqual({
      added: [],
      removed: [],
      changed: [],
      moved: [],
      counts: { added: 0, removed: 0, changed: 0, moved: 0 },
    });
  });

  it("accepts whole snapshots as well as bare block arrays", () => {
    const a = createSnapshot(page("p1", [block("x", "1")]), {
      actorId: "u1",
      now: FIXED_NOW,
      idFactory: () => "a",
    });
    const b = createSnapshot(page("p1", [block("x", "1"), block("y", "2")]), {
      actorId: "u1",
      now: FIXED_NOW,
      idFactory: () => "b",
    });
    expect(snapshotDiff(a, b).added).toEqual(["y"]);
  });

  it("degrades a malformed side to an empty document", () => {
    expect(snapshotDiff(null, [block("x", "1")]).added).toEqual(["x"]);
  });

  it("summarises the four buckets as counts", () => {
    const diff = snapshotDiff([block("x", "1"), block("y", "2")], [block("x", "1!"), block("z", "3")]);
    expect(diff.counts).toEqual({ added: 1, removed: 1, changed: 1, moved: 0 });
  });
});

describe("restoreFromSnapshot", () => {
  const snap = createSnapshot(page("p1", [block("b1", "one"), block("b2", "two")], "Doc"), {
    actorId: "u1",
    now: FIXED_NOW,
    idFactory: () => "snap-1",
  });

  it("restores every snapshot block when there is no current document", () => {
    const patch = restoreFromSnapshot(snap, { now: FIXED_NOW });
    expect(patch.pageId).toBe("p1");
    expect(patch.snapshotId).toBe("snap-1");
    expect(patch.restoredAt).toBe("2026-02-03T04:05:06.000Z");
    expect(patch.title).toBe("Doc");
    expect(patch.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(patch.added).toEqual(["b1", "b2"]);
    expect(patch.removed).toEqual([]);
    expect(patch.changed).toEqual([]);
  });

  it("preserves a current id when a block's content is unchanged", () => {
    const current = [block("cur-1", "one")];
    const patch = restoreFromSnapshot(snap, { now: FIXED_NOW, current });
    expect(patch.blocks.map((b) => b.id)).toEqual(["cur-1", "b2"]);
    expect(patch.preserved.get("b1")).toBe("cur-1");
    expect(patch.added).toEqual(["b2"]);
    expect(patch.removed).toEqual([]);
  });

  it("drops current blocks the snapshot no longer contains", () => {
    const current = [block("b1", "one"), block("b2", "two"), block("gone", "old")];
    const patch = restoreFromSnapshot(snap, { now: FIXED_NOW, current });
    expect(patch.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(patch.removed).toEqual(["gone"]);
  });

  it("flags an id whose content changed and restores the snapshot's content", () => {
    const current = [block("b1", "CHANGED")];
    const patch = restoreFromSnapshot(snap, { now: FIXED_NOW, current });
    expect(patch.changed).toContain("b1");
    expect(patch.blocks[0].text).toBe("one");
  });

  it("does not mutate the snapshot or the current document", () => {
    const current = [block("b1", "one")];
    const before = JSON.stringify({ current, blocks: snap.blocks });
    restoreFromSnapshot(snap, { now: FIXED_NOW, current });
    expect(JSON.stringify({ current, blocks: snap.blocks })).toBe(before);
  });
});

describe("buildBackup", () => {
  const workspace = {
    id: "w1",
    name: "Workspace",
    pages: [
      page("p1", [block("b1", "one")], "Root"),
      { ...page("p2", [block("b2", "two"), block("b3", "three")], "Child"), parentId: "p1" },
    ],
  };

  it("stamps the version, workspace id and injectable createdAt", () => {
    const bundle = buildBackup(workspace, { now: FIXED_NOW });
    expect(bundle.version).toBe(BACKUP_VERSION);
    expect(bundle.createdAt).toBe("2026-02-03T04:05:06.000Z");
    expect(bundle.workspaceId).toBe("w1");
    expect(bundle.workspaceName).toBe("Workspace");
  });

  it("copies pages, blocks and parent refs with aggregate counts", () => {
    const bundle = buildBackup(workspace, { now: FIXED_NOW });
    expect(bundle.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(bundle.pages[0].parentId).toBeNull();
    expect(bundle.pages[1].parentId).toBe("p1");
    expect(bundle.counts).toEqual({ pages: 2, blocks: 3, roots: 1 });
  });

  it("hashes each page from its title and blocks", () => {
    const bundle = buildBackup(workspace, { now: FIXED_NOW });
    expect(bundle.pages[0].contentHash).toBe(
      contentHashOf({ title: "Root", blocks: [block("b1", "one")] }),
    );
  });

  it("skips pages without an id and duplicate ids", () => {
    const messy = {
      id: "w1",
      pages: [page("p1"), { blocks: [] } as unknown as SnapshotPage, page("p1")],
    };
    const bundle = buildBackup(messy, { now: FIXED_NOW });
    expect(bundle.pages.map((p) => p.id)).toEqual(["p1"]);
    expect(bundle.counts.pages).toBe(1);
  });
});

describe("validateBackup", () => {
  const bundle = (): BackupBundle =>
    buildBackup(
      {
        id: "w1",
        pages: [
          page("p1", [block("b1", "one")], "Root"),
          { ...page("p2", [block("b2", "two")], "Child"), parentId: "p1" },
        ],
      },
      { now: FIXED_NOW },
    );

  const codes = (value: unknown): string[] => validateBackup(value).issues.map((issue) => issue.code);

  it("accepts a freshly built bundle", () => {
    const result = validateBackup(bundle());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects an unsupported version", () => {
    const result = validateBackup({ ...bundle(), version: 999 });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("unsupported-version");
  });

  it("rejects a dangling parent reference", () => {
    const base = bundle();
    const broken = {
      ...base,
      pages: [...base.pages, { ...base.pages[0], id: "p3", parentId: "missing" }],
      counts: { ...base.counts, pages: 3 },
    };
    expect(codes(broken)).toContain("dangling-parent");
    expect(validateBackup(broken).ok).toBe(false);
  });

  it("rejects a duplicate page id", () => {
    const base = bundle();
    const broken = {
      ...base,
      pages: [...base.pages, { ...base.pages[0] }],
      counts: { ...base.counts, pages: 3 },
    };
    expect(codes(broken)).toContain("duplicate-page-id");
  });

  it("rejects a parent cycle", () => {
    const base = bundle();
    const pages = base.pages.map((p) => (p.id === "p1" ? { ...p, parentId: "p2" } : p));
    expect(codes({ ...base, pages })).toContain("parent-cycle");
  });

  it("rejects malformed blocks and duplicate block ids", () => {
    const base = bundle();
    const pages = base.pages.map((p) =>
      p.id === "p1"
        ? {
            ...p,
            blocks: [
              { type: "paragraph" } as unknown as PageSnapshotBlock,
              block("b1", "one"),
              block("b1", "dup"),
            ],
          }
        : p,
    );
    const found = codes({ ...base, pages });
    expect(found).toContain("invalid-block-id");
    expect(found).toContain("duplicate-block-id");
  });

  it("rejects a content-hash mismatch", () => {
    const base = bundle();
    const pages = base.pages.map((p) => (p.id === "p1" ? { ...p, contentHash: "deadbeef" } : p));
    expect(codes({ ...base, pages })).toContain("content-hash-mismatch");
  });

  it("rejects counts that do not match the pages", () => {
    const base = bundle();
    expect(codes({ ...base, counts: { ...base.counts, blocks: 99 } })).toContain("count-mismatch");
  });

  it("rejects a non-object bundle", () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup(null).issues[0].code).toBe("not-an-object");
  });
});

describe("planRestore", () => {
  const bundle = buildBackup(
    {
      id: "w1",
      pages: [
        page("p1", [block("b1", "one")], "Root"),
        { ...page("p2", [block("b2", "two")], "Child"), parentId: "p1" },
      ],
    },
    { now: FIXED_NOW },
  );

  it("partitions pages into create, update and remove", () => {
    const plan = planRestore(bundle, {
      pages: [
        { id: "p2", blocks: [block("b2", "two")] },
        { id: "p9", blocks: [] },
      ],
    });
    expect(plan.create).toEqual(["p1"]);
    expect(plan.update).toEqual(["p2"]);
    expect(plan.remove).toEqual(["p9"]);
    expect(plan.counts).toEqual({ create: 1, update: 1, remove: 1 });
  });

  it("computes a block diff for pages that already exist", () => {
    const plan = planRestore(bundle, { pages: [{ id: "p2", blocks: [] }] });
    const entry = plan.entries.find((item) => item.pageId === "p2");
    expect(entry?.action).toBe("update");
    expect(entry?.diff.added).toEqual(["b2"]);
  });

  it("treats every page as new when the target is empty or missing", () => {
    expect(planRestore(bundle, { pages: [] }).create).toEqual(["p1", "p2"]);
    expect(planRestore(bundle).create).toEqual(["p1", "p2"]);
  });

  it("keeps the bundle's workspace id and aggregates block totals", () => {
    const plan = planRestore(bundle, { pages: [] });
    expect(plan.workspaceId).toBe("w1");
    expect(plan.blocks.added).toBe(2);
    expect(plan.blocks.removed).toBe(0);
  });

  it("reports only blocks that actually changed on an update", () => {
    const plan = planRestore(bundle, {
      pages: [{ id: "p2", blocks: [block("b2", "two"), block("old", "stale")] }],
    });
    const entry = plan.entries.find((item) => item.pageId === "p2");
    expect(entry?.diff.added).toEqual([]);
    expect(entry?.diff.removed).toEqual(["old"]);
    expect(plan.blocks.removed).toBe(1);
  });
});
