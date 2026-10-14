/**
 * Description normaliser shared by the ticket and project description flows.
 *
 * Descriptions are plain multi-line text in the UI and a tiny ProseMirror doc
 * (`Ticket.description Json?`) in the database — this module owns both
 * directions so the server cap and the client autosave agree on the rules.
 */

/** Longest description we store (matches the server-side action cap). */
export const DESCRIPTION_MAX = 10_000;

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
