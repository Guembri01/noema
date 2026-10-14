/**
 * Notion API → Noema document mapping (pure, no network).
 *
 * The `/v1/blocks/{id}/children` response is walked and converted into the
 * same ProseMirror/TipTap `doc` JSON the editor and importers use. Child
 * pages/databases are handled by the caller (they become nested pages).
 */

import type { BlockDoc, RichNode } from "./blocks";

export type NotionRichText = {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
};

export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

/** Blocks handled elsewhere (each becomes a nested page). */
export const NOTION_PAGE_BLOCKS = ["child_page", "child_database"];

function toStrings(value: unknown): NotionRichText[] {
  return Array.isArray(value) ? (value as NotionRichText[]) : [];
}

/** Convert Notion rich text into inline rich nodes (marks + links). */
export function notionRichTextToNodes(rich: unknown): RichNode[] {
  const nodes: RichNode[] = [];
  for (const item of toStrings(rich)) {
    const text = item.plain_text ?? "";
    if (!text) continue;
    const marks: RichNode["marks"] = [];
    const annotations = item.annotations ?? {};
    if (annotations.bold) marks.push({ type: "bold" });
    if (annotations.italic) marks.push({ type: "italic" });
    if (annotations.strikethrough) marks.push({ type: "strike" });
    if (annotations.underline) marks.push({ type: "underline" });
    if (annotations.code) marks.push({ type: "code" });
    if (item.href) marks.push({ type: "link", attrs: { href: item.href } });
    nodes.push({
      type: "text",
      text,
      ...(marks.length > 0 ? { marks } : {}),
    });
  }
  return nodes;
}

const paragraph = (rich: unknown): RichNode => ({
  type: "paragraph",
  content: notionRichTextToNodes(rich),
});

const listItem = (rich: unknown): RichNode => ({
  type: "listItem",
  content: [paragraph(rich)],
});

/** Convert a Notion block list into a document. */
export function notionBlocksToDoc(blocks: NotionBlock[]): BlockDoc {
  const content: RichNode[] = [];
  let i = 0;

  const flushList = (kind: "bulletList" | "orderedList" | "taskList") => {
    const items: RichNode[] = [];
    const isTask = kind === "taskList";
    const isOrdered = kind === "orderedList";
    while (i < blocks.length) {
      const type = blocks[i].type;
      const matches = isTask
        ? type === "to_do"
        : isOrdered
          ? type === "numbered_list_item"
          : type === "bulleted_list_item";
      if (!matches) break;
      const data = blocks[i][type] as { rich_text?: unknown; checked?: boolean } | undefined;
      if (isTask) {
        items.push({
          type: "taskItem",
          attrs: { checked: Boolean(data?.checked) },
          content: [paragraph(data?.rich_text)],
        });
      } else {
        items.push(listItem(data?.rich_text));
      }
      i += 1;
    }
    if (items.length > 0) content.push({ type: kind, content: items });
  };

  while (i < blocks.length) {
    const block = blocks[i];
    const type = block.type;
    const data = block[type] as Record<string, unknown> | undefined;

    switch (type) {
      case "paragraph": {
        const nodes = notionRichTextToNodes(data?.rich_text);
        content.push(nodes.length > 0 ? { type: "paragraph", content: nodes } : { type: "paragraph" });
        i += 1;
        break;
      }
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        content.push({
          type: "heading",
          attrs: { level: Number(type.slice(-1)) },
          content: notionRichTextToNodes(data?.rich_text),
        });
        i += 1;
        break;
      }
      case "bulleted_list_item":
        flushList("bulletList");
        break;
      case "numbered_list_item":
        flushList("orderedList");
        break;
      case "to_do":
        flushList("taskList");
        break;
      case "quote": {
        content.push({
          type: "blockquote",
          content: [paragraph(data?.rich_text)],
        });
        i += 1;
        break;
      }
      case "callout": {
        const icon = data?.icon as { emoji?: string } | undefined;
        content.push({
          type: "callout",
          attrs: { emoji: icon?.emoji ?? "💡", color: "gray" },
          content: [paragraph(data?.rich_text)],
        });
        i += 1;
        break;
      }
      case "toggle": {
        content.push({
          type: "toggle",
          attrs: { open: true },
          content: [paragraph(data?.rich_text)],
        });
        i += 1;
        break;
      }
      case "code": {
        const code = notionRichTextToNodes(data?.rich_text)
          .map((node) => node.text ?? "")
          .join("");
        content.push({
          type: "codeBlock",
          attrs: { language: (data?.language as string) ?? null },
          content: code ? [{ type: "text", text: code }] : [],
        });
        i += 1;
        break;
      }
      case "divider":
        content.push({ type: "horizontalRule" });
        i += 1;
        break;
      case "image":
      case "video":
      case "file":
      case "pdf": {
        const file = (data?.external as { url?: string } | undefined)?.url ??
          (data?.file as { url?: string } | undefined)?.url;
        const caption = notionRichTextToNodes(data?.caption)
          .map((node) => node.text ?? "")
          .join("");
        if (file && type === "image") {
          content.push({ type: "image", attrs: { src: file, alt: caption } });
        } else if (file) {
          content.push({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: caption || file,
                marks: [{ type: "link", attrs: { href: file } }],
              },
            ],
          });
        }
        i += 1;
        break;
      }
      case "bookmark":
      case "link_preview": {
        const url = (data?.url as string) ?? "";
        content.push({ type: "bookmark", attrs: { url } });
        i += 1;
        break;
      }
      case "table": {
        // Rows arrive as child blocks; represent them as nested lists.
        content.push({ type: "paragraph", content: [{ type: "text", text: "Table" }] });
        i += 1;
        break;
      }
      default:
        // Unsupported blocks (and child pages/databases) are skipped here.
        i += 1;
        break;
    }
  }

  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/** Extract a page title from a Notion page `properties` object. */
export function notionPageTitle(properties: unknown): string {
  if (!properties || typeof properties !== "object") return "Untitled";
  for (const value of Object.values(properties as Record<string, unknown>)) {
    const property = value as { type?: string; title?: NotionRichText[] };
    if (property?.type === "title" && Array.isArray(property.title)) {
      const title = property.title.map((item) => item.plain_text ?? "").join("").trim();
      if (title) return title;
    }
  }
  return "Untitled";
}
