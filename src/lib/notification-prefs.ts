/**
 * Per-user notification delivery preferences + the pure delivery decision
 * (docs/MISSING_FEATURES.md §7 "Notification preferences" and the
 * delivery-decision half of "Notification inbox").
 *
 * PURE module: no prisma, no node:* imports, no clock - the settings UI, the
 * inbox route and a future digest scheduler all share the same decision
 * function. Event ids are the dotted `Notification.type` strings the app
 * already writes (`src/server/actions/comments.ts` -> `comment.reply`,
 * `page.mention`), renders (`src/app/w/[slug]/inbox/page.tsx` ->
 * `page.shared`) and dispatches to an assignee (`src/server/actions/tickets.ts`
 * -> `ticket.assigned`), extended with the dotted `page.updated` /
 * `member.invited` vocabulary of `src/lib/activity.ts` and
 * `src/lib/webhook-events.ts` - no second, conflicting enum.
 *
 * Everything fails closed, mirroring `src/lib/feed-guard.ts`: unknown or
 * corrupt preferences normalize to the defaults, unknown event types are
 * suppressed (never delivered), and cadence `OFF` is a kill switch that beats
 * every level - so a bad settings row can only narrow delivery, never widen it.
 *
 * Unit-pinned red-first by `src/lib/notification-prefs.test.ts`.
 */

/**
 * Every event type a user can be notified about. Derived from one catalog
 * (the `WEBHOOK_EVENT_CATALOG` pattern) so the runtime guard and the type
 * cannot drift apart.
 */
