/**
 * Two-way calendar sync model (§13 Google Calendar sync, Outlook Calendar sync).
 *
 * A pure, DB-free and clock-free planner over two collections of
 * {@link ExternalEvent}: the events known locally and the snapshot returned by a
 * provider (Google Calendar, Outlook Calendar, …). {@link computeSyncPlan}
 * diffs them, using each side's `etag` as the primary change signal and
 * `updatedAt` plus `state.lastSyncAt` to work out *which* side moved and to
 * resolve genuine conflicts **last-writer-wins with provenance**.
 *
 * Everything here is deterministic: the same inputs always produce a
 * byte-identical plan, no function reads the clock or the network, and no input
 * is ever mutated. Timestamps are compared as instants (`Date.parse`), not as
 * raw strings, so field order never leaks into results.
 *
 * Direction model: `push` treats the local set as authority (mirror local onto
 * remote), `pull` treats the remote set as authority, and `both` reconciles the
 * two — surfacing conflicts only in that two-way mode, because a one-way sync
 * already has an unambiguous winner.
 */

import { escapeText, foldLine } from "@/lib/ics";

/** Which side of the sync is authoritative. */
export type SyncDirection = "push" | "pull" | "both";

/** Per-calendar bookkeeping the planner reads (`lastSyncAt`) and carries. */
export type SyncState = {
  calendarId: string;
  /** Opaque incremental token from the provider — carried, not interpreted. */
  syncToken?: string;
  /** Opaque collection ETag from the provider — carried, not interpreted. */
  etag?: string;
  /** ISO-8601 instant of the previous successful sync (the change baseline). */
  lastSyncAt: string;
  direction: SyncDirection;
};

/**
 * Recurrence metadata for an external event.
 *
 * `rrule` is a raw RFC 5545 rule body without the `RRULE:` prefix (for example
 * `"FREQ=WEEKLY;BYDAY=MO"`); `exdate` holds the RFC 5545 exception stamps
 * (`YYYYMMDDTHHMMSSZ`) that {@link mergeRecurrence} keeps sorted and unique.
 */
export type Recurrence = {
  rrule?: string;
  exdate?: string[];
};

/**
 * One event as seen by a provider or by the local store. `etag` is the
 * provider's change token and `updatedAt` the last-modification instant; both
 * drive change detection. All instants are ISO-8601 UTC strings.
 */
export type ExternalEvent = {
  id: string;
  etag: string;
  updatedAt: string;
  summary: string;
  start: string;
  end: string;
  recurrence?: Recurrence;
  allDay: boolean;
};

/** The three write operations a plan can carry. */
export type SyncOpKind = "create" | "update" | "delete";

/** One write to replay against the local or remote collection. */
export type SyncOp = {
  op: SyncOpKind;
  eventId: string;
  /** The event to write; `null` for a `delete`. */
  payload: ExternalEvent | null;
};

/** The side whose version won a conflict. */
export type ConflictWinner = "local" | "remote";

/** Why and when a conflict was decided. */
export type ConflictResolution = {
  winner: ConflictWinner;
  /** `newer-updatedAt` when one side is strictly newer, else the tie-break. */
  reason: "newer-updatedAt" | "tie-break";
  /** The `updatedAt` that decided the winner (both equal on a tie-break). */
  decidedAt: string;
};

/** A divergent event found on both sides, with the resolution to apply. */
export type SyncConflict = {
  eventId: string;
  local: ExternalEvent;
  remote: ExternalEvent;
  resolution: ConflictResolution;
};

/** The full reconciliation: writes to push, writes to pull, and conflicts. */
export type SyncPlan = {
  push: SyncOp[];
  pull: SyncOp[];
  conflicts: SyncConflict[];
};

export type ComputeSyncPlanInput = {
  local: readonly ExternalEvent[];
  remote: readonly ExternalEvent[];
  state: SyncState;
};

const byId = (events: readonly ExternalEvent[]): Map<string, ExternalEvent> => {
  const map = new Map<string, ExternalEvent>();
  for (const event of events) map.set(event.id, event);
  return map;
};

/** Every id seen on either side, ordered for deterministic plans. */
const unionIds = (...maps: Map<string, ExternalEvent>[]): string[] => {
  const ids = new Set<string>();
  for (const map of maps) for (const id of map.keys()) ids.add(id);
  return [...ids].sort((a, b) => a.localeCompare(b));
};

const op = (
  kind: SyncOpKind,
  eventId: string,
  payload: ExternalEvent | null = null,
): SyncOp => ({ op: kind, eventId, payload });

const timeOf = (event: ExternalEvent): number => Date.parse(event.updatedAt);

