import { describe, expect, it } from "vitest";
import {
  brokenRefs,
  createSyncedBlockState,
  createSyncRef,
  describeSync,
  detachInstance,
  findSource,
  isSource,
  propagateEdit,
  registerInstance,
  resolveSync,
  sourceMarker,
  type SyncBlock,
} from "./synced-blocks";

/** A canonical source block with a nested child. */
const doc: SyncBlock[] = [
  { id: "s1", type: "page", children: [{ id: "s1a", type: "paragraph", text: "hi" }] },
  { id: "other", type: "paragraph" },
];

/** The content a source edit would push out to mirrors. */
const content = { id: "s1", type: "paragraph", text: "v2" };

/** The ref most tests work against. */
const ref = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" });

describe("createSyncRef", () => {
  it("builds a ref carrying the source coordinates", () => {
    const built = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" });
    expect(built.sourceBlockId).toBe("s1");
    expect(built.sourcePageId).toBe("p1");
    expect(typeof built.refId).toBe("string");
    expect(built.refId).not.toBe("");
  });

  it("derives a deterministic refId when one is omitted", () => {
    const a = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" });
    const b = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" });
    expect(a.refId).toBe(b.refId);
    expect(a.refId).toBe("sync_p1__s1");
  });

  it("honours an explicit refId", () => {
    const built = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1", refId: "custom" });
    expect(built.refId).toBe("custom");
  });

  it("defaults createdAt to 0 and preserves an explicit stamp", () => {
    expect(createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" }).createdAt).toBe(0);
    expect(
      createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1", createdAt: 123 }).createdAt,
    ).toBe(123);
  });

  it("rejects blank source coordinates", () => {
    expect(() => createSyncRef({ sourceBlockId: "", sourcePageId: "p1" })).toThrow();
    expect(() => createSyncRef({ sourceBlockId: "s1", sourcePageId: "   " })).toThrow();
  });
});

describe("createSyncedBlockState", () => {
  it("is empty by default", () => {
    expect(createSyncedBlockState()).toEqual({
      refs: {},
      content: {},
      instances: {},
      instancesBySource: {},
    });
  });

  it("seeds refs and instances and rebuilds the source index", () => {
    const r1 = createSyncRef({ sourceBlockId: "s1", sourcePageId: "p1" });
    const r2 = createSyncRef({ sourceBlockId: "s2", sourcePageId: "p1" });
    const state = createSyncedBlockState({
      refs: [r1, r2],
      instances: [
        { blockId: "i1", pageId: "p2", refId: r1.refId, attrs: { width: 10 } },
        { blockId: "i2", pageId: "p3", refId: r2.refId, attrs: {} },
      ],
    });
    expect(Object.keys(state.refs).sort()).toEqual([r1.refId, r2.refId].sort());
    expect(state.instances.i1.attrs).toEqual({ width: 10 });
    expect(state.instancesBySource.s1).toEqual(["i1"]);
    expect(state.instancesBySource.s2).toEqual(["i2"]);
  });
});

describe("registerInstance", () => {
  it("registers an instance and indexes it under its source", () => {
    const state = registerInstance(createSyncedBlockState(), ref, {
      pageId: "p2",
      blockId: "i1",
    });
    expect(state.instances.i1).toEqual({
      blockId: "i1",
      pageId: "p2",
      refId: ref.refId,
      attrs: {},
    });
    expect(state.instancesBySource.s1).toEqual(["i1"]);
    expect(state.refs[ref.refId]).toEqual(ref);
  });

  it("tracks several instances for one source in registration order", () => {
    let state = createSyncedBlockState();
    state = registerInstance(state, ref, { pageId: "p2", blockId: "i1" });
    state = registerInstance(state, ref, { pageId: "p3", blockId: "i2" });
    expect(state.instancesBySource.s1).toEqual(["i1", "i2"]);
  });

  it("dedupes a repeated registration of the same instance", () => {
    let state = registerInstance(createSyncedBlockState(), ref, {
      pageId: "p2",
      blockId: "i1",
    });
    state = registerInstance(state, ref, { pageId: "p2", blockId: "i1" });
    expect(state.instancesBySource.s1).toEqual(["i1"]);
  });

  it("updates attrs on re-register without duplicating the index entry", () => {
    let state = registerInstance(createSyncedBlockState(), ref, {
      pageId: "p2",
      blockId: "i1",
      attrs: { width: 1 },
    });
    state = registerInstance(state, ref, {
      pageId: "p2",
      blockId: "i1",
      attrs: { width: 2 },
    });
    expect(state.instances.i1.attrs).toEqual({ width: 2 });
    expect(state.instancesBySource.s1).toEqual(["i1"]);
  });

  it("moves an instance off its previous source when re-registered", () => {
    const ref2 = createSyncRef({ sourceBlockId: "s2", sourcePageId: "p1" });
    let state = registerInstance(createSyncedBlockState(), ref, {
      pageId: "p2",
      blockId: "i1",
    });
    state = registerInstance(state, ref2, { pageId: "p2", blockId: "i1" });
    expect(state.instancesBySource.s1).toBeUndefined();
    expect(state.instancesBySource.s2).toEqual(["i1"]);
  });

  it("never mutates the input state", () => {
    const base = createSyncedBlockState();
    const snapshot = JSON.parse(JSON.stringify(base)) as unknown;
    const next = registerInstance(base, ref, { pageId: "p2", blockId: "i1" });
    expect(base).toEqual(snapshot);
    expect(next).not.toBe(base);
  });

  it("rejects a blank instance block id", () => {
    expect(() =>
      registerInstance(createSyncedBlockState(), ref, { pageId: "p2", blockId: "" }),
    ).toThrow();
  });
});

describe("resolveSync", () => {
  it("pulls a deep clone of the canonical source block", () => {
    const resolved = resolveSync(ref, doc);
    expect(resolved).toEqual(doc[0]);
    expect(resolved).not.toBe(doc[0]);
    expect(resolved?.children?.[0]).not.toBe(doc[0].children?.[0]);
  });

  it("returns an independent clone", () => {
    const resolved = resolveSync(ref, doc)!;
    resolved.children![0].text = "changed";
    resolved.children!.push({ id: "x", type: "paragraph" });
    expect(doc[0].children).toHaveLength(1);
    expect(doc[0].children?.[0].text).toBe("hi");
  });

  it("returns null when the source is missing", () => {
    const ghost = createSyncRef({ sourceBlockId: "ghost", sourcePageId: "p1" });
    expect(resolveSync(ghost, doc)).toBeNull();
  });
});

describe("propagateEdit", () => {
  const seed = () => {
    let state = createSyncedBlockState();
    state = registerInstance(state, ref, {
      pageId: "p2",
      blockId: "i1",
      attrs: { width: 120 },
    });
    state = registerInstance(state, ref, {
      pageId: "p3",
      blockId: "i2",
      attrs: { width: 240 },
    });
    return state;
  };

  it("produces one plan per instance", () => {
    const { count, plans } = propagateEdit(seed(), { refId: ref.refId, newContent: content });
    expect(count).toBe(2);
    expect(plans.map((plan) => plan.instanceId)).toEqual(["i1", "i2"]);
  });

  it("mirrors the new content into every plan", () => {
    const { plans } = propagateEdit(seed(), { refId: ref.refId, newContent: content });
    for (const plan of plans) expect(plan.content).toEqual(content);
    expect(plans.map((plan) => plan.pageId)).toEqual(["p2", "p3"]);
  });

  it("preserves instance-local attrs like width", () => {
    const { plans } = propagateEdit(seed(), { refId: ref.refId, newContent: content });
    expect(plans[0].attrs).toEqual({ width: 120 });
    expect(plans[1].attrs).toEqual({ width: 240 });
  });

  it("hands each instance its own deep copy of the content", () => {
    const { plans } = propagateEdit(seed(), { refId: ref.refId, newContent: content });
    expect(plans[0].content).not.toBe(plans[1].content);
    expect(plans[0].content).not.toBe(content);
  });

  it("returns no plans for an unknown ref and keeps the state", () => {
    const base = seed();
    const result = propagateEdit(base, { refId: "nope", newContent: content });
    expect(result.plans).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.state).toBe(base);
  });

  it("stores the canonical content snapshot without mutating the input", () => {
    const base = seed();
    const snapshot = JSON.parse(JSON.stringify(base)) as unknown;
    const { state } = propagateEdit(base, { refId: ref.refId, newContent: content });
    expect(base).toEqual(snapshot);
    expect(state.content[ref.refId]).toEqual(content);
    expect(state).not.toBe(base);
  });
});

