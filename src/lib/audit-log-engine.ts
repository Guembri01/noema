/**
 * Workspace audit log engine (docs/MISSING_FEATURES.md top-gap #10 "Audit log
 * UI", docs/FEATURE_MATRIX.md "Audit log").
 *
 * This is a self-contained engine over a rich {@link AuditEvent} row: a fixed
 * action catalogue with categories/severities, tolerant parsing of untrusted
 * rows, filtering, sorting, keyset pagination, day grouping, summaries, CSV
 * export and role-aware redaction.
 *
 * `src/lib/audit-log.ts` is the older, Prisma-`Activity`-shaped feed (it uses
 * `type`/`entityId`/`createdAt`); this module deliberately keeps the newer
 * `action`/`targetType`/`targetId`/`at` vocabulary so audit surfaces can carry
 * workspace, target and request metadata.
 *
 * Everything is pure and in-memory: no prisma, no routes, no React and no
 * ambient clock — `groupByDay` is handed the current instant, so day-bucket
 * labels are deterministic and unit-testable. Inputs are never mutated and
 * results are always fresh objects.
 *
 * Unit-pinned red-first by `src/lib/audit-log-engine.test.ts`.
 */

import { paginateSlice, type Direction, type PaginateResult } from "@/lib/cursor-pagination";
import { matrixToCsv } from "@/lib/serialize";

/** Actor recorded on events with no human author (a scheduled or system write). */
export const SYSTEM_ACTOR_ID = "system";

/** How loudly a surface should present an action. */
export type AuditSeverity = "info" | "notice" | "warning" | "critical";

/** The subject area an action belongs to; used for filtering and summaries. */
export type AuditCategory =
  | "content"
  | "membership"
  | "permissions"
  | "workspace"
  | "security"
  | "integration"
  | "billing";

/** Stable order of {@link AuditCategory}, so summaries always carry every key. */
export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  "content",
  "membership",
  "permissions",
  "workspace",
  "security",
  "integration",
  "billing",
];

/** A catalogue entry: one auditable action and how to present it. */
export type AuditActionDescriptor = {
  /** Stable dotted action id, e.g. `"page.created"`. */
  readonly action: string;
  /** Short, human-facing verb phrase, e.g. `"Created a page"`. */
  readonly label: string;
  readonly category: AuditCategory;
  readonly severity: AuditSeverity;
};

/**
 * The auditable action catalogue, in presentation order. This is the single
 * source of truth for an action's label, category and severity; anything not
 * listed here is still recordable but renders as its raw id and belongs to no
 * category.
 */
export const AUDIT_ACTIONS: readonly AuditActionDescriptor[] = [
  { action: "page.created", label: "Created a page", category: "content", severity: "info" },
  { action: "page.updated", label: "Edited a page", category: "content", severity: "info" },
  { action: "page.archived", label: "Archived a page", category: "content", severity: "notice" },
  { action: "page.deleted", label: "Deleted a page", category: "content", severity: "warning" },
  { action: "page.restored", label: "Restored a page", category: "content", severity: "notice" },
  { action: "database.created", label: "Created a database", category: "content", severity: "info" },
  { action: "database.deleted", label: "Deleted a database", category: "content", severity: "warning" },
  { action: "member.invited", label: "Invited a member", category: "membership", severity: "notice" },
  { action: "member.joined", label: "A member joined", category: "membership", severity: "notice" },
  { action: "member.removed", label: "Removed a member", category: "membership", severity: "warning" },
  {
    action: "member.role_changed",
    label: "Changed a member's role",
    category: "membership",
    severity: "warning",
  },
  { action: "permission.granted", label: "Granted a permission", category: "permissions", severity: "notice" },
  { action: "permission.revoked", label: "Revoked a permission", category: "permissions", severity: "warning" },
  { action: "share.created", label: "Shared with a link", category: "permissions", severity: "notice" },
  { action: "share.revoked", label: "Revoked a share link", category: "permissions", severity: "notice" },
  { action: "workspace.created", label: "Created the workspace", category: "workspace", severity: "notice" },
  { action: "workspace.updated", label: "Updated the workspace", category: "workspace", severity: "info" },
  {
    action: "workspace.settings_changed",
    label: "Changed workspace settings",
    category: "workspace",
    severity: "notice",
  },
  { action: "workspace.deleted", label: "Deleted the workspace", category: "workspace", severity: "critical" },
  { action: "login.succeeded", label: "Signed in", category: "security", severity: "info" },
  { action: "login.failed", label: "Failed sign-in", category: "security", severity: "warning" },
  { action: "password.changed", label: "Changed a password", category: "security", severity: "warning" },
  { action: "api_key.created", label: "Created an API key", category: "security", severity: "notice" },
  { action: "api_key.revoked", label: "Revoked an API key", category: "security", severity: "warning" },
  { action: "session.revoked", label: "Revoked a session", category: "security", severity: "notice" },
  { action: "integration.connected", label: "Connected an integration", category: "integration", severity: "notice" },
  {
    action: "integration.disconnected",
    label: "Disconnected an integration",
    category: "integration",
    severity: "notice",
  },
  { action: "webhook.created", label: "Created a webhook", category: "integration", severity: "notice" },
  { action: "webhook.deleted", label: "Deleted a webhook", category: "integration", severity: "notice" },
  { action: "billing.plan_changed", label: "Changed the billing plan", category: "billing", severity: "notice" },
  { action: "billing.payment_failed", label: "A payment failed", category: "billing", severity: "critical" },
];

