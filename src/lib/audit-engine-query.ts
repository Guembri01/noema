/**
 * Query/view layer wiring the audit engine (`src/lib/audit-log-engine.ts`) to a
 * real page: parse the URL's filters into an engine selector, then compose
 * {@link filterEvents} / {@link sortEvents} / {@link paginateEvents} /
 * {@link groupByDay} / {@link summarizeEvents} over mapped `Activity` records.
 *
 * Like the engine it sits on, everything here is pure and in-memory: no prisma,
 * no React and no ambient clock (`buildAuditView` is handed `now`, so day
 * labels stay deterministic). Server code (`src/server/audit-engine-data.ts`)
 * supplies the rows; the page and the CSV export share this module so they
 * filter, sort and page identically.
 */

import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  filterEvents,
  groupByDay,
  paginateEvents,
  sortEvents,
  summarizeEvents,
  SYSTEM_ACTOR_ID,
  type AuditCategory,
  type AuditDayGroup,
  type AuditEvent,
  type AuditEventFilter,
  type AuditSortBy,
  type AuditSortOptions,
  type AuditSummary,
} from "@/lib/audit-log-engine";
import { clampLimit, type Direction, type PaginateResult } from "@/lib/cursor-pagination";
import { activityToAuditEvent, type ActivityRecord } from "@/lib/audit-engine-mapping";

/** Events returned per page (and the CSV is not paged at all). */
export const AUDIT_PAGE_SIZE = 50;
/** Hard ceiling on a requested page size. */
export const AUDIT_MAX_PAGE_SIZE = 100;
/** Page-size query key accepted from the URL. */
export const AUDIT_LIMIT_PARAM = "limit";

/** A page's `searchParams`, as Next hands them over (a key may repeat). */
export type AuditSearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** `YYYY-MM-DD`, the only shape a `<input type="date">` can hand back. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Orderable engine fields, validated against the URL. */
const SORT_KEYS: readonly AuditSortBy[] = ["at", "actor", "action"];

const ACTION_IDS = new Set(AUDIT_ACTIONS.map((entry) => entry.action));
const CATEGORY_IDS = new Set<string>(AUDIT_CATEGORIES);

/** Validated, link-rebuildable view of the raw query string. */
export type AuditQueryRaw = {
  readonly actor: string | undefined;
  readonly action: string | undefined;
  readonly category: AuditCategory | undefined;
  readonly target: string | undefined;
  readonly query: string | undefined;
  /** Original `YYYY-MM-DD` day, kept for form redisplay. */
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly sort: AuditSortBy;
  readonly dir: Direction;
  readonly view: "list" | "grouped";
};

/** Everything a surface needs to run the engine for one request. */
export type AuditQuery = {
  readonly filter: AuditEventFilter;
  readonly sort: AuditSortOptions;
  readonly limit: number;
  readonly cursor: string | null;
  readonly grouped: boolean;
  readonly raw: AuditQueryRaw;
};