describe("detachInstance", () => {
  const seed = () => propagateEdit(seedState(), { refId: ref.refId, newContent: content }).state;

  function seedState() {
    let state = createSyncedBlockState();
    state = registerInstance(state, ref, {
      pageId: "p2",
      blockId: "i1",
      attrs: { width: 120 },
    });
    state = registerInstance(state, ref, {
      pageId: "p3",
      blockId: "i2",
      attrs: { width: 240 },
    });
    return state;
  }

  it("snapshots the canonical content and removes the instance", () => {
    const base = seed();
    const result = detachInstance(base, { refId: ref.refId, instanceId: "i1" });
    expect(result.detached).toBe(true);
    expect(result.snapshot).toEqual(content);
    expect(result.snapshot).not.toBe(base.content[ref.refId]);
    expect(result.state.instances.i1).toBeUndefined();
  });

  it("removes the instance from the source index but keeps the rest", () => {
    const base = seed();
    const result = detachInstance(base, { refId: ref.refId, instanceId: "i1" });
    expect(result.state.instancesBySource.s1).toEqual(["i2"]);
    expect(result.state.instances.i2).toBeDefined();
  });

  it("reports detached:false for an unknown instance", () => {
    const base = seed();
    const result = detachInstance(base, { refId: ref.refId, instanceId: "ghost" });
    expect(result.detached).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.state).toBe(base);
  });

  it("reports detached:false when the refId does not match", () => {
    const base = seed();
    const result = detachInstance(base, { refId: "other", instanceId: "i1" });
    expect(result.detached).toBe(false);
    expect(result.state).toBe(base);
  });
});

