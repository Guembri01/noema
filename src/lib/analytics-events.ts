/**
 * Page analytics events — pure aggregation over the view/edit/create/comment
 * trail (docs/FEATURE_MATRIX.md, "Actions menu: Updates & analytics panel").
 *
 * An `AnalyticsEvent` is one recorded interaction with a page. Everything here
 * is pure and in-memory: no DB, no React. Callers are expected to feed the
 * stored event log straight in, so the helpers are tolerant of the messy edges
 * a log always carries — unparseable timestamps, out-of-range days, unsorted
 * input — and never throw.
 *
 * Determinism is a contract, not a nicety: every list result is stably ordered
 * (count desc, then id ascending; recency desc, then id ascending) and every
 * timestamp is emitted as a normalized UTC ISO string, so two runs over the
 * same events are byte-identical and a server render matches the client.
 * Inputs are never mutated; results are always fresh objects.
 */

/** The kinds of interaction the event log records. */
export type AnalyticsEventKind = "view" | "edit" | "create" | "comment";

/** Stable order used for count records and any kind iteration. */
export const ANALYTICS_EVENT_KINDS: readonly AnalyticsEventKind[] = [
  "view",
  "edit",
  "create",
  "comment",
];

/** One recorded interaction with a page. `at` is an ISO 8601 timestamp. */
export type AnalyticsEvent = {
  id: string;
  pageId: string;
  actorId: string;
  kind: AnalyticsEventKind;
  at: string;
};

/** Default number of ranked pages / actors returned when a limit is omitted. */
export const DEFAULT_TOP_PAGES_LIMIT = 10;
export const DEFAULT_RECENT_ACTORS_LIMIT = 10;

const MS_PER_DAY = 86_400_000;

const isKind = (value: unknown): value is AnalyticsEventKind =>
  typeof value === "string" && (ANALYTICS_EVENT_KINDS as readonly string[]).includes(value);

/** Per-kind counters, always carrying all four kinds (so reads never hit `undefined`). */
function emptyCounts(): Record<AnalyticsEventKind, number> {
  return { view: 0, edit: 0, create: 0, comment: 0 };
}

const totalOf = (counts: Record<AnalyticsEventKind, number>): number =>
  ANALYTICS_EVENT_KINDS.reduce((total, kind) => total + counts[kind], 0);

