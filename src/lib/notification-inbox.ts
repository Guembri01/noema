/**
 * Notification inbox model (docs/MISSING_FEATURES.md §7 "Notification inbox",
 * inbox-list half; the delivery-decision half lives in `notification-prefs.ts`).
 *
 * PURE module: no prisma, no node:* imports, no routes, no React and no ambient
 * clock - `buildInbox` is handed the current instant so every day-bucket
 * boundary is deterministic and unit-testable. It reuses the preference
 * vocabulary exported by `notification-prefs.ts` (`normalizePrefs`,
 * `shouldNotify`, `DEFAULT_NOTIFICATION_PREFS`) so the inbox can only ever show
 * what the delivery engine would let through - one decision function, no second
 * copy of the rules.
 *
 * The wire shape mirrors the `Notification` row the inbox route already reads
 * (`src/lib/../app/w/[slug]/inbox/page.tsx`): an id, the dotted `type`, an ISO
 * `createdAt`, a `read` flag and an optional `pageId`/`actorId` payload. A
 * notification is addressed to one user, so it counts as a "mention" unless it
 * explicitly says otherwise - callers can pass `mentions: false` for a
 * broadcast edit that should respect a MENTIONS-only preference.
 *
 * Unit-pinned red-first by `src/lib/notification-inbox.test.ts`.
 */

import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizePrefs,
  shouldNotify,
} from "./notification-prefs";
import type { NotificationEventType } from "./notification-prefs";

/** One inbox item; the subset of the wire row this module needs. */
export type InboxNotification = {
  readonly id: string;
  /** Dotted event type, e.g. `page.mention` (see `NOTIFICATION_EVENT_TYPES`). */
  readonly type: string;
  /** ISO-8601 timestamp; compared lexically (Z-suffixed strings sort by time). */
  readonly createdAt: string;
  readonly read: boolean;
  readonly pageId?: string;
  readonly actorId?: string;
  /** Defaults to `true`; set `false` for a broadcast that is not a mention. */
  readonly mentions?: boolean;
};

/** Calendar bucket used to section the inbox list. */
export type InboxBucket = "today" | "yesterday" | "earlier";

/** One day-bucket section; empty buckets are omitted by `buildInbox`. */
export type InboxGroup<T extends InboxNotification = InboxNotification> = {
  readonly bucket: InboxBucket;
  readonly items: readonly T[];
  readonly unread: number;
};

/** Collapse target: every event on one page, newest first. */
export type PageGroup<T extends InboxNotification = InboxNotification> = {
  /** The page id, or `null` for a notification with no page (keyed by its id). */
  readonly pageId: string | null;
  /** Stable grouping key: the page id, or `id:<notificationId>` when unpaged. */
  readonly key: string;
  readonly items: readonly T[];
  readonly count: number;
  readonly unread: number;
  /** The most recent event, used as the group's representative and sort key. */
  readonly latest: T;
};

/** Scope for `markAllRead`; an empty scope matches every notification. */
export type MarkAllScope = { pageId?: string } | { type?: string };

const DAY_MS = 86_400_000;
const BUCKET_ORDER: readonly InboxBucket[] = ["today", "yesterday", "earlier"];

/** A notification is a mention unless it explicitly opts out. */
function mentionsCurrentUser(n: InboxNotification): boolean {
  return n.mentions ?? true;
}

/** Route one notification through the shared delivery decision. */
function isSuppressed(n: InboxNotification, prefs: unknown): boolean {
  return (
    shouldNotify(prefs, {
      type: n.type as NotificationEventType,
      mentionsCurrentUser: mentionsCurrentUser(n),
    }) === "SUPPRESSED"
  );
}

/** createdAt desc, then id desc - total and deterministic. */
function compareRecency(x: InboxNotification, y: InboxNotification): number {
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? 1 : -1;
  if (x.id === y.id) return 0;
  return x.id < y.id ? 1 : -1;
}

/** Newest-first copy; the input array and its items are never mutated. */
export function sortRecency<T extends InboxNotification>(
  notifications: readonly T[],
): T[] {
  return [...notifications].sort(compareRecency);
}

/** How many notifications are still unread. */
export function unreadCount(notifications: readonly InboxNotification[]): number {
  let count = 0;
  for (const n of notifications) if (!n.read) count += 1;
  return count;
}

