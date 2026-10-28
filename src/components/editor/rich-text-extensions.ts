/**
 * The compact rich-text extension set, for editors that live *outside* the page
 * canvas — the ticket description is the first one.
 *
 * `page-editor.tsx` registers the whole set: collaboration, drag handles,
 * page embeds, linked databases, math, suggestions. A description needs the
 * *writing* surface, not the workspace around it, so this module names the
 * subset a self-contained text field can support and registers nothing that
 * reaches for a page id, a socket or a database:
 *
 *   blocks   paragraph, heading 1-3, bulleted/ordered/to-do lists, quote,
 *            code block (the lowlight one), horizontal rule, table, image or
 *            uploaded file card
 *   marks    bold, italic, underline, strike, inline code, link, text colour,
 *            highlight
 *   typing   markdown input rules (`#`, `-`, `1.`, `1)`, `[] `, `>`, ``` ```,
 *            `---`, `| a | b |` tables, `:smile:`, `H~2~O`, `x^2^`), smart
 *            typography, autolink, undo/redo and a placeholder
 *
 * Reusing the page editor's own extensions means a description is stored as the
 * same ProseMirror doc a page body is (`Page.content` / `Ticket.description`
 * both go through `parsePageContent`), so nothing has to be converted if a
 * description is ever promoted into a page — or rendered by `DocRenderer`.
 */
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table/kit";
import { CodeBlock } from "@/components/editor/extensions/code-block";
import { ImageBlock } from "@/components/editor/extensions/image-block";
import { InputRules } from "@/components/editor/extensions/input-rules";

export type RichTextOptions = {
  /** UI locale for the extensions that render chrome of their own. */
  locale: string;
  /** Hint shown in the first empty block. */
  placeholder: string;
  /**
   * Disable the local undo history when a Yjs collaboration extension owns the
   * document. Two history providers on one transaction stack corrupt undo and
   * make remote updates locally undoable.
   */
  collaboration?: boolean;
};

export function richTextExtensions({
  locale,
  placeholder,
  collaboration = false,
}: RichTextOptions): Extensions {
  return [
    StarterKit.configure({
      // Three heading levels: enough structure for a description, no room for a
      // second title inside a panel that already has one.
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true },
      // The lowlight-backed code block below replaces the stock one, so the
      // syntax-highlighted node is the only `codeBlock` in the schema.
      codeBlock: false,
      ...(collaboration ? { undoRedo: false } : {}),
    }),
    CodeBlock.configure({ locale }),
    // A ticket can carry a PDF or spreadsheet as a file card. The page editor's
    // block is the same node, so the stored description renders identically in
    // `DocRenderer` and can be promoted to a page without conversion.
    ImageBlock.configure({ locale }),
    Placeholder.configure({ placeholder }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextStyle,
    // Text colour rides on `textStyle` exactly as it does on a page, storing the
    // same token values (`var(--tag-blue-fg)`) so the palette is one palette.
    Color,
    Highlight,
    // Alignment survives a paste and stays editable; the description toolbar
    // does not surface it (a side panel is too narrow to justify it).
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // Resizing is off: the column handles are page-canvas chrome and would
    // float outside a drawer's stacking context.
    TableKit.configure({ table: { resizable: false } }),
    InputRules,
  ];
}
