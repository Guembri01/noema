import { describe, expect, it } from "vitest";
import { getSchema, resolveExtensions } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { InputRules } from "./input-rules";
import {
  BlockIds,
  blockIdsTransaction,
  ensureBlockIds,
  planBlockIds,
  type BlockIdFactory,
} from "./block-ids";

/**
 * Stable block ids (B96 follow-up): every **top-level** block gets a unique,
 * persistent `id` so `deep-links.ts` can build a `#<blockId>` anchor that
 * survives edits and reorders instead of the old offset-based `#block-<pos>`.
 *
 * The minting/dedupe logic is pure (`planBlockIds` / `ensureBlockIds`) and is
 * what the tests below pin down; the ProseMirror plugin is a thin adapter on
 * top of `blockIdsTransaction`. The schema is built through the real
 * `[StarterKit, BlockIds]` pair so the global `id` attribute is exercised, not
 * mocked.
 */
const schema = getSchema([StarterKit, BlockIds]);

function paragraph(text: string | null = null, id: string | null = null): PMNode {
  return schema.nodes.paragraph.create(
    id === null ? null : { id },
    text === null ? undefined : schema.text(text),
  );
}

function docOf(...nodes: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, nodes);
}

/** A deterministic factory: `prefix-1`, `prefix-2`, … */
function sequence(prefix: string): BlockIdFactory {
  let ordinal = 0;
  return () => `${prefix}-${(ordinal += 1)}`;
}

/** The top-level offsets a document's children start at. */
function offsetsOf(doc: PMNode): number[] {
  const offsets: number[] = [];
  doc.forEach((_node, offset) => {
    offsets.push(offset);
  });
  return offsets;
}

describe("planBlockIds", () => {
  it("mints an id for every top-level block that lacks one, in document order", () => {
    const doc = docOf(paragraph("A"), paragraph("B"), paragraph("C"));
    const assignments = planBlockIds(doc, sequence("id"));
    expect(assignments.map((assignment) => assignment.id)).toEqual([
      "id-1",
      "id-2",
      "id-3",
    ]);
    expect(assignments.map((assignment) => assignment.offset)).toEqual(offsetsOf(doc));
  });

  it("keeps existing ids and never calls the factory for them", () => {
    const doc = docOf(paragraph("A", "keep-1"), paragraph("B", "keep-2"));
    let calls = 0;
    const assignments = planBlockIds(doc, () => {
      calls += 1;
      return "unused";
    });
    expect(assignments).toEqual([]);
    expect(calls).toBe(0);
  });

  it("re-mints duplicate ids: the first occurrence wins", () => {
    const doc = docOf(paragraph("A", "dup"), paragraph("B", "dup"));
    const assignments = planBlockIds(doc, sequence("mint"));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toEqual({ offset: doc.child(0).nodeSize, id: "mint-1" });
  });

  it("treats an empty or whitespace id as missing", () => {
    const doc = docOf(paragraph("A", ""), paragraph("B", "   "));
    const assignments = planBlockIds(doc, sequence("id"));
    expect(assignments.map((assignment) => assignment.id)).toEqual(["id-1", "id-2"]);
  });

  it("skips ids already present anywhere in the document when minting", () => {
    // `taken` exists later in the doc, so the minted value must avoid it.
    const doc = docOf(paragraph("A"), paragraph("B", "taken"));
    const values = ["taken", "free"];
    let index = 0;
    const assignments = planBlockIds(doc, () => values[index++] ?? `extra-${index}`);
    expect(assignments.map((assignment) => assignment.id)).toEqual(["free"]);
  });

  it("keeps minted ids unique even when the factory keeps colliding", () => {
    const doc = docOf(paragraph("A"), paragraph("B"));
    const assignments = planBlockIds(doc, () => "same");
    expect(assignments[0].id).toBe("same");
    expect(assignments[1].id).not.toBe("same");
    expect(new Set(assignments.map((assignment) => assignment.id)).size).toBe(2);
  });
});

