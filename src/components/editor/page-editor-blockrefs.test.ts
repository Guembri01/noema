import { describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";

// `page-editor.tsx` pulls in the browser-only KaTeX stylesheet and a server
// action; stub both so the pure block-reference helpers can be imported under
// vitest's node environment (same seam as `page-editor-engines.test.ts`).
vi.mock("katex/dist/katex.min.css", () => ({}));
vi.mock("@/server/actions/pages", () => ({
  updatePageAction: vi.fn(),
  getPageContentAction: vi.fn(),
}));

import {
  blockReferenceCopy,
  blockReferenceEntries,
  blockReferenceIndex,
  brokenBlockReferences,
  pmDocToReferenceBlocks,
  resolveBlockReference,
} from "@/components/editor/page-editor";
import { blockIdAt } from "@/components/editor/page-editor-blockrefs";

/*
 * `block-refs.ts` wired into the editor's block-id path: the live document is
 * projected into the engine's `Block` tree, and the engine's helpers
 * (`collectBlocks` / `extractReferences` / `missingReferences` / `resolveSynced`
 * / `copyReference`) own the reference bookkeeping.
 */

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { id: { default: null }, refBlockId: { default: null }, refBlockIds: { default: null } },
    },
    text: { group: "inline" },
  },
});

const doc = schema.nodeFromJSON({
  type: "doc",
  content: [
    { type: "paragraph", attrs: { id: "src" }, content: [{ type: "text", text: "Canonical" }] },
    { type: "paragraph", attrs: { id: "mirror", refBlockId: "src" } },
    { type: "paragraph", attrs: { id: "multi", refBlockIds: ["src", "ghost"] } },
  ],
});

describe("pmDocToReferenceBlocks (collectBlocks)", () => {
  it("projects the document into the block-refs engine tree, keeping references", () => {
    const blocks = pmDocToReferenceBlocks(doc);
    expect(blocks.map((block) => block.id)).toEqual(["src", "mirror", "multi"]);
    expect(blocks[1].refBlockId).toBe("src");
    expect(blocks[2].refBlockIds).toEqual(["src", "ghost"]);
  });

  it("indexes every block by id", () => {
    const index = blockReferenceIndex(doc);
    expect([...index.byId.keys()]).toEqual(["src", "mirror", "multi"]);
    expect(index.byId.get("src")?.type).toBe("paragraph");
  });
});

describe("blockIdAt", () => {
  it("resolves the top-level block around a text position", () => {
    const secondStart = doc.child(0).nodeSize;
    expect(blockIdAt(doc, 1)).toBe("src");
    expect(blockIdAt(doc, secondStart + 1)).toBe("mirror");
    expect(blockIdAt(doc, doc.content.size - 1)).toBe("multi");
  });
});

describe("extractReferences / missingReferences", () => {
  it("lists every block that references another", () => {
    expect(blockReferenceEntries(doc)).toEqual([
      { blockId: "mirror", refBlockIds: ["src"] },
      { blockId: "multi", refBlockIds: ["src", "ghost"] },
    ]);
  });

  it("reports referenced ids the document does not contain", () => {
    expect(brokenBlockReferences(doc)).toEqual(["ghost"]);
  });
});

describe("resolveSynced / copyReference", () => {
  it("resolves a referenced block's subtree", () => {
    const resolved = resolveBlockReference(doc, "src");
    expect(resolved?.id).toBe("src");
    expect(resolved?.type).toBe("paragraph");
  });

  it("returns null for a missing source", () => {
    expect(resolveBlockReference(doc, "ghost")).toBeNull();
  });

  it("builds the paste pair for a synced block reference", () => {
    const copy = blockReferenceCopy(doc, "src");
    expect(copy.ref).toEqual({ id: "src:ref", type: "block_ref", refBlockId: "src" });
    expect(copy.subtree?.id).toBe("src");
  });
});