const AUDIT_ACTION_MAP: ReadonlyMap<string, AuditActionDescriptor> = new Map(
  AUDIT_ACTIONS.map((entry) => [entry.action, entry] as const),
);

/** The catalogue entry for an action, or `undefined` when it is not listed. */
export function auditActionDescriptor(action: string): AuditActionDescriptor | undefined {
  return AUDIT_ACTION_MAP.get(action);
}

/** Human label for an action; unknown actions fall back to their raw id. */
export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_MAP.get(action)?.label ?? action;
}

/** Category of an action, or `null` when it is not catalogued. */
function categoryOf(action: string): AuditCategory | null {
  return AUDIT_ACTION_MAP.get(action)?.category ?? null;
}

/** A normalised audit row. */
export type AuditEvent = {
  readonly id: string;
  readonly workspaceId: string;
  /** Human actor id, or {@link SYSTEM_ACTOR_ID} when the write had no author. */
  readonly actorId: string;
  /** Dotted action id; see {@link AUDIT_ACTIONS}. */
  readonly action: string;
  /** Kind of entity acted upon, e.g. `"page"`. */
  readonly targetType: string;
  /** Id of the entity acted upon. */
  readonly targetId: string;
  /** Display name of the target at the time of the action, when known. */
  readonly targetName?: string;
  /** Optional structured payload (previous value, request id, …). */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** ISO-8601 timestamp; compared by instant, not by string shape. */
  readonly at: string;
  /** Request origin, when recorded. Treated as sensitive (see `redactEvent`). */
  readonly ip?: string;
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

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validate and coerce a raw audit row into an {@link AuditEvent}. Returns
 * `null` for anything that is not a plain object or that is missing a required
 * field (`id`, `workspaceId`, `action`, `targetType`, `targetId`) or a
 * parseable `at`. A missing actor becomes {@link SYSTEM_ACTOR_ID}; blank
 * optional strings and non-object `meta` are dropped. Never throws.
 */
export function parseAuditEvent(raw: unknown): AuditEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const id = asNonEmptyString(row.id);
  if (id === null) return null;
  const workspaceId = asNonEmptyString(row.workspaceId);
  if (workspaceId === null) return null;
  const action = asNonEmptyString(row.action);
  if (action === null) return null;
  const targetType = asNonEmptyString(row.targetType);
  if (targetType === null) return null;
  const targetId = asNonEmptyString(row.targetId);
  if (targetId === null) return null;
  const at = asIsoString(row.at);
  if (at === null) return null;

  const actorId = asNonEmptyString(row.actorId) ?? SYSTEM_ACTOR_ID;
  const targetName = asNonEmptyString(row.targetName);
  const ip = asNonEmptyString(row.ip);
  const meta = asMeta(row.meta);

  const event: AuditEvent = { id, workspaceId, actorId, action, targetType, targetId, at };
  const withName: AuditEvent = targetName === null ? event : { ...event, targetName };
  const withIp: AuditEvent = ip === null ? withName : { ...withName, ip };
  return meta === undefined ? withIp : { ...withIp, meta };
}