describe("findSource", () => {
  it("returns the ref behind a registered instance", () => {
    const base = registerInstance(createSyncedBlockState(), ref, {
      pageId: "p2",
      blockId: "i1",
    });
    expect(findSource(base, "i1")).toEqual(ref);
  });

  it("returns null for an unknown instance", () => {
    expect(findSource(createSyncedBlockState(), "nope")).toBeNull();
  });
});

describe("isSource", () => {
  it("matches the ref's source block id", () => {
    expect(isSource("s1", ref)).toBe(true);
    expect(isSource("other", ref)).toBe(false);
  });

  it("trims the candidate before comparing", () => {
    expect(isSource("  s1  ", ref)).toBe(true);
    expect(isSource("", ref)).toBe(false);
  });
});

describe("sourceMarker", () => {
  it("describes the synced-from marker with a deep link", () => {
    const marker = sourceMarker(ref, { readOnly: false });
    expect(marker.refId).toBe(ref.refId);
    expect(marker.sourceBlockId).toBe("s1");
    expect(marker.sourcePageId).toBe("p1");
    expect(marker.label).toBe("Synced from p1");
    expect(marker.href).toBe("/w/p1#s1");
    expect(marker.readOnly).toBe(false);
  });

  it("defaults readOnly to false and flips when asked", () => {
    expect(sourceMarker(ref, {}).readOnly).toBe(false);
    expect(sourceMarker(ref, { readOnly: true }).readOnly).toBe(true);
  });

  it("encodes the ids in the deep link", () => {
    const weird = createSyncRef({ sourceBlockId: "b 1", sourcePageId: "p/1" });
    expect(sourceMarker(weird, {}).href).toBe("/w/p%2F1#b%201");
  });
});

describe("brokenRefs", () => {
  const seeded = (() => {
    let state = createSyncedBlockState();
    state = registerInstance(state, ref, { pageId: "p2", blockId: "i1" });
    state = registerInstance(state, ref, { pageId: "p3", blockId: "i2" });
    return state;
  })();

  it("returns an empty list for an empty state", () => {
    expect(brokenRefs(createSyncedBlockState(), { existingBlockIds: [] })).toEqual([]);
  });

  it("returns nothing when every instance and source exists", () => {
    expect(brokenRefs(seeded, { existingBlockIds: ["s1", "i1", "i2"] })).toEqual([]);
  });

  it("reports instances whose block is gone", () => {
    const broken = brokenRefs(seeded, { existingBlockIds: ["s1", "i1"] });
    expect(broken).toEqual([
      {
        refId: ref.refId,
        instanceId: "i2",
        pageId: "p3",
        sourceBlockId: "s1",
        sourcePageId: "p1",
        reason: "MISSING_INSTANCE",
      },
    ]);
  });

  it("reports instances whose source block is gone", () => {
    const broken = brokenRefs(seeded, { existingBlockIds: ["i1", "i2"] });
    expect(broken.map((entry) => entry.reason)).toEqual(["MISSING_SOURCE", "MISSING_SOURCE"]);
    expect(broken.map((entry) => entry.instanceId)).toEqual(["i1", "i2"]);
  });

  it("prefers MISSING_INSTANCE when both the block and source are gone", () => {
    const broken = brokenRefs(seeded, { existingBlockIds: [] });
    expect(broken.map((entry) => entry.reason)).toEqual([
      "MISSING_INSTANCE",
      "MISSING_INSTANCE",
    ]);
  });

  it("sorts the orphans by instance id", () => {
    const broken = brokenRefs(seeded, { existingBlockIds: ["s1"] });
    expect(broken.map((entry) => entry.instanceId)).toEqual(["i1", "i2"]);
  });
});

describe("describeSync", () => {
  it("describes zero instances", () => {
    expect(describeSync(ref, { count: 0 })).toBe("Synced from p1#s1 with no instances");
  });

  it("describes one instance", () => {
    expect(describeSync(ref, { count: 1 })).toBe("Synced from p1#s1 mirrored at 1 instance");
  });

  it("describes many instances", () => {
    expect(describeSync(ref, { count: 3 })).toBe("Synced from p1#s1 mirrored at 3 instances");
  });

  it("normalises a negative or fractional count", () => {
    expect(describeSync(ref, { count: -2 })).toBe("Synced from p1#s1 with no instances");
    expect(describeSync(ref, { count: 2.9 })).toBe("Synced from p1#s1 mirrored at 2 instances");
  });
});
