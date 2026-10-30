/**
 * Comment body parsing.
 *
 * A comment body is a small inline document: plain text, `@[Label](userId)`
 * mention tokens, bare URLs (including app-asset `/api/files/...` links) and
 * `:shortcode:` emoji. `parseCommentBody` turns it into an ordered list of
 * `text` / `mention` / `link` / `emoji` segments so the comment surface can render chips and links without re-parsing on every
 * paint, and `toCommentBody` reconstructs the wire token body (round-trip).
 *
 * Pure and dependency-light: unknown shortcodes, malformed mention tokens,
 * clock times and mid-word colons all degrade to text, and nothing here ever
 * throws — a bad body is just a bad comment, never a crashed panel.
 */

import { emojiForShortcode } from "@/lib/emoji";

export type CommentSegmentType = "text" | "mention" | "link" | "emoji";

/**
 * One segment of a parsed comment.
 *
 * - `text`    — literal characters (`value`).
 * - `mention` — `value` is the display label, `id` the user id.
 * - `link`    — `value` is the URL (also its display text).
 * - `emoji`   — `value` is the glyph, `id` the canonical shortcode.
 */
export type CommentSegment =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; id: string }
  | { type: "link"; value: string }
  | { type: "emoji"; value: string; id: string };

/** Wire token for a mention: `@[Label](userId)`. */
const MENTION_RE = /^@\[([^\]]*)\]\(([^)]*)\)/;
/**
 * Bare URL at the start of a string. Absolute http(s)/www links are external;
 * `/api/files/...` is the app's own uploaded-asset path, which the attach
 * control writes into a comment so a PDF or spreadsheet stays clickable.
 */