/** Selector for {@link filterEvents}; every field is optional and ANDed. */
export type AuditEventFilter = {
  /** Keep events by exactly this actor. */
  readonly actorId?: string;
  /** Keep events with exactly this action id. */
  readonly action?: string;
  /** Keep events whose action belongs to this catalogue category. */
  readonly category?: AuditCategory;
  /** Keep events targeting exactly this entity kind. */
  readonly targetType?: string;
  /** Inclusive lower bound on `at`. */
  readonly from?: string;
  /** Inclusive upper bound on `at`. */
  readonly to?: string;
  /** Case-insensitive substring over target name, target id, actor and action. */
  readonly query?: string;
};

/** Whether an event's searchable text contains `needle` (already lowercased). */
function matchesQuery(event: AuditEvent, needle: string): boolean {
  const haystack = [event.targetName, event.targetId, event.actorId, event.action]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Keep the events matching every supplied constraint (logical AND). Order is
 * preserved and the input is never mutated. A blank `query` is unconstrained;
 * `from`/`to` are inclusive and compare instants, not string shape. Events with
 * an uncatalogued action match no `category`.
 */
export function filterEvents<T extends AuditEvent>(
  events: readonly T[],
  filter: AuditEventFilter = {},
): T[] {
  const from = filter.from === undefined ? null : toMillis(filter.from);
  const to = filter.to === undefined ? null : toMillis(filter.to);
  const query = filter.query === undefined ? null : filter.query.trim().toLowerCase();

  return events.filter((event) => {
    if (filter.actorId !== undefined && event.actorId !== filter.actorId) return false;
    if (filter.action !== undefined && event.action !== filter.action) return false;
    if (filter.targetType !== undefined && event.targetType !== filter.targetType) return false;
    if (filter.category !== undefined && categoryOf(event.action) !== filter.category) return false;
    if (from !== null || to !== null) {
      const instant = toMillis(event.at);
      if (from !== null && instant < from) return false;
      if (to !== null && instant > to) return false;
    }
    if (query !== null && query !== "" && !matchesQuery(event, query)) return false;
    return true;
  });
}

/** Field {@link sortEvents} orders by. */
export type AuditSortBy = "at" | "actor" | "action";

/** Sort selector; defaults to `{ by: "at", dir: "desc" }` (newest first). */
export type AuditSortOptions = {
  readonly by?: AuditSortBy;
  /** Direction of the primary key; ties always break by ascending id. */
  readonly dir?: Direction;
};

/**
 * Order events by `at`, `actor` or `action`, ties broken deterministically by
 * ascending `id`. Returns a fresh array; the input is never mutated.
 */
export function sortEvents<T extends AuditEvent>(
  events: readonly T[],
  options: AuditSortOptions = {},
): T[] {
  const by = options.by ?? "at";
  const sign = (options.dir ?? "desc") === "asc" ? 1 : -1;
  return [...events].sort((left, right) => {
    const primary =
      by === "actor"
        ? compareStrings(left.actorId, right.actorId)
        : by === "action"
          ? compareStrings(left.action, right.action)
          : toMillis(left.at) - toMillis(right.at);
    if (primary !== 0) return primary * sign;
    return compareStrings(left.id, right.id);
  });
}

/**
 * One keyset page of the feed, newest first. Events are ordered internally by
 * the `(at, id)` tuple, so callers may pass rows in any order; the cursor is the
 * shared `@/lib/cursor-pagination` token over `{ at, id }`, so the boundary row
 * is never repeated or skipped and a malformed cursor fails closed (empty page,
 * `hasMore: false`).
 */
export function paginateEvents<T extends AuditEvent>(
  events: readonly T[],
  options: { limit?: number; cursor?: string | null } = {},
): PaginateResult<T> {
  return paginateSlice(events, {
    limit: options.limit,
    cursor: options.cursor,
    keyOf: (event) => ({ key: event.at, tiebreaker: event.id }),
  });
}

/** One UTC day-bucket of the feed, newest events first within the day. */
export type AuditDayGroup<T extends AuditEvent = AuditEvent> = {
  /** `YYYY-MM-DD` in UTC. */
  readonly day: string;
  /** `"Today"`, `"Yesterday"`, or the raw `day` key for older dates. */
  readonly label: string;
  readonly events: readonly T[];
  readonly count: number;
};

/**
 * Section the feed into UTC day-buckets, newest day first and newest event
 * first within each day. `now` (pinned by callers/tests) selects the `"Today"` /
 * `"Yesterday"` labels; every other bucket keeps its `YYYY-MM-DD` key. Empty
 * input yields `[]`.
 */
export function groupByDay<T extends AuditEvent>(
  events: readonly T[],
  now: string | number | Date = Date.now(),
): AuditDayGroup<T>[] {
  const nowMs = toMillis(now);
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);

  const buckets = new Map<string, T[]>();
  for (const event of events) {
    const key = utcDayKey(toMillis(event.at));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(event);
    else buckets.set(key, [event]);
  }

  const days = [...buckets.keys()].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  return days.map((day) => {
    const dayEvents = sortEvents(buckets.get(day) as T[]);
    const label = day === todayKey ? "Today" : day === yesterdayKey ? "Yesterday" : day;
    return { day, label, events: dayEvents, count: dayEvents.length };
  });
}

