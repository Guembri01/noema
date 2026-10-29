/**
 * Description normaliser shared by the ticket and project description flows.
 *
 * Descriptions are plain multi-line text in the UI and a tiny ProseMirror doc
 * (`Ticket.description Json?`) in the database — this module owns both
 * directions so the server cap and the client autosave agree on the rules.
 */

/** Longest description we store (matches the server-side action cap). */
export const DESCRIPTION_MAX = 10_000;

/**
 * Longest description *document* the rich editor may save, measured on the
 * serialised JSON. Rich text is bulkier than the plain text it replaced (marks
 * and block wrappers), so it gets its own, larger ceiling instead of reusing
 * `DESCRIPTION_MAX` — which stays the cap for the plain-text fallback.
 */
export const DESCRIPTION_DOC_MAX = 40_000;

/** C0/C1 control characters (tab and newline are kept: they are allowed below). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Trim, normalise line endings, strip control characters, enforce the cap. */
export function sanitizeDescription(input: string, max: number = DESCRIPTION_MAX): string {
  const normalized = input.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

type DocNode = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
};

function inlineText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as DocNode;
  if (n.type === "hardBreak") return "\n";
  let text = typeof n.text === "string" ? n.text : "";
  if (Array.isArray(n.content)) {
    for (const child of n.content) text += inlineText(child);
  }
  return text;
}

/** Stored description doc (`Ticket.description`) -> plain multi-line text. */
export function descriptionToText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const content = (doc as DocNode).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => inlineText(block))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Plain text -> the stored `{ type: "doc" }` shape (one paragraph per line). */
export function descriptionDoc(text: string): { type: "doc"; content: unknown[] } {
  const clean = sanitizeDescription(text);
  if (!clean) return { type: "doc", content: [] };
  return {
    type: "doc",
    content: clean.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

/**
 * The document a rich description editor should open with: the stored doc when
 * there is one, else the plain-text fallback mapped through `descriptionDoc`.
 *
 * Both shapes are valid ProseMirror docs, so the editor needs no migration step:
 * a description written (or seeded) before the rich editor existed keeps its
 * text, and the first save upgrades it in place. An absent/empty description
 * yields one empty paragraph — ProseMirror renders a `content: []` doc as a
 * zero-height surface, so the placeholder and the caret had nowhere to land.
 */
export function descriptionEntryDoc(doc: unknown, text = ""): { type: "doc"; content: unknown[] } {
  if (doc && typeof doc === "object" && Array.isArray((doc as DocNode).content)) {
    const stored = doc as { type: "doc"; content: unknown[] };
    if (stored.content.length > 0) return stored;
  }
  const entry = descriptionDoc(text);
  if (entry.content.length > 0) return entry;
  return { type: "doc", content: [{ type: "paragraph" }] };
}