const LINK_RE = /^(?:https?:\/\/|www\.|\/api\/files\/)[^\s<>"']+/;
/** `:shortcode:` token candidate — resolved through `emojiForShortcode`. */
const EMOJI_RE = /^:([a-z0-9_+\-]{1,64}):/i;
/** A shortcode only counts at the start of the text or after whitespace/bracket/colon. */
const EMOJI_BOUNDARY = /[\s(\[|:]/;
/** Word characters used to reject mid-word `@` / link triggers. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * What a mention token points at. Older comments store only a user id; those
 * remain people. New tokens prefix the kind, and a milestone carries both its
 * project and milestone ids (`milestone:<projectId>:<milestoneId>`).
 */
export type CommentMentionTarget =
  | { kind: "user"; id: string }
  | { kind: "page"; id: string }
  | { kind: "project"; id: string }
  | { kind: "milestone"; id: string; projectId: string };

/** A safe single path segment (ids are cuids, but never trust stored text). */
function safeSegment(value: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** Parse the id half of a comment mention token. */
export function parseCommentMentionTarget(raw: string): CommentMentionTarget {
  const text = raw.trim();
  const [head, ...rest] = text.split(":");
  if (head === "page" || head === "project") {
    const id = safeSegment(rest.join(":"));
    return id ? { kind: head, id } : { kind: "user", id: text };
  }
  if (head === "milestone") {
    const projectId = rest[0] ? safeSegment(rest[0]) : null;
    const id = rest[1] ? safeSegment(rest[1]) : null;
    if (projectId && id) return { kind: "milestone", id, projectId };
  }
  if (head === "user") {
    const id = safeSegment(rest.join(":"));
    if (id) return { kind: "user", id };
  }
  // Legacy token: the whole value was the user id.
  return { kind: "user", id: text };
}

/**
 * In-app destination for a mention target, or `null` when it has no page
 * (people are chips, not links). Pure so the comment renderer and tests agree.
 */
export function commentMentionHref(raw: string, slug: string): string | null {
  const target = parseCommentMentionTarget(raw);
  const workspace = safeSegment(slug);
  if (!workspace) return null;
  if (target.kind === "page") return `/w/${workspace}/${target.id}`;
  if (target.kind === "project") return `/w/${workspace}/projects/${target.id}`;
  if (target.kind === "milestone") {
    return `/w/${workspace}/projects/${target.projectId}#milestone-${target.id}`;
  }
  return null;
}

/** Build the wire token for a picked suggestion. */
export function commentMentionToken(suggestion: {
  id: string;
  label: string;
  type: "page" | "user" | "project" | "milestone";
  projectId?: string;
}): string {
  const label =
    suggestion.label
      .replace(/[[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled";
  const target =
    suggestion.type === "milestone" && suggestion.projectId
      ? `milestone:${suggestion.projectId}:${suggestion.id}`
      : `${suggestion.type}:${suggestion.id}`;
  return `@[${label}](${target})`;
}

/** Strip trailing sentence punctuation (and an unbalanced `)`) off a URL. */
function trimLinkEnd(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?".includes(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const before = url.slice(0, end);
      const opens = (before.match(/\(/g) ?? []).length;
      const closes = (before.match(/\)/g) ?? []).length;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Split a comment body into ordered segments. Well-formed input round-trips
 * through {@link toCommentBody}; anything unrecognized stays literal text.
 * Non-string input (defensive) parses as the empty body.
 */
export function parseCommentBody(body: string): CommentSegment[] {
  const src = typeof body === "string" ? body : "";
  const segments: CommentSegment[] = [];
  let textStart = -1;
  let i = 0;

  const flushText = (until: number) => {
    if (textStart >= 0 && until > textStart) {
      segments.push({ type: "text", value: src.slice(textStart, until) });
    }
    textStart = -1;
  };

  while (i < src.length) {
    const ch = src[i];
    const atBoundary = i === 0 || !WORD_CHAR.test(src[i - 1]);

    if (ch === "@" && atBoundary) {
      const match = MENTION_RE.exec(src.slice(i));
      const id = match ? match[2].trim() : "";
      if (match && id !== "" && !/\s/.test(match[2])) {
        flushText(i);
        segments.push({ type: "mention", value: match[1], id });
        i += match[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "w" || ch === "/") && atBoundary) {
      const match = LINK_RE.exec(src.slice(i));
      if (match) {
        const url = trimLinkEnd(match[0]);
        if (url.length > 0) {
          flushText(i);
          segments.push({ type: "link", value: url });
          i += url.length;
          continue;
        }
      }
    }

    if (ch === ":" && (i === 0 || EMOJI_BOUNDARY.test(src[i - 1]))) {
      const match = EMOJI_RE.exec(src.slice(i));
      const emoji = match ? emojiForShortcode(match[1]) : null;
      if (match && emoji) {
        flushText(i);
        segments.push({ type: "emoji", value: emoji, id: match[1].toLowerCase() });
        i += match[0].length;
        continue;
      }
    }

    if (textStart < 0) textStart = i;
    i += 1;
  }

  flushText(src.length);
  return segments;
}

/**
 * Readable rendering: mentions become `@Label`, emoji become their glyph,
 * links keep their URL. Defensive against non-array input.
 */
export function toPlainText(segments: CommentSegment[]): string {
  if (!Array.isArray(segments)) return "";
  let out = "";
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.type === "mention") out += `@${segment.value}`;
    else out += segment.value;
  }
  return out;
}

/**
 * Rebuild the wire token body: mentions re-emit `@[Label](userId)` and emoji
 * re-emit `:id:`, so `toCommentBody(parseCommentBody(body)) === body` for a
 * well-formed, canonically-cased body. Defensive against non-array input.
 */
export function toCommentBody(segments: CommentSegment[]): string {
  if (!Array.isArray(segments)) return "";
  let out = "";
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.type === "mention") out += `@[${segment.value}](${segment.id})`;
    else if (segment.type === "emoji") out += `:${segment.id}:`;
    else out += segment.value;
  }
  return out;
}

/**
 * Distinct mentioned user ids in first-seen order. Defensive against
 * non-array input.
 */
export function extractMentions(segments: CommentSegment[]): string[] {
  if (!Array.isArray(segments)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const segment of segments) {
    if (segment?.type === "mention" && segment.id && !seen.has(segment.id)) {
      seen.add(segment.id);
      ids.push(segment.id);
    }
  }
  return ids;
}

/** Does the parsed body mention anyone? Defensive against non-array input. */
export function hasMentions(segments: CommentSegment[]): boolean {
  if (!Array.isArray(segments)) return false;
  return segments.some((segment) => segment?.type === "mention");
}

/**
 * Distinct user ids a raw comment body notifies, in first-seen order.
 *
 * Typed tokens (`user:<id>`, or a legacy bare id) count as people; page,
 * project and milestone tokens are navigable references, not notifications.
 */
export function commentMentionedUserIds(body: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of extractMentions(parseCommentBody(body))) {
    const target = parseCommentMentionTarget(id);
    if (target.kind !== "user" || !target.id || seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  return ids;
}
