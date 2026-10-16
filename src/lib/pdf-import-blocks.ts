/**
 * PDF text-layer import — input + output adapters for the pure engine in
 * `pdf-import.ts`.
 *
 * The engine (`parsePdfPages` / `pagesToBlocks` / `assembleDoc` / `describeImport`)
 * recovers structure from text an upstream extractor already pulled out of a
 * PDF. Two gaps sit either side of it and are filled here, with no I/O and no
 * third-party dependency:
 *
 *   - {@link extractedTextToPages} turns a single extracted-text string into the
 *     `PdfPageInput[]` the engine consumes. Page breaks in extracted text are
 *     normally form feeds (`\f`), so those split pages; a text layer without
 *     form feeds is treated as one page.
 *   - {@link pdfBlocksToRichNodes} maps the engine's editable `PdfBlock`s onto
 *     the TipTap / ProseMirror `RichNode[]` every page stores, reusing the same
 *     block vocabulary as the HTML / Confluence importers.
 *
 * Together they make the mapping `extracted text → engine → editor blocks`
 * explicit and unit-testable, so the server action and the sidebar preview
 * share one definition of "what a PDF becomes".
 */

import type { RichNode } from "@/lib/blocks";
import type { PdfBlock, PdfPageInput } from "@/lib/pdf-import";

/** An inline text node, or `undefined` when the text is empty. */
function textNode(text: string): RichNode | null {
  return text === "" ? null : { type: "text", text };
}

/** A paragraph node carrying `text` (empty text yields an empty paragraph). */
function paragraph(text: string): RichNode {
  const node = textNode(text);
  return node ? { type: "paragraph", content: [node] } : { type: "paragraph" };
}

/**
 * Split one extracted-text-layer string into engine pages.
 *
 * Page breaks are form feeds (`\f`) — the convention every PDF text extractor
 * uses. Text without a form feed is a single page. A trailing form feed (which
 * would otherwise add a phantom empty page) is dropped; interior blank pages
 * are kept so the engine can report them as `EMPTY_PAGE` warnings.
 * Empty/whitespace-only input yields `[]`.
 */
export function extractedTextToPages(text: string): PdfPageInput[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const raw = normalized.split("\f");
  const parts =
    raw.length > 1 && raw[raw.length - 1].trim() === "" ? raw.slice(0, -1) : raw;
  return parts.map((pageText, index) => ({ pageNumber: index + 1, text: pageText }));
}

/** Map one engine table block to a TipTap `table` node (first row is a header). */
function tableToRichNode(rows: readonly string[][]): RichNode {
  return {
    type: "table",
    content: rows.map((row, rowIndex) => ({
      type: "tableRow",
      content: row.map((cell) => ({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        content: [paragraph(cell)],
      })),
    })),
  };
}

/**
 * Convert engine blocks into editor blocks. Consecutive `listItem`s of the
 * same kind are grouped into a single `bulletList` / `orderedList`, since the
 * engine emits list items individually. Every other block maps one-to-one:
 *
 *   - `heading`   → `heading` (`attrs.level`)
 *   - `paragraph` → `paragraph`
 *   - `listItem`  → `listItem` inside a `bulletList` / `orderedList`
 *   - `code`      → `codeBlock`
 *   - `table`     → `table` / `tableRow` / `tableHeader` / `tableCell`
 */
export function pdfBlocksToRichNodes(blocks: readonly PdfBlock[]): RichNode[] {
  const out: RichNode[] = [];
  let list: { ordered: boolean; items: RichNode[] } | null = null;

  const flushList = (): void => {
    if (!list) return;
    out.push({
      type: list.ordered ? "orderedList" : "bulletList",
      content: list.items,
    });
    list = null;
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        flushList();
        out.push({
          type: "heading",
          attrs: { level: block.level },
          content: block.text === "" ? [] : [textNode(block.text) as RichNode],
        });
        break;
      case "paragraph":
        flushList();
        out.push(paragraph(block.text));
        break;
      case "listItem":
        if (!list || list.ordered !== block.ordered) {
          flushList();
          list = { ordered: block.ordered, items: [] };
        }
        list.items.push({ type: "listItem", content: [paragraph(block.text)] });
        break;
      case "code":
        flushList();
        out.push({
          type: "codeBlock",
          content: block.text === "" ? [] : [textNode(block.text) as RichNode],
        });
        break;
      case "table":
        flushList();
        if (block.rows.length > 0) out.push(tableToRichNode(block.rows));
        break;
    }
  }

  flushList();
  return out;
}
