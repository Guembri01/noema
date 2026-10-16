/**
 * Adapter between the Prisma `Activity` row the workspace actually records
 * (`src/lib/activity.ts` → `logActivity`) and the richer `AuditEvent` row the
 * audit engine consumes (`src/lib/audit-log-engine.ts`).
 *
 * The engine deliberately uses an `action`/`targetType`/`targetId`/`at`
 * vocabulary that is *almost* the `Activity` model: the model's `actorId` and
 * `targetId` are nullable and it has no `targetName`/`ip` columns, so every
 * mapping here is a lossless projection the other way too.
 *
 * This module is the single door from a database row into the engine: pure, no
 * prisma, no React and no ambient clock, so the mapping is unit-testable and
 * the same projection is shared by the page, the CSV export and their tests.
 */

import { SYSTEM_ACTOR_ID, type AuditEvent } from "@/lib/audit-log-engine";

/** The subset of a Prisma `Activity` row this adapter reads. */
export type ActivityRecord = {
  readonly id: string;
  readonly workspaceId: string;
  /** Nullable in the schema; a missing author is recorded as the system actor. */
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  /** Nullable in the schema; a row without a target falls back to its own id. */
  readonly targetId: string | null;
  readonly meta: unknown;
  readonly createdAt: Date | string;
};

/** ISO instant used when a row timestamp cannot be parsed (never expected). */
const EPOCH_ISO = new Date(0).toISOString();

/** A plain (non-array, non-null) object, the only shape `meta` may take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-blank string field of a meta payload, or `null`. */
function metaString(meta: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (meta === null) return null;
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Coerce a row timestamp to an ISO string; unparseable input falls back to epoch 0. */
function asIso(value: Date | string): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? EPOCH_ISO : value.toISOString();
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : EPOCH_ISO;
}

/**
 * Project an {@link ActivityRecord} onto an {@link AuditEvent}.
 *
 * - A null `actorId` becomes {@link SYSTEM_ACTOR_ID} (a scheduled/system write).
 * - A null `targetId` falls back to the row's own id, so an event is never
 *   dropped just because its target is gone.
 * - `targetName` is read from `meta.title` (preferred) or `meta.name`, and `ip`
 *   from `meta.ip`; both are also left in `meta` as the raw payload.
 * - A non-object `meta` is dropped rather than failing the row.
 *
 * Never throws; the row is not mutated.
 */
export function activityToAuditEvent(record: ActivityRecord): AuditEvent {
  const meta = isPlainObject(record.meta) ? { ...record.meta } : null;
  const targetName = metaString(meta, "title") ?? metaString(meta, "name");
  const ip = metaString(meta, "ip");

  const event: AuditEvent = {
    id: record.id,
    workspaceId: record.workspaceId,
    actorId: record.actorId ?? SYSTEM_ACTOR_ID,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId ?? record.id,
    at: asIso(record.createdAt),
  };
  const withName: AuditEvent = targetName === null ? event : { ...event, targetName };
  const withIp: AuditEvent = ip === null ? withName : { ...withName, ip };
  return meta === null ? withIp : { ...withIp, meta };
}

/**
 * Project an {@link AuditEvent} back onto the `Activity` row shape. The inverse
 * of {@link activityToAuditEvent} on every engine-visible field:
 * {@link SYSTEM_ACTOR_ID} becomes a null `actorId`, and `targetName` / `ip` are
 * folded back into `meta` (`title` / `ip`) so a round trip recovers them.
 * `meta` keys already present win, and an empty `meta` is recorded as `null`.
 */
export function auditEventToActivityRecord(event: AuditEvent): ActivityRecord {
  const meta: Record<string, unknown> = { ...(event.meta ?? {}) };
  if (event.targetName !== undefined && meta.title === undefined) meta.title = event.targetName;
  if (event.ip !== undefined && meta.ip === undefined) meta.ip = event.ip;

  return {
    id: event.id,
    workspaceId: event.workspaceId,
    actorId: event.actorId === SYSTEM_ACTOR_ID ? null : event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    meta: Object.keys(meta).length > 0 ? meta : null,
    createdAt: event.at,
  };
}

/** Map a batch of database rows onto engine events, order preserved. */
export function mapActivityRecords(records: readonly ActivityRecord[]): AuditEvent[] {
  return records.map(activityToAuditEvent);
}
