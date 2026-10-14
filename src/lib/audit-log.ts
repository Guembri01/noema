/**
 * Workspace-wide audit feed — the pure query half of "Audit log UI"
 * (docs/MISSING_FEATURES.md top-gap #10, docs/FEATURE_MATRIX.md "Audit log").
 *
 * Rows are already recorded by `logActivity` (`src/lib/activity.ts`, writes the
 * Prisma `Activity` model); what is missing is a filterable, paginated view over
 * them. This module is that view's reference implementation and is deliberately
 * PURE: no prisma, no routes, no React and no ambient clock. `groupAuditByDay`
 * is handed the current instant, so every day-bucket label is deterministic and
 * unit-testable, and `paginateAudit` reuses the shared keyset pagination
 * primitive from `@/lib/cursor-pagination` rather than inventing a second
 * cursor format.
 *
 * `normalizeAuditEvent` is the one tolerant door into the typed shape: raw
 * `unknown` rows (a Prisma row, a JSON payload, a form body) are validated and
 * coerced, or rejected with `null` — it never throws.
 *
 * Unit-pinned red-first by `src/lib/audit-log.test.ts`.
 */

import { paginateSlice, type PaginateResult } from "@/lib/cursor-pagination";

/** Actor recorded on events with no human author (a scheduled or system write). */
export const SYSTEM_ACTOR_ID = "system";

/** The subset of an `Activity` row this feed needs, typed and normalised. */
export type AuditEvent = {
  readonly id: string;
  /** Human actor id, or `SYSTEM_ACTOR_ID` when the write had no author. */
  readonly actorId: string;
  /** Dotted action, e.g. `page.created` (see `ActivityAction`). */
  readonly type: string;
  /** Id of the entity acted upon (page, ticket, member, …). */
  readonly entityId: string;
  /** Kind of that entity, e.g. `page`. */
  readonly entityType: string;
  /** ISO-8601 timestamp; compared by instant, not by string shape. */
  readonly createdAt: string;
  /** Optional structured payload (title, previous value, …). */
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** Selector for `filterAuditEvents`; every field is optional. */
export type AuditFilter = {
  /** Keep events whose actor is one of these ids. `[]` matches nothing. */
  readonly actorIds?: readonly string[];
  /** Keep events whose dotted type is one of these. `[]` matches nothing. */
  readonly types?: readonly string[];
  /** Keep events targeting exactly this entity id. */
  readonly entityId?: string;
  /** Inclusive lower bound on `createdAt`. */
  readonly from?: string;
  /** Inclusive upper bound on `createdAt`. */
  readonly to?: string;
};

/** One UTC day-bucket of the feed, newest events first within the day. */
export type AuditDayGroup<T extends AuditEvent = AuditEvent> = {
  /** `YYYY-MM-DD` in UTC. */
  readonly day: string;
  /** `"Today"`, `"Yesterday"`, or the raw `day` key for older dates. */
  readonly label: string;
  readonly events: readonly T[];
  readonly count: number;
};

const DAY_MS = 86_400_000;

/** Empty / whitespace-only strings are not valid identifiers. */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Coerce a raw timestamp to an ISO string, or `null` when it is not a
 * recognisable instant. Strings are kept verbatim (so precision and `Z` vs
 * offset survive), `Date` and finite epoch numbers are converted.
 */
function asIsoString(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number.isNaN(Date.parse(value)) ? null : value;
  }
  return null;
}

/** A plain-object meta is copied; anything else is dropped (not an error). */
function asMeta(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}

/** Millisecond instant of a timestamp; unparseable input sorts as epoch 0. */
function toMillis(value: string | number | Date): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** `YYYY-MM-DD` for the UTC day containing `ms`. */
function utcDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Validate and coerce a raw audit row into an {@link AuditEvent}. Returns `null`
 * for anything that is not a plain object or that is missing a required
 * identifier (`id`, `type`, `entityId`, `entityType`) or a parseable
 * `createdAt`. A missing actor becomes {@link SYSTEM_ACTOR_ID}; non-object
 * `meta` is dropped. Never throws.
 */
export function normalizeAuditEvent(raw: unknown): AuditEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const id = asNonEmptyString(row.id);
  if (id === null) return null;
  const type = asNonEmptyString(row.type);
  if (type === null) return null;
  const entityId = asNonEmptyString(row.entityId);
  if (entityId === null) return null;
  const entityType = asNonEmptyString(row.entityType);
  if (entityType === null) return null;
  const createdAt = asIsoString(row.createdAt);
  if (createdAt === null) return null;

  const actorId = asNonEmptyString(row.actorId) ?? SYSTEM_ACTOR_ID;
  const meta = asMeta(row.meta);
  const event: AuditEvent = { id, actorId, type, entityId, entityType, createdAt };
  return meta === undefined ? event : { ...event, meta };
}

