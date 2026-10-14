import { describe, expect, it } from "vitest";
import { getSchema, resolveExtensions } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { ClearFormatting } from "./clear-formatting";
import { InputRules } from "./input-rules";

/**
 * Registration wiring for the text-formatting slice (clear formatting +
 * subscript/superscript).
 *
 * `page-editor.tsx` is off-limits for this slice, so the extensions are
 * anchored to the editor through `InputRules.addExtensions()` — TipTap v3's
 * `addExtensions` hook, the same mechanism StarterKit bundles with. These
 * tests flatten that list exactly like `Editor` does and prove the marks
 * land in the schema next to the StarterKit / TextStyle / Highlight marks
 * they must compose with (the same extension set `page-editor.tsx` mounts).
 */
const extensions = [StarterKit, TextStyle, Highlight, InputRules];
const resolved = resolveExtensions(extensions);
const schema = getSchema(extensions);

describe("text-formatting extension wiring", () => {
  it("flattens the anchored extensions into the list (no duplicate names)", () => {
    const names = resolved.map((extension) => extension.name);
    expect(names).toEqual(
      expect.arrayContaining(["inputRules", "clearFormatting", "subscript", "superscript"]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts both script marks in the schema alongside StarterKit's marks", () => {
    expect(Object.keys(schema.marks)).toEqual(
      expect.arrayContaining([
        "subscript",
        "superscript",
        "bold",
        "italic",
        "underline",
        "strike",
        "code",
        "link",
        "highlight",
        "textStyle",
      ]),
    );
  });

  it("keeps sub/superscript mutually exclusive but composable with the rest", () => {
    const { subscript, superscript, bold, link, textStyle } = schema.marks;
    expect(subscript.excludes(superscript)).toBe(true);
    expect(superscript.excludes(subscript)).toBe(true);
    expect(subscript.excludes(bold)).toBe(false);
    expect(subscript.excludes(link)).toBe(false);
    expect(subscript.excludes(textStyle)).toBe(false);
  });

  it("serialises to <sub> / <sup> (the tags every renderer and paste source uses)", () => {
    const sub = schema.marks.subscript.create();
    const sup = schema.marks.superscript.create();
    expect(schema.marks.subscript.spec.toDOM?.(sub, false)).toEqual(["sub", {}, 0]);
    expect(schema.marks.superscript.spec.toDOM?.(sup, false)).toEqual(["sup", {}, 0]);
    expect(schema.markFromJSON({ type: "subscript" }).type).toBe(schema.marks.subscript);
  });

  it("keeps ClearFormatting reachable as a plain extension (command + shortcut live on it)", () => {
    expect(ClearFormatting.name).toBe("clearFormatting");
    expect(InputRules.name).toBe("inputRules");
  });
});
