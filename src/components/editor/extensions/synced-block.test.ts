import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { createSyncedBlockState, createSyncRef } from "@/lib/synced-blocks";
import {
  collectSyncedMirrorUpdates,
  detachedSnapshotJson,
  findBlockJsonById,
  findBlockNodeById,
  pmDocToSyncBlocks,
  planRegisterSyncedInstance,
  planSyncedDetach,
  planSyncedPropagation,
  resolveSyncedContent,
  syncBlockText,
  syncBlockToPmJson,
  syncSnapshotDoc,
  syncedAttrsFromRef,
  syncedMarkerProps,
  syncedNodeTargetsSource,
  syncedRefFromAttrs,
  syncedSourceOfInstance,
} from "./synced-block";

/*
 * The engine→renderer seam for the synced-block node: a live ProseMirror
 * document → the `synced-blocks.ts` engine (`resolveSync` / `registerInstance` /
 * `propagateEdit` / `detachInstance` / `sourceMarker`) → the node's props.
 */

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { id: { default: null }, refBlockId: { default: null }, refBlockIds: { default: null } },
    },
    blockquote: {
      group: "block",
      content: "block+",
      attrs: { id: { default: null } },
    },
    syncedBlock: {
      group: "block",
      atom: true,
      attrs: {
        id: { default: null },
        refId: { default: null },
        sourceBlockId: { default: null },
        sourcePageId: { default: null },
        sourcePageTitle: { default: null },
        content: { default: "" },
        readOnly: { default: false },
        instanceId: { default: null },
      },
    },
    text: { group: "inline" },
  },
});

const doc = schema.nodeFromJSON({
  type: "doc",
  content: [
    { type: "paragraph", attrs: { id: "src" }, content: [{ type: "text", text: "Canonical body" }] },
    { type: "paragraph", attrs: { id: "mirror", refBlockId: "src" } },
    { type: "paragraph", attrs: { id: "multi", refBlockIds: ["src", "ghost"] } },
  ],
});

const ref = createSyncRef({ sourceBlockId: "src", sourcePageId: "p1" });

describe("pmDocToSyncBlocks + resolveSyncedContent (resolveSync)", () => {
  it("lifts the document into the engine's generic tree", () => {
    const blocks = pmDocToSyncBlocks(doc);
    expect(blocks.map((block) => block.id)).toEqual(["src", "mirror", "multi"]);
    expect(blocks[0].type).toBe("paragraph");
    expect(syncBlockText(blocks[0])).toBe("Canonical body");
  });

  it("resolves the canonical content from the live document", () => {
    const attrs = syncedAttrsFromRef(ref);
    const content = resolveSyncedContent(attrs, pmDocToSyncBlocks(doc));
    expect(content?.id).toBe("src");
    expect(syncBlockText(content)).toBe("Canonical body");
  });

  it("falls back to the stored snapshot when the source is gone", () => {
    const snapshot = { id: "gone", type: "paragraph", text: "snapshot text" };
    const attrs = syncedAttrsFromRef(
      createSyncRef({ sourceBlockId: "gone", sourcePageId: "p1" }),
      snapshot,
    );
    expect(resolveSyncedContent(attrs, pmDocToSyncBlocks(doc))).toEqual(snapshot);
  });
});

describe("syncedRefFromAttrs / syncedAttrsFromRef", () => {
  it("derives a deterministic ref id from the source coordinates", () => {
    const attrs = syncedAttrsFromRef(ref);
    expect(syncedRefFromAttrs(attrs)?.refId).toBe(ref.refId);
    expect(syncedRefFromAttrs(attrs)?.refId).toBe(syncedRefFromAttrs(syncedAttrsFromRef(ref))?.refId);
  });

  it("returns null when the source is blank", () => {
    expect(syncedRefFromAttrs({ sourceBlockId: "", sourcePageId: "p1" })).toBeNull();
  });
});

describe("syncedMarkerProps (sourceMarker)", () => {
  it("renders the canonical source marker with a deep link", () => {
    const marker = syncedMarkerProps(syncedAttrsFromRef(ref));
    expect(marker?.label).toBe("Synced from p1");
    expect(marker?.href).toBe("/w/p1#src");
    expect(marker?.readOnly).toBe(false);
  });

  it("honours read-only mirrors", () => {
    expect(syncedMarkerProps(syncedAttrsFromRef(ref, undefined, true))?.readOnly).toBe(true);
  });
});