/**
 * Keep the events matching every supplied constraint (logical AND). Order is
 * preserved; the input is never mutated. A list filter that is present but empty
 * matches nothing (an explicit "none"), while an omitted filter is unconstrained.
 * `from`/`to` are inclusive and compare instants, not string shape.
 */
export function filterAuditEvents<T extends AuditEvent>(
  events: readonly T[],
  filter: AuditFilter = {},
): T[] {
  const actors = filter.actorIds === undefined ? null : new Set(filter.actorIds);
  const types = filter.types === undefined ? null : new Set(filter.types);
  const from = filter.from === undefined ? null : toMillis(filter.from);
  const to = filter.to === undefined ? null : toMillis(filter.to);

  return events.filter((event) => {
    if (actors !== null && !actors.has(event.actorId)) return false;
    if (types !== null && !types.has(event.type)) return false;
    if (filter.entityId !== undefined && event.entityId !== filter.entityId) return false;
    if (from !== null || to !== null) {
      const instant = toMillis(event.createdAt);
      if (from !== null && instant < from) return false;
      if (to !== null && instant > to) return false;
    }
    return true;
  });
}

/**
 * Newest first by `createdAt`, ties broken by id descending — a total,
 * deterministic order. Returns a copy; the input array and its events are never
 * mutated.
 */
export function sortAuditEvents<T extends AuditEvent>(events: readonly T[]): T[] {
  return [...events].sort((left, right) => {
    const diff = toMillis(right.createdAt) - toMillis(left.createdAt);
    if (diff !== 0) return diff;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}

/**
 * Section the feed into UTC day-buckets, newest day first and newest event first
 * within each day. `now` (pinned by callers/tests) selects the `"Today"` /
 * `"Yesterday"` labels; every other bucket keeps its `YYYY-MM-DD` key. Empty
 * input yields `[]`.
 */
export function groupAuditByDay<T extends AuditEvent>(
  events: readonly T[],
  now: string | number | Date = Date.now(),
): AuditDayGroup<T>[] {
  const nowMs = toMillis(now);
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);

  const buckets = new Map<string, T[]>();
  for (const event of events) {
    const key = utcDayKey(toMillis(event.createdAt));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(event);
    else buckets.set(key, [event]);
  }

  const days = [...buckets.keys()].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  return days.map((day) => {
    const dayEvents = sortAuditEvents(buckets.get(day) as T[]);
    const label = day === todayKey ? "Today" : day === yesterdayKey ? "Yesterday" : day;
    return { day, label, events: dayEvents, count: dayEvents.length };
  });
}

/**
 * One keyset page of the feed, newest first. The events are ordered internally
 * by {@link sortAuditEvents}, so callers may pass rows in any order; the cursor
 * is the shared `@/lib/cursor-pagination` token over `{ createdAt, id }`, so the
 * boundary row is never repeated or skipped and a malformed cursor fails closed
 * (empty page, `hasMore: false`).
 */
export function paginateAudit<T extends AuditEvent>(
  events: readonly T[],
  options: { limit?: number; cursor?: string | null } = {},
): PaginateResult<T> {
  return paginateSlice(sortAuditEvents(events), {
    limit: options.limit,
    cursor: options.cursor,
    keyOf: (event) => ({ key: event.createdAt, tiebreaker: event.id }),
  });
}

/** Readable verb for a dotted action's final segment. */
const VERB_LABELS: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  archived: "archived",
  restored: "restored",
  resolved: "resolved",
  reopened: "reopened",
  shared: "shared",
  unshared: "unshared",
  moved: "moved",
  duplicated: "duplicated",
  role_changed: "changed the role of",
  ownership_transferred: "transferred ownership of",
  left: "left",
  removed: "removed",
  invited: "invited",
};

/** The verb for an action type: last dotted segment, label-expanded or raw. */
function verbOf(type: string): string {
  const cut = type.lastIndexOf(".");
  const segment = cut === -1 ? type : type.slice(cut + 1);
  return VERB_LABELS[segment] ?? segment.replace(/_/g, " ");
}

/** A display title from the meta payload, preferring `title` over `name`. */
function titleOf(meta: AuditEvent["meta"]): string | null {
  if (meta === undefined) return null;
  for (const key of ["title", "name"] as const) {
    const value = meta[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * One-line human summary of an event, e.g. `"ada archived page p9 (Old notes)"`.
 * The actor and entity are ids (names are not available to a pure helper); the
 * verb comes from the action's final segment and the meta title, when present,
 * is appended in parentheses.
 */
export function describeAuditEvent(event: AuditEvent): string {
  const summary = `${event.actorId} ${verbOf(event.type)} ${event.entityType} ${event.entityId}`;
  const title = titleOf(event.meta);
  return title === null ? summary : `${summary} (${title})`;
}
