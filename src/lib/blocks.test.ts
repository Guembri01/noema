import { describe, expect, it } from "vitest";
import { Schema, Slice, type Node as PMNode } from "@tiptap/pm/model";
import {
  docFromText,
  docToMarkdown,
  prosemirrorToText,
  emptyDoc,
  wordCount,
  snapshotBlockDeletion,
  restoreBlockDeletion,
  canUndoViaHistory,
  type BlockDoc,
} from "@/lib/blocks";

const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", marks: [{ type: "bold" }], text: "world" },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
        },
      ],
    },
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] },
  ],
};

describe("blocks", () => {
  it("extracts plain text", () => {
    const text = prosemirrorToText(doc);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).toContain("one");
  });

  it("counts words", () => {
    expect(wordCount(docFromText("one two three"))).toBe(3);
    expect(wordCount(emptyDoc())).toBe(0);
  });

  it("serialises to markdown", () => {
    const md = docToMarkdown(doc);
    expect(md).toContain("# Title");
    expect(md).toContain("**world**");
    expect(md).toContain("- one");
    expect(md).toContain("```ts");
  });

  it("builds a document from text", () => {
    expect(docFromText("hi").content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "hi" }],
    });
  });
});

/**
 * B109 — the output side applies the same href allowlist the input side
 * applies (`markdown.ts#safeHref`): a stored target the allowlist refuses is
 * written as plain text, never as a link.
 */
describe("docToMarkdown link targets (B109)", () => {
  const linkDoc = (href: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] }],
      },
    ],
  });

  it("writes a refused target as plain text, without the target", () => {
    const md = docToMarkdown(linkDoc("javascript:alert(1)"));
    expect(md).toBe("click");
    expect(md).not.toContain("javascript:");
  });

  it("keeps the allowlisted targets", () => {
    expect(docToMarkdown(linkDoc("https://example.com/a"))).toBe("[click](https://example.com/a)");
    expect(docToMarkdown(linkDoc("mailto:a@b.co"))).toBe("[click](mailto:a@b.co)");
    expect(docToMarkdown(linkDoc("tel:+1234"))).toBe("[click](tel:+1234)");
    expect(docToMarkdown(linkDoc("/w/demo/page"))).toBe("[click](/w/demo/page)");
    expect(docToMarkdown(linkDoc("#anker"))).toBe("[click](#anker)");
  });
});

/* ---------------------------------------------------------------------------
   Block deletion snapshot / restore (B03: undo affordance for block delete)
   --------------------------------------------------------------------------- */

const pmSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph+" },
    text: { inline: true, group: "inline" },
  },
  marks: { bold: {} },
});

const pmP = (text: string) => pmSchema.nodes.paragraph.create(null, pmSchema.text(text));
const pmDoc = (...blocks: PMNode[]) => pmSchema.nodes.doc.create(null, blocks);
const pmLi = (text: string) => pmSchema.nodes.listItem.create(null, pmP(text));
const pmList = (...items: PMNode[]) => pmSchema.nodes.bulletList.create(null, items);
const pmPJson = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

/** Absolute position of the first block of `type` whose textContent matches exactly. */
function blockPos(doc: PMNode, text: string, type = "paragraph"): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === type && node.textContent === text) found = pos;
    return found === -1;
  });
  return found;
}