/** `true` when `event` was modified strictly after the last-sync baseline. */
const changedSince = (event: ExternalEvent, baseline: string): boolean => {
  const at = timeOf(event);
  const since = Date.parse(baseline);
  return Number.isFinite(at) && Number.isFinite(since) && at > since;
};

/** Last-writer-wins; an exact timestamp tie resolves to the remote side. */
function resolveConflict(local: ExternalEvent, remote: ExternalEvent): ConflictResolution {
  const localAt = timeOf(local);
  const remoteAt = timeOf(remote);
  if (localAt > remoteAt) {
    return { winner: "local", reason: "newer-updatedAt", decidedAt: local.updatedAt };
  }
  if (remoteAt > localAt) {
    return { winner: "remote", reason: "newer-updatedAt", decidedAt: remote.updatedAt };
  }
  return { winner: "remote", reason: "tie-break", decidedAt: remote.updatedAt };
}

/** Push-mode mirror: make the remote collection look like the local one. */
function mirror(local: Map<string, ExternalEvent>, remote: Map<string, ExternalEvent>, ids: string[]): SyncOp[] {
  const ops: SyncOp[] = [];
  for (const id of ids) {
    const l = local.get(id);
    const r = remote.get(id);
    if (l && !r) ops.push(op("create", id, l));
    else if (l && r && l.etag !== r.etag) ops.push(op("update", id, l));
    else if (!l && r) ops.push(op("delete", id));
  }
  return ops;
}

/**
 * Diff the local and remote collections into a {@link SyncPlan}.
 *
 * In `push`/`pull` mode the named side is authoritative and the other is
 * mirrored onto it; no conflicts are possible. In `both` mode each event is
 * reconciled: equal etags are a no-op, a single moved side becomes a push or
 * pull update, and both sides moving (or an unexplained divergence that
 * predates the baseline) becomes an LWW conflict whose winner is written back
 * through the appropriate op list.
 *
 * A present/absent pair is read through the baseline: an event newer than
 * `state.lastSyncAt` was created on its side, an older one was deleted on the
 * missing side. Operation lists are ordered by `eventId`, so equal inputs always
 * yield a byte-identical plan.
 */
export function computeSyncPlan(input: ComputeSyncPlanInput): SyncPlan {
  const local = byId(input.local);
  const remote = byId(input.remote);
  const ids = unionIds(local, remote);
  const { direction, lastSyncAt } = input.state;

  if (direction === "push") {
    return { push: mirror(local, remote, ids), pull: [], conflicts: [] };
  }
  if (direction === "pull") {
    return { push: [], pull: mirror(remote, local, ids), conflicts: [] };
  }

  const push: SyncOp[] = [];
  const pull: SyncOp[] = [];
  const conflicts: SyncConflict[] = [];

  const recordConflict = (localEvent: ExternalEvent, remoteEvent: ExternalEvent): void => {
    const resolution = resolveConflict(localEvent, remoteEvent);
    if (resolution.winner === "local") push.push(op("update", localEvent.id, localEvent));
    else pull.push(op("update", remoteEvent.id, remoteEvent));
    conflicts.push({ eventId: localEvent.id, local: localEvent, remote: remoteEvent, resolution });
  };

  for (const id of ids) {
    const l = local.get(id);
    const r = remote.get(id);
    if (l && r) {
      if (l.etag === r.etag) continue;
      const localMoved = changedSince(l, lastSyncAt);
      const remoteMoved = changedSince(r, lastSyncAt);
      if (localMoved && remoteMoved) {
        recordConflict(l, r);
      } else if (localMoved) {
        push.push(op("update", id, l));
      } else if (remoteMoved) {
        pull.push(op("update", id, r));
      } else {
        // Etags differ, yet neither side is newer than the baseline: a
        // pre-baseline divergence. Resolve it LWW like any other conflict.
        recordConflict(l, r);
      }
    } else if (l) {
      if (changedSince(l, lastSyncAt)) push.push(op("create", id, l));
      else pull.push(op("delete", id));
    } else if (r) {
      if (changedSince(r, lastSyncAt)) pull.push(op("create", id, r));
      else push.push(op("delete", id));
    }
  }

  return { push, pull, conflicts };
}

/**
 * Replay a list of operations against a set of events, returning a fresh,
 * id-sorted array. `create`/`update` insert or replace by id; `delete` removes.
 * The input array and its events are never mutated.
 */