export const NOTIFICATION_EVENT_TYPES = [
  "page.mention", //    MENTION  - @you in a comment or on a page
  "comment.reply", //   COMMENT  - someone replied to your comment
  "page.shared", //     SHARE    - a page was shared with you
  "ticket.assigned", // ASSIGN   - you were made the assignee of a ticket
  "page.updated", //    PAGE_EDIT - a page's content was edited
  "member.invited", //  INVITE   - you were invited to the workspace
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Per-event-type level: `ALL` alerts on every event of the type, `MENTIONS`
 * only when the event mentions the current user, `NONE` never.
 */
export type DeliveryLevel = "ALL" | "MENTIONS" | "NONE";

/** How accepted events go out: now, batched, or not at all. */
export type DigestCadence = "INSTANT" | "DAILY" | "WEEKLY" | "OFF";

/** The persisted (JSON) preference shape. Read through `normalizePrefs`. */
export type NotificationPrefs = {
  readonly events: Readonly<Record<NotificationEventType, DeliveryLevel>>;
  readonly digest: DigestCadence;
};

/**
 * Sane defaults: types directed at one person (a mention, a reply, a share, an
 * assignment, an invitation) alert on every event, while `page.updated` is a
 * broadcast - any edit by anyone - and only alerts when it mentions you, so a
 * busy workspace cannot flood a fresh install. `INSTANT` delivers as it happens.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  events: {
    "page.mention": "ALL",
    "comment.reply": "ALL",
    "page.shared": "ALL",
    "ticket.assigned": "ALL",
    "page.updated": "MENTIONS",
    "member.invited": "ALL",
  },
  digest: "INSTANT",
};

/** One event up for delivery; the only fields the decision needs. */
export type NotificationEvent = {
  readonly type: NotificationEventType;
  /** True when the event directly mentions/addresses the recipient. */
  readonly mentionsCurrentUser: boolean;
};

/**
 * What happens to one event: alert right now, defer it into the next digest,
 * or drop it entirely.
 */
export type DeliveryDecision = "ALERT" | "DIGEST" | "SUPPRESSED";

const DELIVERY_LEVELS: readonly DeliveryLevel[] = ["ALL", "MENTIONS", "NONE"];
const DIGEST_CADENCES: readonly DigestCadence[] = [
  "INSTANT",
  "DAILY",
  "WEEKLY",
  "OFF",
];
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(NOTIFICATION_EVENT_TYPES);

function isDeliveryLevel(value: unknown): value is DeliveryLevel {
  return DELIVERY_LEVELS.includes(value as DeliveryLevel);
}

function isDigestCadence(value: unknown): value is DigestCadence {
  return DIGEST_CADENCES.includes(value as DigestCadence);
}

function isNotificationEventType(value: unknown): value is NotificationEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/** Non-null, non-array object - the only input shape trusted as a record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill a (possibly corrupt, possibly partial) preferences value into a complete
 * `NotificationPrefs`. Every unrecognized field falls back to its default, so
 * callers can hand raw JSON straight off a row or a form without widening
 * delivery by accident.
 */
export function normalizePrefs(input: unknown): NotificationPrefs {
  const record = isPlainRecord(input) ? input : {};
  const rawEvents = isPlainRecord(record.events) ? record.events : {};
  // Filled for every key of the union below, then only ever read as such.
  const events = {} as Record<NotificationEventType, DeliveryLevel>;
  for (const type of NOTIFICATION_EVENT_TYPES) {
    const value = rawEvents[type];
    events[type] = isDeliveryLevel(value)
      ? value
      : DEFAULT_NOTIFICATION_PREFS.events[type];
  }
  return {
    events,
    digest: isDigestCadence(record.digest)
      ? record.digest
      : DEFAULT_NOTIFICATION_PREFS.digest,
  };
}

/** Decision core over already-normalized settings (fail closed on bad types). */
function decide(
  settings: NotificationPrefs,
  event: NotificationEvent,
): DeliveryDecision {
  if (settings.digest === "OFF") return "SUPPRESSED"; // kill switch beats levels
  if (!isNotificationEventType(event.type)) return "SUPPRESSED"; // unknown -> no
  const level = settings.events[event.type];
  if (level === "NONE") return "SUPPRESSED";
  if (level === "MENTIONS" && !event.mentionsCurrentUser) return "SUPPRESSED";
  return settings.digest === "INSTANT" ? "ALERT" : "DIGEST";
}

/**
 * Deliver-now vs defer-into-digest vs suppress, for one event.
 *
 * Order: cadence `OFF` suppresses everything; an unrecognised event type is
 * suppressed (fail closed); the per-type level filters; then the cadence routes
 * the survivors - `INSTANT` alerts, `DAILY`/`WEEKLY` defer to that digest.
 * `prefs` is normalized first, so partial/corrupt input behaves like defaults.
 */
export function shouldNotify(
  prefs: unknown,
  event: NotificationEvent,
): DeliveryDecision {
  return decide(normalizePrefs(prefs), event);
}

/** Digest batches keyed by the cadence that will send them. */
export type DigestBuckets<T extends NotificationEvent = NotificationEvent> =
  Partial<Record<DigestCadence, T[]>>;

/**
 * Bucket the events that `shouldNotify` defers (`DIGEST`) under the cadence
 * that will carry them - the digest summary a scheduler sends. Instant alerts
 * and suppressed events never reach a digest, so `INSTANT`/`OFF` and empty
 * batches all answer `{}`. Input order is preserved inside a bucket; richer
 * event records (ids, timestamps) pass through untouched.
 */
export function groupIntoDigest<T extends NotificationEvent>(
  events: readonly T[],
  prefs: unknown,
): DigestBuckets<T> {
  const settings = normalizePrefs(prefs);
  const cadence = settings.digest;
  // `decide` can only answer DIGEST for DAILY/WEEKLY, but check up front.
  if (cadence !== "DAILY" && cadence !== "WEEKLY") return {};
  const bucket: T[] = [];
  for (const event of events) {
    if (decide(settings, event) === "DIGEST") bucket.push(event);
  }
  const buckets: DigestBuckets<T> = {};
  if (bucket.length > 0) buckets[cadence] = bucket;
  return buckets;
}