/** Absolute instant (ms) of an ISO timestamp, or null when it cannot be parsed. */
function instantOf(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** UTC calendar day (`YYYY-MM-DD`) of an instant. */
const utcDayKey = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

/** UTC midnight of the day an ISO value falls on, or null when unparseable. */
function utcDayStart(value: string): number | null {
  const instant = instantOf(value);
  if (instant === null) return null;
  const day = new Date(instant);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/** ISO string in UTC; the winning instant normalized so ties compare equal. */
const isoUtc = (instant: number): string => new Date(instant).toISOString();

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Coerce a limit option: non-finite falls back, negatives/decimals are floored. */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** One page's rolled-up activity. */
export type PageAggregate = {
  pageId: string;
  /** Event count per kind; all four kinds are always present. */
  counts: Record<AnalyticsEventKind, number>;
  /** Sum of `counts`, including unrecognised kinds from untyped data. */
  total: number;
  /** Distinct `actorId`s seen on the page. */
  uniqueActors: number;
  /** Latest parseable `at` (UTC ISO), or null when no event has a valid time. */
  lastActivity: string | null;
};

/**
 * Roll the event stream up by page. Pages come back sorted by id, so the result
 * is independent of input order; unknown `kind`s count toward `total`/`uniqueActors`
 * but not any named kind, and events with an unparseable `at` still count — they
 * just cannot win `lastActivity`.
 */
export function aggregateByPage(events: readonly AnalyticsEvent[]): PageAggregate[] {
  type Mutable = { counts: Record<AnalyticsEventKind, number>; actors: Set<string>; last: number | null };
  const byPage = new Map<string, Mutable>();
  for (const event of events) {
    let entry = byPage.get(event.pageId);
    if (!entry) {
      entry = { counts: emptyCounts(), actors: new Set<string>(), last: null };
      byPage.set(event.pageId, entry);
    }
    if (isKind(event.kind)) entry.counts[event.kind] += 1;
    entry.actors.add(event.actorId);
    const instant = instantOf(event.at);
    if (instant !== null && (entry.last === null || instant > entry.last)) entry.last = instant;
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([pageId, entry]) => ({
      pageId,
      counts: { ...entry.counts },
      total: totalOf(entry.counts),
      uniqueActors: entry.actors.size,
      lastActivity: entry.last === null ? null : isoUtc(entry.last),
    }));
}

/** Inclusive UTC range for `dailySeries`; `from`/`to` may be a date or datetime. */
export type DailySeriesRange = { from: string; to: string };

/** One UTC day in the series; omitted days are zero-filled, never skipped. */
export type DailyBucket = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  counts: Record<AnalyticsEventKind, number>;
  total: number;
};

/**
 * Bucket events into a dense series of UTC days spanning `from`..`to` inclusive.
 * Bounds are whole days (a datetime bound still covers its full day). Events
 * outside the range or with an unparseable timestamp are ignored. A reversed or
 * invalid range yields an empty series.
 */
export function dailySeries(
  events: readonly AnalyticsEvent[],
  range: DailySeriesRange,
): DailyBucket[] {
  const fromStart = utcDayStart(range.from);
  const toStart = utcDayStart(range.to);
  if (fromStart === null || toStart === null || fromStart > toStart) return [];

  const buckets: DailyBucket[] = [];
  const byDay = new Map<string, DailyBucket>();
  for (let start = fromStart; start <= toStart; start += MS_PER_DAY) {
    const bucket: DailyBucket = { date: utcDayKey(start), counts: emptyCounts(), total: 0 };
    buckets.push(bucket);
    byDay.set(bucket.date, bucket);
  }

  const rangeEnd = toStart + MS_PER_DAY;
  for (const event of events) {
    const instant = instantOf(event.at);
    if (instant === null || instant < fromStart || instant >= rangeEnd) continue;
    const bucket = byDay.get(utcDayKey(instant));
    if (bucket && isKind(event.kind)) bucket.counts[event.kind] += 1;
  }

  for (const bucket of buckets) bucket.total = totalOf(bucket.counts);
  return buckets;
}

/** A page and its event count. */
export type PageCount = { pageId: string; count: number };

export type TopPagesOptions = {
  /** Maximum entries returned; defaults to `DEFAULT_TOP_PAGES_LIMIT`; ≤0 yields none. */
  limit?: number;
  /** Count only this kind; omit to count every event. */
  kind?: AnalyticsEventKind;
};

/**
 * Rank pages by event count (optionally a single kind). Sorted by count
 * descending, ties broken by ascending `pageId`; capped at `limit`.
 */
export function topPages(
  events: readonly AnalyticsEvent[],
  options: TopPagesOptions = {},
): PageCount[] {
  const limit = normalizeLimit(options.limit, DEFAULT_TOP_PAGES_LIMIT);
  if (limit <= 0) return [];
  const counts = new Map<string, number>();
  for (const event of events) {
    if (options.kind !== undefined && event.kind !== options.kind) continue;
    counts.set(event.pageId, (counts.get(event.pageId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pageId, count]) => ({ pageId, count }))
    .sort((a, b) => b.count - a.count || compareIds(a.pageId, b.pageId))
    .slice(0, limit);
}

/** An actor and how they most recently touched pages. */
export type ActorActivity = {
  actorId: string;
  count: number;
  /** Latest parseable `at` (UTC ISO), or null when no event has a valid time. */
  lastActivity: string | null;
};

export type RecentActorsOptions = {
  /** Maximum entries returned; defaults to `DEFAULT_RECENT_ACTORS_LIMIT`; ≤0 yields none. */
  limit?: number;
};

/** Recency ordering: newest first, actors without a valid time last, id ascending on ties. */
function byRecency(a: number | null, b: number | null, aId: string, bId: string): number {
  if (a === null && b === null) return compareIds(aId, bId);
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a || compareIds(aId, bId);
}

/**
 * The most recently active actors, newest activity first; ties (and actors with
 * no parseable timestamp) break by ascending `actorId`. Capped at `limit`.
 */
export function recentActors(
  events: readonly AnalyticsEvent[],
  options: RecentActorsOptions = {},
): ActorActivity[] {
  const limit = normalizeLimit(options.limit, DEFAULT_RECENT_ACTORS_LIMIT);
  if (limit <= 0) return [];
  const byActor = new Map<string, { count: number; last: number | null }>();
  for (const event of events) {
    let entry = byActor.get(event.actorId);
    if (!entry) {
      entry = { count: 0, last: null };
      byActor.set(event.actorId, entry);
    }
    entry.count += 1;
    const instant = instantOf(event.at);
    if (instant !== null && (entry.last === null || instant > entry.last)) entry.last = instant;
  }
  return [...byActor.entries()]
    .sort(([aId, a], [bId, b]) => byRecency(a.last, b.last, aId, bId))
    .slice(0, limit)
    .map(([actorId, entry]) => ({
      actorId,
      count: entry.count,
      lastActivity: entry.last === null ? null : isoUtc(entry.last),
    }));
}