export function applySyncOps(
  events: readonly ExternalEvent[],
  ops: readonly SyncOp[],
): ExternalEvent[] {
  const map = byId(events);
  for (const operation of ops) {
    if (operation.op === "delete") map.delete(operation.eventId);
    else if (operation.payload) map.set(operation.eventId, operation.payload);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Apply a plan's push operations to the remote set, returning the new set. */
export function applyPush(events: readonly ExternalEvent[], plan: SyncPlan): ExternalEvent[] {
  return applySyncOps(events, plan.push);
}

/** Apply a plan's pull operations to the local set, returning the new set. */
export function applyPull(events: readonly ExternalEvent[], plan: SyncPlan): ExternalEvent[] {
  return applySyncOps(events, plan.pull);
}

/**
 * Union two recurrence definitions.
 *
 * The incoming `rrule` supersedes the existing one when present (the newest
 * edit wins), while the `exdate` lists are unioned, de-duplicated and sorted so
 * the result is deterministic. Returns `undefined` when neither side recurs, and
 * omits `exdate` when there are no exceptions.
 */
export function mergeRecurrence(
  existing: Recurrence | undefined,
  incoming: Recurrence | undefined,
): Recurrence | undefined {
  if (!existing && !incoming) return undefined;

  const merged: Recurrence = {};
  const rrule = incoming?.rrule ?? existing?.rrule;
  if (rrule) merged.rrule = rrule;

  const exdate: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(existing?.exdate ?? []), ...(incoming?.exdate ?? [])]) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    exdate.push(value);
  }
  if (exdate.length > 0) merged.exdate = exdate.sort();

  return merged;
}

// ---------------------------------------------------------------------------
// Minimal ICS (RFC 5545) VEVENT serialise/parse round-trip. Escaping and octet
// folding reuse the shared helpers in `@/lib/ics`; parsing mirrors them so a
// well-formed event survives `fromIcsEvent(toIcsEvent(event))` unchanged.
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const pad = (value: number): string => String(value).padStart(2, "0");

/** RFC 5545 DATE / DATE-TIME value for an ISO instant. */
function icsDate(iso: string, allDay: boolean): string {
  const date = new Date(iso);
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  if (allDay) return day;
  return (
    day +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Parse an RFC 5545 DATE / DATE-TIME value back to an ISO-8601 UTC instant. */
function parseIcsDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    if (!year || !month || !day) return null;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(trimmed);
  if (!match) return null;
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ),
  ).toISOString();
}

/** Unfold RFC 5545 continuation lines (leading space or tab). */
function unfold(input: string): string[] {
  const lines: string[] = [];
  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

type IcsField = { value: string; params: Record<string, string> };

/** Split `NAME;PARAM=VALUE:value`; returns `null` for a line without a colon. */
function parseIcsLine(line: string): { name: string; field: IcsField } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), field: { value: line.slice(colon + 1), params } };
}

/** Reverse {@link escapeText} without trimming (so round-trips stay exact). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseRecurrence(fields: Map<string, IcsField>): Recurrence | undefined {
  const rrule = fields.get("RRULE")?.value.trim();
  const rawExdate = fields.get("EXDATE")?.value;
  const exdate = rawExdate
    ? rawExdate
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    : [];
  if (!rrule && exdate.length === 0) return undefined;
  const recurrence: Recurrence = {};
  if (rrule) recurrence.rrule = rrule;
  if (exdate.length > 0) recurrence.exdate = exdate;
  return recurrence;
}

/** Collect the first VEVENT's fields, whether bare or inside a VCALENDAR. */
function collectVeventFields(input: string): Map<string, IcsField> | null {
  const fields = new Map<string, IcsField>();
  let inside = false;
  for (const line of unfold(input)) {
    const parsed = parseIcsLine(line);
    if (!parsed) continue;
    if (parsed.name === "BEGIN" && parsed.field.value.trim().toUpperCase() === "VEVENT") {
      inside = true;
      fields.clear();
      continue;
    }
    if (parsed.name === "END" && parsed.field.value.trim().toUpperCase() === "VEVENT") {
      return inside ? fields : null;
    }
    if (inside) fields.set(parsed.name, parsed.field);
  }
  return null;
}

/**
 * Serialise one event as a minimal folded VEVENT block. The mapping is
 * `id → UID`, `summary → SUMMARY`, `start/end → DTSTART/DTEND` (all-day uses
 * `VALUE=DATE`), `etag → X-ETAG`, `updatedAt → LAST-MODIFIED`/`DTSTAMP`, and
 * `recurrence → RRULE`/`EXDATE`. The clock is never read: `DTSTAMP` is derived
 * from `updatedAt`, so output is deterministic. Lines are CRLF-terminated.
 */