/** First non-blank value of a possibly-repeated query key. */
function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Inclusive lower bound (UTC midnight) for a day, or undefined. */
function dayStart(day: string | undefined): string | undefined {
  if (!day || !DAY_PATTERN.test(day)) return undefined;
  const iso = `${day}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** Inclusive upper bound (UTC end of day) for a day, or undefined. */
function dayEnd(day: string | undefined): string | undefined {
  if (!day || !DAY_PATTERN.test(day)) return undefined;
  const iso = `${day}T23:59:59.999Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/**
 * Parse untrusted `searchParams` into a validated {@link AuditQuery}. Unknown
 * actions/categories and out-of-range page sizes are dropped (falling back to
 * "no constraint" / the default page size) rather than failing the request;
 * dates are expanded to inclusive UTC instants so a `to` day includes its last
 * millisecond.
 */
export function parseAuditQuery(params: AuditSearchParams = {}): AuditQuery {
  const actor = first(params.actor);
  const actionRaw = first(params.action);
  const action = actionRaw !== undefined && ACTION_IDS.has(actionRaw) ? actionRaw : undefined;
  const categoryRaw = first(params.category);
  const category =
    categoryRaw !== undefined && CATEGORY_IDS.has(categoryRaw)
      ? (categoryRaw as AuditCategory)
      : undefined;
  const target = first(params.target);
  const query = first(params.q);
  const fromDay = first(params.from);
  const toDay = first(params.to);
  const from = dayStart(fromDay);
  const to = dayEnd(toDay);

  const sortRaw = first(params.sort);
  const sort: AuditSortBy =
    sortRaw !== undefined && (SORT_KEYS as readonly string[]).includes(sortRaw)
      ? (sortRaw as AuditSortBy)
      : "at";
  const dir: Direction = first(params.dir) === "asc" ? "asc" : "desc";
  const view: "list" | "grouped" = first(params.view) === "grouped" ? "grouped" : "list";

  const filter: AuditEventFilter = {
    ...(actor !== undefined ? { actorId: actor } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(target !== undefined ? { targetType: target } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };

  return {
    filter,
    sort: { by: sort, dir },
    limit: clampLimit(first(params[AUDIT_LIMIT_PARAM]), {
      min: 1,
      max: AUDIT_MAX_PAGE_SIZE,
      fallback: AUDIT_PAGE_SIZE,
    }),
    cursor: first(params.cursor) ?? null,
    grouped: view === "grouped",
    raw: {
      actor,
      action,
      category,
      target,
      query,
      from: fromDay !== undefined && DAY_PATTERN.test(fromDay) ? fromDay : undefined,
      to: toDay !== undefined && DAY_PATTERN.test(toDay) ? toDay : undefined,
      sort,
      dir,
      view,
    },
  };
}

/** The mapped, filtered and ordered feed (the whole match, not one page). */
export function selectAuditEvents(
  records: readonly ActivityRecord[],
  query: AuditQuery,
): AuditEvent[] {
  const events = records.map(activityToAuditEvent);
  return sortEvents(filterEvents(events, query.filter), query.sort);
}

/** Everything a render (or CSV export) needs from one engine pass. */
export type AuditView = {
  /** Matching events across the whole scan, before paging. */
  readonly total: number;
  /** One keyset page, newest first by `(at, id)`. */
  readonly page: PaginateResult<AuditEvent>;
  /** The page's events re-ordered by the requested sort (display order). */
  readonly items: AuditEvent[];
  /** The page's events sectioned into UTC day-buckets, newest day first. */
  readonly groups: AuditDayGroup<AuditEvent>[];
  /** Counts over every match (not just the page). */
  readonly summary: AuditSummary;
};

/**
 * Run one engine pass over `records`: map → filter → summarize (whole match) and
 * filter → paginate (keyset, newest first) → sort (display) → group (day
 * buckets for the page). `now` is forwarded to {@link groupByDay} so the
 * "Today"/"Yesterday" labels are deterministic.
 *
 * Pagination is always the engine's newest-first `(at, id)` keyset — that is the
 * only cursor the engine emits — so a non-recency `sort` reorders the returned
 * page for display rather than changing the page boundary.
 */
export function buildAuditView(
  records: readonly ActivityRecord[],
  query: AuditQuery,
  now: string | number | Date = Date.now(),
): AuditView {
  const events = records.map(activityToAuditEvent);
  const filtered = filterEvents(events, query.filter);
  const page = paginateEvents(filtered, { limit: query.limit, cursor: query.cursor });
  const items = sortEvents(page.items, query.sort);
  const groups = groupByDay(page.items, now);
  const summary = summarizeEvents(filtered);
  return { total: filtered.length, page, items, groups, summary };
}

/**
 * Rebuild the query string for a link (pagination, CSV export, sort toggle)
 * from the validated query, so a filtered view never silently loses a filter.
 * Pass `{ cursor: null }` to drop the cursor (first page / export-all).
 */
export function auditSearchParams(
  query: AuditQuery,
  overrides: Partial<AuditQueryRaw> & { cursor?: string | null } = {},
): URLSearchParams {
  const raw = { ...query.raw, ...overrides };
  const params = new URLSearchParams();
  if (raw.actor !== undefined) params.set("actor", raw.actor);
  if (raw.action !== undefined) params.set("action", raw.action);
  if (raw.category !== undefined) params.set("category", raw.category);
  if (raw.target !== undefined) params.set("target", raw.target);
  if (raw.query !== undefined) params.set("q", raw.query);
  if (raw.from !== undefined) params.set("from", raw.from);
  if (raw.to !== undefined) params.set("to", raw.to);
  if (raw.sort !== "at") params.set("sort", raw.sort);
  if (raw.dir === "asc") params.set("dir", "asc");
  if (raw.view === "grouped") params.set("view", "grouped");
  if (query.limit !== AUDIT_PAGE_SIZE) params.set(AUDIT_LIMIT_PARAM, String(query.limit));

  if (overrides.cursor === null) {
    // explicitly dropped
  } else if (overrides.cursor !== undefined) {
    params.set("cursor", overrides.cursor);
  } else if (query.cursor !== null) {
    params.set("cursor", query.cursor);
  }
  return params;
}

/**
 * Whether a viewer sees unredacted audit data. The audit trail is gated to
 * managers and above, but only the workspace OWNER is treated as the audit
 * "admin" that `redactEvent` keeps the sensitive `ip`/`meta` payload for; a
 * manager (ADMIN) — still allowed to read the feed — gets the redacted copy.
 */
export function isAuditAdmin(role: string | null | undefined): boolean {
  return role === "OWNER";
}

/** System actor id re-exported so callers need not reach into the engine. */
export { SYSTEM_ACTOR_ID };