/** Rolled-up counts over a set of events. */
export type AuditSummary = {
  readonly total: number;
  /** Every category is present, so reads never hit `undefined`. */
  readonly byCategory: Record<AuditCategory, number>;
  readonly byActor: Record<string, number>;
  readonly byAction: Record<string, number>;
};

/** A `Record` built from a counter map, keys sorted ascending for determinism. */
function sortedRecord(counts: ReadonlyMap<string, number>): Record<string, number> {
  const entries = [...counts.entries()].sort(([a], [b]) => compareStrings(a, b));
  return Object.fromEntries(entries);
}

/**
 * Aggregate a set of events into a total plus per-category, per-actor and
 * per-action counts. Unrecognised actions still count toward `total`, `byActor`
 * and `byAction`, but never toward a category. Never mutates its input.
 */
export function summarizeEvents(events: readonly AuditEvent[]): AuditSummary {
  const byCategory = Object.fromEntries(
    AUDIT_CATEGORIES.map((category) => [category, 0]),
  ) as Record<AuditCategory, number>;
  const byActor = new Map<string, number>();
  const byAction = new Map<string, number>();

  for (const event of events) {
    const category = categoryOf(event.action);
    if (category !== null) byCategory[category] += 1;
    byActor.set(event.actorId, (byActor.get(event.actorId) ?? 0) + 1);
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
  }

  return {
    total: events.length,
    byCategory,
    byActor: sortedRecord(byActor),
    byAction: sortedRecord(byAction),
  };
}

/** Column order of the audit CSV export. */
const CSV_COLUMNS = [
  "id",
  "at",
  "workspaceId",
  "actorId",
  "action",
  "category",
  "targetType",
  "targetId",
  "targetName",
  "ip",
] as const;

/**
 * Render events as an RFC-4180-style CSV document (CRLF rows, quoted where
 * needed, trailing newline). Rows keep the caller's event order. The `category`
 * column is resolved from the catalogue and left blank for uncatalogued
 * actions.
 */
export function toCsv(events: readonly AuditEvent[]): string {
  const rows = events.map((event) => [
    event.id,
    event.at,
    event.workspaceId,
    event.actorId,
    event.action,
    categoryOf(event.action) ?? "",
    event.targetType,
    event.targetId,
    event.targetName ?? "",
    event.ip ?? "",
  ]);
  return matrixToCsv([...CSV_COLUMNS], rows);
}

/**
 * Copy an event for a viewer, dropping the sensitive `ip` and `meta` fields
 * when they are not an admin. The original is never mutated; a non-admin still
 * sees every other field, including `targetName`.
 */
export function redactEvent(event: AuditEvent, isAdmin = false): AuditEvent {
  if (isAdmin) return { ...event };
  const base: AuditEvent = {
    id: event.id,
    workspaceId: event.workspaceId,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    at: event.at,
  };
  return event.targetName === undefined ? base : { ...base, targetName: event.targetName };
}