export function toIcsEvent(event: ExternalEvent): string {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${event.id}`];
  lines.push(
    event.allDay
      ? `DTSTART;VALUE=DATE:${icsDate(event.start, true)}`
      : `DTSTART:${icsDate(event.start, false)}`,
  );
  lines.push(
    event.allDay
      ? `DTEND;VALUE=DATE:${icsDate(event.end, true)}`
      : `DTEND:${icsDate(event.end, false)}`,
  );
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.etag) lines.push(`X-ETAG:${escapeText(event.etag)}`);
  lines.push(`LAST-MODIFIED:${icsDate(event.updatedAt, false)}`);
  lines.push(`DTSTAMP:${icsDate(event.updatedAt, false)}`);
  if (event.recurrence?.rrule) lines.push(`RRULE:${event.recurrence.rrule}`);
  const exdate = event.recurrence?.exdate ?? [];
  if (exdate.length > 0) lines.push(`EXDATE:${exdate.join(",")}`);
  lines.push("END:VEVENT");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/**
 * Parse one VEVENT (bare or inside a VCALENDAR) back into an
 * {@link ExternalEvent}. Requires a `UID` and a parseable `DTSTART`; a missing
 * `DTEND` collapses to `start`, a missing `LAST-MODIFIED`/`DTSTAMP` to `start`,
 * and a missing `X-ETAG` to `""`. Returns `null` when no usable VEVENT is found.
 */
export function fromIcsEvent(vevent: string): ExternalEvent | null {
  const fields = collectVeventFields(vevent);
  if (!fields) return null;

  const id = fields.get("UID")?.value.trim();
  const dtstart = fields.get("DTSTART");
  if (!id || !dtstart) return null;

  const allDay = dtstart.params.VALUE === "DATE" || /^\d{8}$/.test(dtstart.value.trim());
  const start = parseIcsDate(dtstart.value);
  if (!start) return null;

  const dtend = fields.get("DTEND");
  const end = dtend ? parseIcsDate(dtend.value) : start;
  if (!end) return null;

  const updatedAt =
    parseIcsDate(fields.get("LAST-MODIFIED")?.value ?? "") ??
    parseIcsDate(fields.get("DTSTAMP")?.value ?? "") ??
    start;

  const event: ExternalEvent = {
    id,
    etag: unescapeText(fields.get("X-ETAG")?.value ?? ""),
    updatedAt,
    summary: unescapeText(fields.get("SUMMARY")?.value ?? ""),
    start,
    end,
    allDay,
  };
  const recurrence = parseRecurrence(fields);
  if (recurrence) event.recurrence = recurrence;
  return event;
}

// ---------------------------------------------------------------------------
// Plan rendering + token.
// ---------------------------------------------------------------------------

/**
 * Human-readable, deterministic summary of a plan, e.g.
 * `"push: 2 (1 create, 1 update); pull: 1 (1 delete); conflicts: 1 (1 remote wins)"`.
 * An empty plan renders as `"no changes"`.
 */
export function describeSyncPlan(plan: SyncPlan): string {
  const parts: string[] = [];

  const describeOps = (label: string, ops: readonly SyncOp[]): void => {
    if (ops.length === 0) return;
    const counts: Record<SyncOpKind, number> = { create: 0, update: 0, delete: 0 };
    for (const operation of ops) counts[operation.op] += 1;
    const detail = (["create", "update", "delete"] as const)
      .filter((kind) => counts[kind] > 0)
      .map((kind) => `${counts[kind]} ${kind}`)
      .join(", ");
    parts.push(`${label}: ${ops.length} (${detail})`);
  };

  describeOps("push", plan.push);
  describeOps("pull", plan.pull);

  if (plan.conflicts.length > 0) {
    const remoteWins = plan.conflicts.filter((c) => c.resolution.winner === "remote").length;
    const detail = [
      plan.conflicts.length - remoteWins > 0
        ? `${plan.conflicts.length - remoteWins} local wins`
        : "",
      remoteWins > 0 ? `${remoteWins} remote wins` : "",
    ]
      .filter((entry) => entry !== "")
      .join(", ");
    parts.push(`conflicts: ${plan.conflicts.length} (${detail})`);
  }

  return parts.length > 0 ? parts.join("; ") : "no changes";
}

/** FNV-1a (32-bit) over a string, rendered as eight lowercase hex digits. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive the next opaque sync token from a plan. Equal plans always produce the
 * same token (so an unchanged calendar short-circuits), while any change to an
 * operation or conflict — including a payload's `etag`/`updatedAt` — yields a
 * different one. The format is stable: `sync-` followed by eight hex digits.
 */
export function nextSyncToken(plan: SyncPlan): string {
  const fingerprint = JSON.stringify([
    plan.push.map((o) => [o.op, o.eventId, o.payload?.etag ?? "", o.payload?.updatedAt ?? ""]),
    plan.pull.map((o) => [o.op, o.eventId, o.payload?.etag ?? "", o.payload?.updatedAt ?? ""]),
    plan.conflicts.map((c) => [
      c.eventId,
      c.resolution.winner,
      c.resolution.reason,
      c.resolution.decidedAt,
    ]),
  ]);
  return `sync-${fnv1a(fingerprint)}`;
}