describe("ensureBlockIds", () => {
  it("returns a new document with ids assigned to top-level blocks", () => {
    const doc = docOf(paragraph("A"), paragraph("B"));
    const { doc: next, assignments } = ensureBlockIds(doc, sequence("id"));
    expect(assignments).toHaveLength(2);
    expect(next.child(0).attrs.id).toBe("id-1");
    expect(next.child(1).attrs.id).toBe("id-2");
    expect(next.child(0).textContent).toBe("A");
  });

  it("returns the same document instance when nothing needs changing", () => {
    const doc = docOf(paragraph("A", "id-1"), paragraph("B", "id-2"));
    const { doc: next, assignments } = ensureBlockIds(doc, () => {
      throw new Error("factory should not run");
    });
    expect(next).toBe(doc);
    expect(assignments).toEqual([]);
  });

  it("keeps existing ids across a reorder", () => {
    // Same ids, different order: nothing to mint, order untouched.
    const doc = docOf(paragraph("B", "id-2"), paragraph("A", "id-1"));
    const { doc: next } = ensureBlockIds(doc, sequence("mint"));
    expect(next).toBe(doc);
    expect(next.child(0).attrs.id).toBe("id-2");
    expect(next.child(1).attrs.id).toBe("id-1");
  });

  it("mints only for top-level blocks; nested nodes stay id-less", () => {
    const inner = paragraph("x");
    const item = schema.nodes.listItem.create(null, inner);
    const list = schema.nodes.bulletList.create(null, item);
    const doc = docOf(list);

    const { doc: next } = ensureBlockIds(doc, sequence("id"));
    expect(next.child(0).attrs.id).toBe("id-1");
    expect(next.child(0).child(0).attrs.id).toBeNull();
    expect(next.child(0).child(0).child(0).attrs.id).toBeNull();
    expect(next.child(0).child(0).child(0).textContent).toBe("x");
  });

  it("is idempotent", () => {
    const doc = docOf(paragraph("A"), paragraph("B"));
    const { doc: once } = ensureBlockIds(doc, sequence("id"));
    const assignments = planBlockIds(once, () => {
      throw new Error("factory should not run");
    });
    expect(assignments).toEqual([]);
  });

  it("preserves the whole document through a JSON round-trip", () => {
    const { doc: next } = ensureBlockIds(docOf(paragraph("A"), paragraph("B")), sequence("id"));
    const reloaded = schema.nodeFromJSON(JSON.parse(JSON.stringify(next.toJSON())));
    expect(reloaded.child(0).attrs.id).toBe("id-1");
    expect(reloaded.child(1).attrs.id).toBe("id-2");
    expect(reloaded.eq(next)).toBe(true);
    expect(
      planBlockIds(reloaded, () => {
        throw new Error("factory should not run");
      }),
    ).toEqual([]);
  });
});

describe("BlockIds extension", () => {
  it("adds an optional global `id` attribute that is not copied on split", () => {
    const addGlobalAttributes = BlockIds.config.addGlobalAttributes as unknown as
      | (() => {
          types: unknown;
          attributes: Record<string, { default?: unknown; keepOnSplit?: boolean }>;
        }[])
      | undefined;
    const groups = (addGlobalAttributes?.call({} as never) ?? []) as ReturnType<
      NonNullable<typeof addGlobalAttributes>
    >;
    expect(groups[0].types).toBe("nodes");
    expect(groups[0].attributes.id?.default).toBeNull();
    expect(groups[0].attributes.id?.keepOnSplit).toBe(false);
  });

  it("bakes the id attribute into the schema", () => {
    expect(schema.nodes.paragraph.spec.attrs).toHaveProperty("id");
    expect(schema.nodes.paragraph.spec.attrs?.id).toEqual({ default: null });
  });

  it("renders data-block-id only when the block has an id", () => {
    const toDOM = schema.nodes.paragraph.spec.toDOM;
    const withId = JSON.stringify(toDOM?.(paragraph("A", "blk-9")));
    const withoutId = JSON.stringify(toDOM?.(paragraph("A")));
    expect(withId).toContain("data-block-id");
    expect(withId).toContain("blk-9");
    expect(withoutId).not.toContain("data-block-id");
  });
});

describe("BlockIds wiring through InputRules", () => {
  const resolved = resolveExtensions([StarterKit, InputRules]);
  const inputSchema = getSchema([StarterKit, InputRules]);

  it("is flattened in without duplicating extension names", () => {
    const names = resolved.map((extension) => extension.name);
    expect(names).toContain("blockIds");
    expect(names).toContain("inputRules");
    expect(new Set(names).size).toBe(names.length);
  });

  it("adds the block id attribute to the shared schema", () => {
    expect(inputSchema.nodes.paragraph.spec.attrs).toHaveProperty("id");
    expect(BlockIds.name).toBe("blockIds");
  });
});

describe("blockIdsTransaction", () => {
  it("assigns ids on a changed document and then settles", () => {
    const state = EditorState.create({ schema, doc: docOf(paragraph("A"), paragraph("B")) });
    const change = state.tr.insertText("!", 1, 1);
    const changedState = state.apply(change);

    const appended = blockIdsTransaction([change], changedState, sequence("id"));
    expect(appended).not.toBeNull();
    const finalState = changedState.apply(appended!);
    expect(finalState.doc.child(0).attrs.id).toBe("id-1");
    expect(finalState.doc.child(1).attrs.id).toBe("id-2");

    expect(
      blockIdsTransaction([appended!], finalState, () => {
        throw new Error("factory should not run");
      }),
    ).toBeNull();
  });

  it("ignores selection-only transactions", () => {
    const state = EditorState.create({ schema, doc: docOf(paragraph("A")) });
    expect(
      blockIdsTransaction([state.tr], state, () => {
        throw new Error("factory should not run");
      }),
    ).toBeNull();
  });
});