describe("block deletion snapshot/restore", () => {
  it("captures the child path and JSON of a top-level block", () => {
    const doc = pmDoc(pmP("one"), pmP("two"), pmP("three"));
    const snap = snapshotBlockDeletion(doc, blockPos(doc, "two"));
    expect(snap).not.toBeNull();
    expect(snap!.path).toEqual([1]);
    expect(snap!.node).toEqual(pmPJson("two"));
  });

  it("captures a nested block inside a list item with its full path", () => {
    const doc = pmDoc(pmList(pmLi("alpha"), pmLi("beta")));
    const snap = snapshotBlockDeletion(doc, blockPos(doc, "beta"));
    expect(snap).not.toBeNull();
    expect(snap!.path).toEqual([0, 1, 0]);
    expect(snap!.node).toEqual(pmPJson("beta"));
  });

  it("refuses positions inside a text run or past the document end", () => {
    const doc = pmDoc(pmP("one"));
    expect(snapshotBlockDeletion(doc, 1)).toBeNull(); // start of the text node
    expect(snapshotBlockDeletion(doc, 3)).toBeNull(); // middle of "one"
    expect(snapshotBlockDeletion(doc, doc.content.size)).toBeNull(); // end
    expect(snapshotBlockDeletion(doc, -1)).toBeNull();
  });

  it("round-trips a top-level block: snapshot, delete, restore equals the original", () => {
    const original = pmDoc(pmP("one"), pmP("two"), pmP("three"));
    const pos = blockPos(original, "two");
    const snap = snapshotBlockDeletion(original, pos);
    expect(snap).not.toBeNull();
    const deleted = original.child(1);
    const afterDelete = original.replace(pos, pos + deleted.nodeSize, Slice.empty);
    expect(afterDelete.childCount).toBe(2);
    const restored = restoreBlockDeletion(afterDelete.toJSON() as BlockDoc, snap!);
    expect(restored).toEqual(original.toJSON());
  });

  it("restores a nested block into a shrunken doc, clamping the stale item index", () => {
    const original = pmDoc(pmList(pmLi("first"), pmLi("second")));
    const snap = snapshotBlockDeletion(original, blockPos(original, "first"));
    expect(snap!.path).toEqual([0, 0, 0]);
    // The list shrank to a single (different) item after another edit:
    const shrunken = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [pmPJson("second")] }],
        },
      ],
    } as unknown as BlockDoc;
    const restored = restoreBlockDeletion(shrunken, snap!);
    const item = restored.content![0].content![0];
    expect(item.content).toEqual([pmPJson("first"), pmPJson("second")]);
  });

  it("clamps an out-of-range top-level index and appends at the end", () => {
    const snap = { path: [2], node: pmPJson("two") };
    const small = { type: "doc", content: [pmPJson("one")] } as unknown as BlockDoc;
    const restored = restoreBlockDeletion(small, snap);
    expect(restored.content).toHaveLength(2);
    expect(restored.content![1]).toEqual(snap.node);
  });

  it("clamps a stale intermediate index but still restores at the reachable level", () => {
    const snap = { path: [0, 5, 0], node: pmPJson("deep") };
    const current = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [pmPJson("only")] }],
        },
      ],
    } as unknown as BlockDoc;
    const restored = restoreBlockDeletion(current, snap);
    // item index 5 clamps to the single item; paragraph index 0 prepends there
    const item = restored.content![0].content![0];
    expect(item.content![0]).toEqual(pmPJson("deep"));
    expect(item.content![1]).toEqual(pmPJson("only"));
  });

  it("stops descending at a textblock and inserts as a sibling instead", () => {
    // path says the block lived inside a paragraph — impossible; the restore
    // must not produce a paragraph inside a paragraph.
    const snap = { path: [1, 0], node: pmPJson("sibling") };
    const current = { type: "doc", content: [pmPJson("one")] } as unknown as BlockDoc;
    const restored = restoreBlockDeletion(current, snap);
    expect(restored.content).toHaveLength(2);
    expect(restored.content![0]).toEqual(pmPJson("one"));
    expect(restored.content![1]).toEqual(pmPJson("sibling"));
    for (const block of restored.content!) {
      expect(block.type).toBe("paragraph");
    }
  });

  it("does not mutate the input document or share the restored node", () => {
    const input = { type: "doc", content: [pmPJson("one")] } as unknown as BlockDoc;
    const snap = { path: [0], node: pmPJson("two") };
    const restored = restoreBlockDeletion(input, snap);
    expect(input.content).toHaveLength(1);
    restored.content!.push(pmPJson("three"));
    expect(snap.node).toEqual(pmPJson("two")); // restore clone, not the snapshot
    expect(input.content).toHaveLength(1);
  });
});

describe("canUndoViaHistory", () => {
  it("allows undo when the history extension is registered", () => {
    expect(canUndoViaHistory(["paragraph", "undoRedo"])).toBe(true);
    expect(canUndoViaHistory(["history"])).toBe(true); // legacy name
  });

  it("denies undo in collaborative mode where history is disabled", () => {
    expect(canUndoViaHistory(["undoRedo", "collaboration"])).toBe(false);
    expect(canUndoViaHistory(["collaboration"])).toBe(false);
  });

  it("denies undo when no history extension is present at all", () => {
    expect(canUndoViaHistory([])).toBe(false);
    expect(canUndoViaHistory(["paragraph", "text"])).toBe(false);
  });
});