describe("registerInstance / propagateEdit / detachInstance wrappers", () => {
  it("registers an instance and indexes it against its source", () => {
    const registered = planRegisterSyncedInstance(
      createSyncedBlockState(),
      syncedAttrsFromRef(ref),
      { blockId: "inst1" },
    );
    expect(registered).not.toBeNull();
    const state = registered ?? createSyncedBlockState();
    expect(state.instances.inst1?.refId).toBe(ref.refId);
    expect(state.instancesBySource.src).toEqual(["inst1"]);
    expect(syncedSourceOfInstance(state, syncedAttrsFromRef(ref))).toBeNull();
    expect(syncedSourceOfInstance(state, { instanceId: "inst1" })?.sourceBlockId).toBe("src");
  });

  it("propagates a canonical edit into every instance, preserving instance attrs", () => {
    const first = planRegisterSyncedInstance(createSyncedBlockState(), syncedAttrsFromRef(ref), {
      blockId: "inst1",
    });
    expect(first).not.toBeNull();
    const second = planRegisterSyncedInstance(first ?? createSyncedBlockState(), syncedAttrsFromRef(ref), {
      blockId: "inst2",
    });
    expect(second).not.toBeNull();
    const result = planSyncedPropagation(
      second ?? createSyncedBlockState(),
      ref.refId,
      { id: "src", type: "paragraph", text: "v2" },
    );
    expect(result.count).toBe(2);
    expect(result.plans.map((plan) => plan.instanceId)).toEqual(["inst1", "inst2"]);
    expect(result.plans[0].content).toEqual({ id: "src", type: "paragraph", text: "v2" });
    expect(result.state.content[ref.refId]).toEqual({ id: "src", type: "paragraph", text: "v2" });
  });

  it("detaches one instance and hands back its snapshot", () => {
    const first = planRegisterSyncedInstance(createSyncedBlockState(), syncedAttrsFromRef(ref), {
      blockId: "inst1",
    });
    expect(first).not.toBeNull();
    const edited = planSyncedPropagation(first ?? createSyncedBlockState(), ref.refId, {
      id: "src",
      type: "paragraph",
      text: "snap",
    }).state;
    const result = planSyncedDetach(edited, { refId: ref.refId, instanceId: "inst1" });
    expect(result.detached).toBe(true);
    expect(result.snapshot).toEqual({ id: "src", type: "paragraph", text: "snap" });
    expect(result.state.instances.inst1).toBeUndefined();
  });

  it("reports whether a node targets a given source block", () => {
    expect(syncedNodeTargetsSource(syncedAttrsFromRef(ref), "src")).toBe(true);
    expect(syncedNodeTargetsSource(syncedAttrsFromRef(ref), "other")).toBe(false);
  });
});

describe("syncBlockToPmJson", () => {
  it("converts a snapshot back into TipTap JSON without losing text", () => {
    const json = syncBlockToPmJson({
      id: "src",
      type: "paragraph",
      children: [{ id: "", type: "text", text: "hello" }],
    });
    expect(json).toEqual({
      type: "paragraph",
      attrs: { id: "src" },
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("keeps ProseMirror attrs, marks and content verbatim", () => {
    const snapshot = {
      id: "src",
      type: "paragraph",
      attrs: { id: "src", textAlign: "center" },
      content: [
        { type: "text", text: "hello", marks: [{ type: "bold" }] },
      ],
    };
    expect(syncBlockToPmJson(snapshot)).toEqual(snapshot);
    expect(syncSnapshotDoc(snapshot)).toEqual({
      type: "doc",
      content: [snapshot],
    });
  });

  it("gives a detached copy fresh ids so it cannot collide with its source", () => {
    const snapshot = {
      type: "blockquote",
      attrs: { id: "source-id" },
      content: [
        { type: "paragraph", attrs: { id: "child-id" }, content: [{ type: "text", text: "x" }] },
      ],
    };
    const detached = detachedSnapshotJson(snapshot as never);
    expect(detached.attrs?.id).toBeTruthy();
    expect(detached.attrs?.id).not.toBe("source-id");
    const child = detached.content?.[0] as { attrs?: { id?: string } } | undefined;
    expect(child?.attrs?.id).toBeTruthy();
    expect(child?.attrs?.id).not.toBe("child-id");
    expect(snapshot.attrs.id).toBe("source-id");
  });
});

describe("same-page source lookup and propagation", () => {
  const sourceJson = {
    type: "paragraph",
    attrs: { id: "src" },
    content: [{ type: "text", text: "Source" }],
  };
  const staleJson = {
    type: "paragraph",
    attrs: { id: "src" },
    content: [{ type: "text", text: "stale" }],
  };
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      sourceJson,
      {
        type: "syncedBlock",
        attrs: {
          id: "mirror",
          sourceBlockId: "src",
          sourcePageId: "p1",
          content: JSON.stringify(staleJson),
          instanceId: "inst",
        },
      },
    ],
  });

  it("finds a source node by its stable block id", () => {
    expect(findBlockNodeById(doc, "src")?.textContent).toBe("Source");
    expect(findBlockNodeById(doc, "missing")).toBeNull();
  });

  it("finds a block in a stored cross-page document", () => {
    expect(findBlockJsonById({ type: "doc", content: [sourceJson] }, "src")).toEqual(
      sourceJson,
    );
    expect(findBlockJsonById({ type: "doc", content: [sourceJson] }, "missing")).toBeNull();
  });

  it("reports a stale mirror with the source snapshot", () => {
    const updates = collectSyncedMirrorUpdates(doc);
    expect(updates).toHaveLength(1);
    expect(updates[0].sourceBlockId).toBe("src");
    expect(JSON.parse(updates[0].content)).toMatchObject({
      type: "paragraph",
      attrs: { id: "src" },
      content: [{ type: "text", text: "Source" }],
    });
  });

  it("leaves an up-to-date mirror alone", () => {
    const fresh = schema.nodeFromJSON({
      type: "doc",
      content: [
        sourceJson,
        {
          type: "syncedBlock",
          attrs: {
            sourceBlockId: "src",
            sourcePageId: "p1",
            content: JSON.stringify(doc.child(0).toJSON()),
          },
        },
      ],
    });
    expect(collectSyncedMirrorUpdates(fresh)).toEqual([]);
  });
});