/** Midnight of the given instant's UTC day, as a millisecond stamp. */
function utcDay(value: string | number | Date): number {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Which section a notification belongs to relative to `now` (UTC days). */
function bucketOf(
  createdAt: string,
  now: string | number | Date,
): InboxBucket {
  const created = utcDay(createdAt);
  const today = utcDay(now);
  if (created >= today) return "today";
  if (created >= today - DAY_MS) return "yesterday";
  return "earlier";
}

/**
 * Section the visible notifications into today / yesterday / earlier, newest
 * first within each section, dropping empty sections. Notifications the
 * preference engine would suppress (level `NONE`, a non-mention under
 * `MENTIONS`, unknown type, or cadence `OFF`) are hidden, so the inbox list and
 * the delivery decisions can never disagree. `now` defaults to the wall clock
 * but is expected to be pinned by callers/tests.
 */
export function buildInbox<T extends InboxNotification>(
  notifications: readonly T[],
  prefs: unknown = DEFAULT_NOTIFICATION_PREFS,
  now: string | number | Date = Date.now(),
): InboxGroup<T>[] {
  const settings = normalizePrefs(prefs);
  const buckets: Record<InboxBucket, T[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const n of notifications) {
    if (isSuppressed(n, settings)) continue;
    buckets[bucketOf(n.createdAt, now)].push(n);
  }
  const groups: InboxGroup<T>[] = [];
  for (const bucket of BUCKET_ORDER) {
    const items = buckets[bucket];
    if (items.length === 0) continue;
    const sorted = sortRecency(items);
    groups.push({ bucket, items: sorted, unread: unreadCount(sorted) });
  }
  return groups;
}

/**
 * Mark the given ids read, returning a new array. Only matched, unread
 * notifications are copied; everything else keeps its identity, and the input
 * is never mutated.
 */
export function markRead<T extends InboxNotification>(
  notifications: readonly T[],
  ids: readonly string[],
): T[] {
  if (ids.length === 0) return [...notifications];
  const wanted = new Set(ids);
  return notifications.map((n) =>
    wanted.has(n.id) && !n.read ? { ...n, read: true } : n,
  );
}

/**
 * Mark every notification matching the scope read (immutably). A `pageId` scope
 * matches that page, a `type` scope matches that event type, and an empty scope
 * marks everything. Already-read rows are returned as-is.
 */
export function markAllRead<T extends InboxNotification>(
  notifications: readonly T[],
  scope: MarkAllScope = {},
): T[] {
  const pageId = "pageId" in scope ? scope.pageId : undefined;
  const type = "type" in scope ? scope.type : undefined;
  return notifications.map((n) => {
    if (n.read) return n;
    if (pageId !== undefined && n.pageId !== pageId) return n;
    if (type !== undefined && n.type !== type) return n;
    return { ...n, read: true };
  });
}

/**
 * Collapse each page's events into one entry with a count, newest group first.
 * Notifications without a `pageId` cannot be collapsed and get a count-one entry
 * keyed by their own id (`pageId: null`). Events within a group are newest
 * first; the newest event represents the group.
 */
export function groupByPage<T extends InboxNotification>(
  notifications: readonly T[],
): PageGroup<T>[] {
  const grouped = new Map<string, T[]>();
  for (const n of notifications) {
    const key = n.pageId ?? `id:${n.id}`;
    const existing = grouped.get(key);
    if (existing) existing.push(n);
    else grouped.set(key, [n]);
  }
  const groups: PageGroup<T>[] = [];
  for (const [key, raw] of grouped) {
    const items = sortRecency(raw);
    const latest = items[0] as T;
    groups.push({
      pageId: latest.pageId ?? null,
      key,
      items,
      count: items.length,
      unread: unreadCount(items),
      latest,
    });
  }
  groups.sort((x, y) => compareRecency(x.latest, y.latest));
  return groups;
}

/**
 * Whether one notification would be deferred into a digest rather than alerted
 * now, using the same shared decision as `shouldNotify` (so cadence `INSTANT`
 * and `OFF`, level-`NONE` types and non-mentions all answer `false`).
 */
export function isInDigest(
  notification: InboxNotification,
  prefs: unknown = DEFAULT_NOTIFICATION_PREFS,
): boolean {
  return (
    shouldNotify(prefs, {
      type: notification.type as NotificationEventType,
      mentionsCurrentUser: mentionsCurrentUser(notification),
    }) === "DIGEST"
  );
}
