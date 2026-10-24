import { describe, expect, it } from "vitest";
import { getSchema, resolveExtensions } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { applyOne, applySuggestions, createSuggestions, type Block } from "@/lib/suggestions";
import { InputRules } from "./input-rules";
import {
  alignBlockIds,
  blockFromNode,
  deleteAnchorIndex,
  getSmartSuggestionsState,
  SmartSuggestions,
  suggestionDeleteStyle,
  suggestionsPluginKey,
  type BlockSource,
} from "./suggestions";

/**
 * Unit coverage for the editor half of Suggestions (track-changes) mode.
 *
 * The engine (`src/lib/suggestions.ts`) is tested on its own; these tests cover
 * the *bridge* this extension adds on top of it: the identity alignment that
 * turns live ProseMirror nodes into engine blocks with stable ids, the delete
 * anchor used to place a marker, and the registration/wiring through
 * `InputRules.addExtensions`. DOM-free (vitest runs in a `node` environment), so
 * the live editor commands/decorations are covered by the composition tests and
 * the wiring test rather than by mounting an editor.
 */

const paragraph = (text: string): BlockSource => ({
  type: { name: "paragraph" },
  isTextblock: true,
  textContent: text,
});
const heading = (text: string): BlockSource => ({
  type: { name: "heading" },
  isTextblock: true,
  textContent: text,
});
const leaf = (name: string): BlockSource => ({
  type: { name },
  isTextblock: false,
  textContent: "",
});

const base: Block[] = [
  { id: "b1", type: "paragraph", text: "one" },
  { id: "b2", type: "paragraph", text: "two" },
  { id: "b3", type: "paragraph", text: "three" },
];

/** Fresh-id factory that records how many ids it minted. */
function counter(): { fresh: (ordinal: number) => string; minted: string[] } {
  const minted: string[] = [];
  return {
    minted,
    fresh: (ordinal: number) => {
      const id = `f${ordinal}`;
      minted.push(id);
      return id;
    },
  };
}

const ids = (blocks: readonly Block[]): string[] => blocks.map((block) => block.id);

describe("blockFromNode", () => {
  it("keeps text for textblocks and drops it for structural nodes", () => {
    expect(blockFromNode("i", paragraph("hi"))).toEqual({
      id: "i",
      type: "paragraph",
      text: "hi",
    });
    expect(blockFromNode("i", leaf("image"))).toEqual({ id: "i", type: "image" });
  });
});

describe("alignBlockIds — base/editor identity bridge", () => {
  it("keeps every id when nothing changed", () => {
    const { fresh } = counter();
    const result = alignBlockIds(
      base,
      [paragraph("one"), paragraph("two"), paragraph("three")],
      fresh,
    );
    expect(ids(result.blocks)).toEqual(["b1", "b2", "b3"]);
    expect(result.fresh).toBe(0);
  });

  it("mints one fresh id for an inserted block and shifts nothing else", () => {
    const { fresh } = counter();
    const result = alignBlockIds(
      base,
      [paragraph("one"), paragraph("inserted"), paragraph("two"), paragraph("three")],
      fresh,
    );
    expect(ids(result.blocks)).toEqual(["b1", "f0", "b2", "b3"]);
    expect(result.blocks[1].text).toBe("inserted");
    expect(result.fresh).toBe(1);
  });

  it("drops a deleted block's id without touching the survivors", () => {
    const { fresh } = counter();
    const result = alignBlockIds(base, [paragraph("one"), paragraph("three")], fresh);
    expect(ids(result.blocks)).toEqual(["b1", "b3"]);
    expect(result.fresh).toBe(0);
  });

  it("reuses the base id for an edited block (so the engine sees a replace)", () => {
    const { fresh } = counter();
    const result = alignBlockIds(
      base,
      [paragraph("one"), paragraph("TWO!"), paragraph("three")],
      fresh,
    );
    expect(ids(result.blocks)).toEqual(["b1", "b2", "b3"]);
    expect(result.blocks[1].text).toBe("TWO!");
    expect(result.fresh).toBe(0);
  });

  it("reuses the base id for a type-only change", () => {
    const { fresh } = counter();
    const result = alignBlockIds(
      base,
      [paragraph("one"), heading("two"), paragraph("three")],
      fresh,
    );
    expect(ids(result.blocks)).toEqual(["b1", "b2", "b3"]);
    expect(result.blocks[1].type).toBe("heading");
  });

  it("treats a completely new document as entirely fresh", () => {
    const { fresh } = counter();
    const result = alignBlockIds([], [paragraph("x"), paragraph("y")], fresh);
    expect(ids(result.blocks)).toEqual(["f0", "f1"]);
    expect(result.fresh).toBe(2);
  });

  it("handles the empty document", () => {
    const { fresh } = counter();
    const result = alignBlockIds(base, [], fresh);
    expect(result.blocks).toEqual([]);
    expect(result.fresh).toBe(0);
  });
});

