/**
 * Block document helpers.
 *
 * A page's blocks are stored as a ProseMirror/TipTap `doc` JSON value. These
 * helpers keep the representation centralized so the editor, exporters,
 * search indexing and the seed script all agree on the shape.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { safeHref } from "./markdown";
import { diagramSearchText, diagramToMermaid } from "./diagrams/uml";

export type Mark = { type: string; attrs?: Record<string, unknown> };

export type RichNode = {
  type?: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: RichNode[];
};

export type BlockDoc = {
  type: "doc";
  content: RichNode[];
};

export const EMPTY_DOC: BlockDoc = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** A fresh, mutable empty document. */
export function emptyDoc(): BlockDoc {
  return JSON.parse(JSON.stringify(EMPTY_DOC)) as BlockDoc;
}

/** Convert a plain string into a single-paragraph document. */
export function docFromText(text: string): BlockDoc {
  if (!text) return emptyDoc();
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** Flatten any stored document into searchable plain text. */
export function prosemirrorToText(doc: unknown): string {
  const out: string[] = [];
  const walk = (node: RichNode) => {
    if (node.text) out.push(node.text);
    if (node.type === "umlDiagram") out.push(diagramSearchText(node.attrs?.data));
    // Action atoms have no child text, so their visible label is what a search
    // index and a screen-reader summary can use.
    if (node.type === "templateButton" || node.type === "button") {
      const label = node.attrs?.label;
      if (typeof label === "string" && label !== "") out.push(label);
    }
    node.content?.forEach(walk);
    if (node.type === "paragraph" || /^heading/.test(node.type ?? "")) {
      out.push("\n");
    }
  };
  const root = doc as RichNode | null;
  if (root && Array.isArray(root.content)) root.content.forEach(walk);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function wordCount(doc: unknown): number {
  const text = prosemirrorToText(doc);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function charCount(doc: unknown): number {
  return prosemirrorToText(doc).length;
}

/** One-line action summary for Markdown export of a Button block. */
function buttonActionSummary(attrs: Record<string, unknown> | undefined): string {
  const action = attrs?.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return "no action";
  const kind = (action as { kind?: unknown }).kind;
  switch (kind) {
    case "open_url": {
      const url = (action as { url?: unknown }).url;
      return `open ${typeof url === "string" ? url : "link"}`;
    }
    case "insert_template": {
      const templateId = (action as { templateId?: unknown }).templateId;
      return `insert template ${typeof templateId === "string" ? templateId : ""}`.trim();
    }
    case "set_property": {
      const propertyId = (action as { propertyId?: unknown }).propertyId;
      return `set property ${typeof propertyId === "string" ? propertyId : ""}`.trim();
    }
    case "notify": {
      const message = (action as { message?: unknown }).message;
      return `notify ${typeof message === "string" ? message : ""}`.trim();
    }
    default:
      return "no action";
  }
}

/**
 * Convert a document to Markdown. Covers the block set used by the editor and
 * is used by the exporter. Inline marks are intentionally minimal.
 */
export function docToMarkdown(doc: unknown): string {
  const lines: string[] = [];
  const inline = (nodes: RichNode[] = []): string =>
    nodes
      .map((n) => {
        if (n.type === "hardBreak") return "  \n";
        if (n.type === "mention") return `@${String(n.attrs?.label ?? "")}`;
        if (n.type === "inlineMath") return `$${String(n.attrs?.latex ?? "")}$`;
        const text = n.text ?? inline(n.content);
        const marks = n.marks?.map((m) => m.type) ?? [];
        let value = text;
        if (marks.includes("code")) value = `\`${value}\``;
        if (marks.includes("bold")) value = `**${value}**`;
        if (marks.includes("italic")) value = `*${value}*`;
        if (marks.includes("strike")) value = `~~${value}~~`;
        const link = n.marks?.find((m) => m.type === "link");
        // B109: the output side applies the same allowlist the input side
        // applies (`safeHref`) — a target the allowlist refuses is written as
        // plain text, never as a link.
        const href = typeof link?.attrs?.href === "string" ? safeHref(link.attrs.href) : null;
        if (href) value = `[${value}](${href})`;
        return value;
      })
      .join("");

  const walk = (node: RichNode, depth = 0) => {
    const type = node.type ?? "";
    if (type === "heading") {
      const level = Number(node.attrs?.level ?? 1);
      lines.push(`${"#".repeat(Math.min(Math.max(level, 1), 6))} ${inline(node.content)}`);
    } else if (type === "paragraph") {
      lines.push(inline(node.content));
    } else if (type === "bulletList" || type === "orderedList" || type === "taskList") {
      node.content?.forEach((li, i) => {
        const checked = li.attrs?.checked ? "x" : " ";
        const prefix =
          type === "orderedList"
            ? `${i + 1}. `
            : type === "taskList"
              ? `- [${checked}] `
              : "- ";
        const text = inline(li.content?.flatMap((c) => c.content ?? []) ?? []);
        lines.push(`${"  ".repeat(depth)}${prefix}${text}`);
      });
    } else if (type === "blockquote") {
      lines.push(`> ${inline(node.content)}`);
    } else if (type === "codeBlock") {
      const lang = String(node.attrs?.language ?? "");
      lines.push(`\`\`\`${lang}\n${inline(node.content)}\n\`\`\``);
    } else if (type === "horizontalRule") {
      lines.push("---");
    } else if (type === "callout") {
      lines.push(`> ${String(node.attrs?.emoji ?? "💡")} ${inline(node.content ?? [])}`);
    } else if (type === "toggle") {
      lines.push(`- ${String(node.attrs?.summary ?? "")}`);
      node.content?.forEach((c) => walk(c, depth + 1));
    } else if (type === "image") {
      lines.push(`![${String(node.attrs?.alt ?? "")}](${String(node.attrs?.src ?? "")})`);
    } else if (type === "bookmark" || type === "embed") {
      const title = String(node.attrs?.title ?? "");
      const href = safeHref(String(node.attrs?.url ?? ""));
      if (href) lines.push(`[${title || href}](${href})`);
      else if (title) lines.push(title);
    } else if (type === "pageEmbed") {
      lines.push(`/w/…/${String(node.attrs?.pageId ?? "")} — ${String(node.attrs?.title ?? "")}`);
    } else if (type === "umlDiagram") {
      lines.push(`\`\`\`mermaid\n${diagramToMermaid(node.attrs?.data)}\n\`\`\``);
    } else if (type === "blockMath") {
      lines.push(`$$\n${String(node.attrs?.latex ?? "")}\n$$`);
    } else if (type === "templateButton") {
      // Atoms have no children; the label + selected template is the meaningful
      // content an exported document can carry.
      const label = String(node.attrs?.label ?? "").trim() || "Template";
      const templateId = String(node.attrs?.templateId ?? "").trim();
      lines.push(templateId ? `[${label}] (template: ${templateId})` : `[${label}]`);
    } else if (type === "button") {
      const label = String(node.attrs?.label ?? "").trim() || "Button";
      lines.push(`[${label}] (${buttonActionSummary(node.attrs)})`);
    } else if (type === "table") {
      const rows = node.content ?? [];
      rows.forEach((row, index) => {
        const cells = (row.content ?? []).map((cell) =>
          inline(cell.content?.flatMap((c) => c.content ?? []) ?? []),
        );
        lines.push(`| ${cells.join(" | ")} |`);
        if (index === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
    } else if (type === "columns" || type === "column") {
      node.content?.forEach((c) => walk(c, depth));
    } else if (node.content) {
      node.content.forEach((c) => walk(c, depth));
    }
  };

  const root = doc as RichNode | null;
  root?.content?.forEach((n) => walk(n));
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------------------------------------------------------------------------
   Block deletion snapshot / restore (undo affordance for block delete)
   --------------------------------------------------------------------------- */

/**
 * Everything needed to put a deleted block back: where it lived (child
 * indices from the doc root, inclusive) and its JSON.
 */
export type BlockDeletion = {
  path: number[];
  node: RichNode;
};

/** Inline-only child types: a node holding only these is a textblock, not a container. */
const INLINE_CONTENT_TYPES = new Set(["text", "hardBreak", "mention", "inlineMath"]);

/**
 * Locate the block that starts at `pos` and capture what a restore needs.
 * Returns `null` when no block starts there (text runs, out-of-range
 * positions), so callers can skip the undo affordance instead of restoring
 * nonsense.
 */
export function snapshotBlockDeletion(doc: PMNode, pos: number): BlockDeletion | null {
  if (pos < 0) return null;
  const path: number[] = [];
  let node = doc;
  let contentStart = 0; // absolute position where `node`'s content begins
  for (;;) {
    let offset = contentStart;
    let descended = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const start = offset;
      const end = start + child.nodeSize;
      if (pos >= start && pos < end) {
        if (pos === start) {
          if (child.isText) return null; // inline runs are not restorable blocks
          path.push(i);
          return { path, node: child.toJSON() as RichNode };
        }
        // The block starts deeper inside this child: descend past its open token.
        path.push(i);
        node = child;
        contentStart = start + 1;
        descended = true;
        break;
      }
      offset = end;
    }
    if (!descended) return null; // past the end, or inside a leaf
  }
}

/**
 * Re-insert a captured block into a stored document at its original path,
 * clamping every index so a doc that changed while the toast was open still
 * yields a valid structure (never a paragraph inside a paragraph).
 * Returns a NEW document; the inputs are left untouched.
 */
export function restoreBlockDeletion(doc: BlockDoc, deletion: BlockDeletion): BlockDoc {
  const restored = JSON.parse(JSON.stringify(doc)) as BlockDoc;
  if (deletion.path.length === 0) return restored;
  let container: RichNode = restored;
  let depth = 0;
  // Descend to the block's parent, clamping stale indices; stop early when a
  // level no longer holds block content (textblock, leaf, emptied container).
  while (depth < deletion.path.length - 1) {
    const kids = container.content;
    if (!kids || kids.length === 0) break;
    const i = Math.min(Math.max(deletion.path[depth], 0), kids.length - 1);
    const next = kids[i];
    if (!next?.content || !next.content.some((c) => !INLINE_CONTENT_TYPES.has(c.type ?? ""))) {
      break;
    }
    container = next;
    depth += 1;
  }
  const kids = container.content ?? (container.content = []);
  const rawIndex = deletion.path[Math.min(depth, deletion.path.length - 1)];
  const at = Math.min(Math.max(rawIndex ?? 0, 0), kids.length);
  kids.splice(at, 0, JSON.parse(JSON.stringify(deletion.node)) as RichNode);
  return restored;
}

/**
 * Whether the editor can undo through its history extension. Collaborative
 * sessions disable the local history (only the collaboration extension is
 * registered for undo), so the undo affordance must fall back to a snapshot
 * restore instead of blindly calling `undo()`.
 */
export function canUndoViaHistory(extensionNames: readonly string[]): boolean {
  if (extensionNames.includes("collaboration")) return false;
  return extensionNames.includes("undoRedo") || extensionNames.includes("history");
}
