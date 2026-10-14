/**
 * Email digest formatting (docs/specs/notifications.md §R82.27 "Email is an
 * opt-in secondary channel" - the formatting half; the delivery decision lives
 * in `notification-prefs.ts` and the inbox sectioning in
 * `notification-inbox.ts`).
 *
 * PURE module: no prisma, no SMTP, no routes, no React and no ambient clock -
 * `buildDigest` is handed the current instant so every recency boundary is
 * deterministic and unit-testable, exactly like `buildInbox`. The day logic is
 * intentionally self-contained (today / yesterday / earlier in UTC) rather than
 * importing the inbox module, so a digest can be rendered without pulling in the
 * preference engine - the two agree by construction, not by a shared import.
 *
 * The wire shape mirrors the `Notification` row the inbox route reads (see
 * `notification-inbox.ts`): an id, the dotted `type`, an ISO `createdAt` and an
 * optional `pageId`/`actorId`. Extra fields (read flags, mentions) pass
 * through untouched, so callers can hand their richer rows straight in.
 *
 * Unit-pinned red-first by `src/lib/email-digest.test.ts`.
 */

import type { DigestCadence } from "./notification-prefs";

/** One digest item; the subset of the wire row this module needs. */
export type DigestNotification = {
  readonly id: string;
  /** Dotted event type, e.g. `page.mention` (see `NOTIFICATION_EVENT_TYPES`). */
  readonly type: string;
  /** ISO-8601 timestamp; compared lexically (Z-suffixed strings sort by time). */
  readonly createdAt: string;
  readonly pageId?: string;
  readonly actorId?: string;
};

/** Calendar bucket used to section a digest, newest first. */
export type DigestBucket = "today" | "yesterday" | "earlier";

/** One recency section; empty buckets are omitted by `buildDigest`. */
export type DigestSection<T extends DigestNotification = DigestNotification> = {
  readonly bucket: DigestBucket;
  /** Human label for the bucket ("Today", "Yesterday", "Earlier"). */
  readonly label: string;
  readonly items: readonly T[];
  readonly count: number;
};

/** A rendered digest: a subject line, a one-line preview and the sections. */
export type Digest<T extends DigestNotification = DigestNotification> = {
  readonly subject: string;
  readonly preview: string;
  /** Total notifications carried by the digest. */
  readonly count: number;
  readonly sections: readonly DigestSection<T>[];
};

/** Inputs to `buildDigest`; every field is optional and deterministic. */
export type DigestOptions = {
  /** The instant buckets are measured against; expected to be pinned. */
  readonly now?: string | number | Date;
  /** The cadence whose subject prefix to use; defaults to instant wording. */
  readonly cadence?: DigestCadence;
  /** Character cap for `preview`; defaults to `DEFAULT_PREVIEW_MAX`. */
  readonly previewMax?: number;
};

const DAY_MS = 86_400_000;
const BUCKET_ORDER: readonly DigestBucket[] = ["today", "yesterday", "earlier"];
const BUCKET_LABELS: Record<DigestBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};
const DEFAULT_PREVIEW_MAX = 140;

/** Cadence → subject prefix; instant/off carry no window name. */
const CADENCE_PREFIX: Partial<Record<DigestCadence, string>> = {
  DAILY: "Daily digest",
  WEEKLY: "Weekly digest",
};

/** Midnight of the given instant's UTC day, as a millisecond stamp. */
function utcDay(value: string | number | Date): number {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Which section an item belongs to relative to `now` (UTC days). */
function bucketOf(
  createdAt: string,
  now: string | number | Date,
): DigestBucket {
  const created = utcDay(createdAt);
  const today = utcDay(now);
  if (created >= today) return "today";
  if (created >= today - DAY_MS) return "yesterday";
  return "earlier";
}

/** createdAt desc, then id desc - total and deterministic. */
function compareRecency(x: DigestNotification, y: DigestNotification): number {
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? 1 : -1;
  if (x.id === y.id) return 0;
  return x.id < y.id ? 1 : -1;
}

/** One plain-text bullet: the dotted type, with the page id when present. */
function itemLine(n: DigestNotification): string {
  return n.pageId ? `- ${n.type} (${n.pageId})` : `- ${n.type}`;
}

/** The sectioned body, without the subject line. */
function bodyFor(sections: readonly DigestSection[]): string {
  return sections
    .map((s) => `${s.label}\n${s.items.map(itemLine).join("\n")}`)
    .join("\n\n");
}

/**
 * Collapse whitespace and trim to a single-line snippet of at most `max`
 * characters, ending in an ellipsis only when something was cut. `max` defaults
 * to 140; a non-positive limit yields `""`.
 */
export function previewText(
  text: string,
  options: { max?: number } = {},
): string {
  const max = options.max ?? DEFAULT_PREVIEW_MAX;
  if (max <= 0) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The digest subject line. A non-positive count announces an empty digest;
 * otherwise the count is pluralized and prefixed with the cadence window name
 * (`Daily digest:` / `Weekly digest:`), which instant and off delivery omit.
 */
export function digestSubject(
  count: number,
  options: { cadence?: DigestCadence } = {},
): string {
  if (!(count > 0)) return "No new notifications";
  const body = `${count} new notification${count === 1 ? "" : "s"}`;
  const prefix = options.cadence ? CADENCE_PREFIX[options.cadence] : undefined;
  return prefix ? `${prefix}: ${body}` : body;
}

/**
 * Section a digest batch into today / yesterday / earlier, newest first within
 * each section, dropping empty sections. The subject is derived from the count
 * and cadence, and the preview is the flattened body (or the subject when there
 * is nothing to report), capped at `previewMax`. `now` defaults to the wall
 * clock but is expected to be pinned by callers/tests; the input is never
 * mutated.
 */
export function buildDigest<T extends DigestNotification>(
  notifications: readonly T[],
  options: DigestOptions = {},
): Digest<T> {
  const now = options.now ?? Date.now();
  const buckets: Record<DigestBucket, T[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const n of notifications) buckets[bucketOf(n.createdAt, now)].push(n);

  const sections: DigestSection<T>[] = [];
  for (const bucket of BUCKET_ORDER) {
    const items = buckets[bucket];
    if (items.length === 0) continue;
    const sorted = [...items].sort(compareRecency);
    sections.push({
      bucket,
      label: BUCKET_LABELS[bucket],
      items: sorted,
      count: sorted.length,
    });
  }

  const count = notifications.length;
  const subject = digestSubject(count, { cadence: options.cadence });
  const body = bodyFor(sections);
  const preview = previewText(body.length > 0 ? body : subject, {
    max: options.previewMax,
  });
  return { subject, preview, count, sections };
}

/**
 * Render a digest as the plain-text email body: the subject line, a blank line,
 * then each section's label and bullets. A digest with no sections is just its
 * subject - callers can hand the result to `sendMail` alongside the HTML part.
 */
export function plainTextDigest(digest: Digest): string {
  const body = bodyFor(digest.sections);
  return body ? `${digest.subject}\n\n${body}` : digest.subject;
}