describe("alignBlockIds → createSuggestions (engine composition)", () => {
  it("reports a replace for an edited block and an insert for a new one", () => {
    const { fresh } = counter();
    const nodes = [paragraph("one"), paragraph("TWO!"), paragraph("inserted"), paragraph("three")];
    const aligned = alignBlockIds(base, nodes, fresh);
    const suggestions = createSuggestions(base, aligned.blocks);

    const replace = suggestions.find((suggestion) => suggestion.blockId === "b2");
    expect(replace?.kind).toBe("replace");
    expect(replace?.before?.text).toBe("two");
    expect(replace?.after?.text).toBe("TWO!");

    const insert = suggestions.find((suggestion) => suggestion.kind === "insert");
    expect(insert?.blockId).toBe("f0");
    expect(insert?.after?.text).toBe("inserted");
  });

  it("reports a delete when a block disappears", () => {
    const { fresh } = counter();
    const aligned = alignBlockIds(base, [paragraph("one"), paragraph("three")], fresh);
    const suggestions = createSuggestions(base, aligned.blocks);
    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(["delete"]);
    expect(suggestions[0].blockId).toBe("b2");
  });

  it("accepting advances the base so the suggestion stops being a diff", () => {
    const { fresh } = counter();
    const nodes = [paragraph("one"), paragraph("TWO!"), paragraph("three")];
    const aligned = alignBlockIds(base, nodes, fresh);
    const suggestions = createSuggestions(base, aligned.blocks);
    const replace = suggestions.find((suggestion) => suggestion.blockId === "b2");
    if (!replace) throw new Error("expected a replace suggestion");

    const nextBase = applyOne(base, replace, "accept");
    const realigned = alignBlockIds(nextBase, nodes, counter().fresh);
    expect(createSuggestions(nextBase, realigned.blocks)).toEqual([]);
  });

  it("accept-all reconstructs the proposed document and clears the diff", () => {
    const { fresh } = counter();
    const nodes = [paragraph("one"), paragraph("TWO!"), paragraph("three")];
    const aligned = alignBlockIds(base, nodes, fresh);
    const suggestions = createSuggestions(base, aligned.blocks);

    const accepted = applySuggestions(base, suggestions, "accept");
    const realigned = alignBlockIds(accepted, nodes, counter().fresh);
    expect(createSuggestions(accepted, realigned.blocks)).toEqual([]);
  });
});

describe("deleteAnchorIndex", () => {
  const a: Block = { id: "a", type: "paragraph", text: "A" };
  const b: Block = { id: "b", type: "paragraph", text: "B" };
  const c: Block = { id: "c", type: "paragraph", text: "C" };

  it("points at the next surviving block's document index", () => {
    expect(deleteAnchorIndex([a, b, c], [a, c], "b")).toBe(1);
  });

  it("falls back to the end of the document for a trailing delete", () => {
    expect(deleteAnchorIndex([a, b], [a], "b")).toBe(1);
  });

  it("falls back to the end for an unknown id", () => {
    expect(deleteAnchorIndex([a, b], [a, b], "missing")).toBe(2);
  });
});

describe("SmartSuggestions wiring", () => {
  const resolved = resolveExtensions([StarterKit, InputRules]);
  const schema = getSchema([StarterKit, InputRules]);

  it("is registered through InputRules.addExtensions without duplicating names", () => {
    const names = resolved.map((extension) => extension.name);
    expect(names).toContain("smartSuggestions");
    expect(names).toContain("inputRules");
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not disturb the schema it composes with", () => {
    expect(schema.nodes.paragraph).toBeDefined();
    expect(schema.nodes.heading).toBeDefined();
    expect(SmartSuggestions.name).toBe("smartSuggestions");
  });

  it("exposes the track-changes commands", () => {
    const addCommands = SmartSuggestions.config.addCommands as unknown as
      | (() => Record<string, unknown>)
      | undefined;
    const commands = (addCommands?.call({} as never) ?? {}) as Record<string, unknown>;
    expect(Object.keys(commands)).toEqual(
      expect.arrayContaining([
        "setSuggesting",
        "hydrateSuggestions",
        "acceptSuggestion",
        "rejectSuggestion",
        "acceptAll",
        "rejectAll",
      ]),
    );
  });

  it("hydrates a persisted base and recomputes the pending diff", () => {
    const editorState = EditorState.create({
      schema,
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "new" }] },
        ],
      }),
      plugins: (
        SmartSuggestions.config.addProseMirrorPlugins as unknown as
          | (() => import("@tiptap/pm/state").Plugin[])
          | undefined
      )?.call({} as never) ?? [],
    });

    const base: Block[] = [{ id: "b1", type: "paragraph", text: "old" }];
    const hydrated = editorState.apply(
      editorState.tr.setMeta(suggestionsPluginKey, {
        type: "hydrate",
        base,
        authorId: "u1",
      }),
    );
    const value = getSmartSuggestionsState(hydrated);
    expect(value?.active).toBe(true);
    expect(value?.base).toEqual(base);
    expect(value?.authorId).toBe("u1");
    expect(value?.suggestions).toHaveLength(1);
    expect(value?.suggestions[0]).toMatchObject({
      kind: "replace",
      blockId: "b1",
      before: { text: "old" },
      after: { text: "new" },
    });
  });
});

describe("suggestionDeleteStyle — token-only marker chrome", () => {
  it("uses the danger tokens instead of the old raw hex", () => {
    const css = suggestionDeleteStyle();
    expect(css).toContain("background:var(--danger-soft)");
    expect(css).toContain("color:var(--danger)");
    expect(css).toContain("border-radius:var(--radius-sm)");
    expect(css).toContain("text-decoration:line-through");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });
});
