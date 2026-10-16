/**
 * Realtime collaboration transport engine — the pure, headless half of
 * docs/specs/realtime-collab.md §7 ("Real-time multiplayer editing",
 * "CRDT data model", "Presence", "Live cursors").
 *
 * A collaboration session is a stream of small, self-describing operations
 * tagged with a Lamport clock and an authoring origin, plus an ephemeral
 * presence roster. This module owns every decision that can be proven without
 * a socket, a DOM or a database:
 *
 *  - {@link LamportClock} — a logical clock with `tick`/`compare`/`merge` so
 *    causally ordered events sort identically on every replica;
 *  - {@link encodeOp} / {@link decodeOp} — a compact, versioned wire frame that
 *    round-trips an op and preserves unknown fields from a newer producer, so
 *    an older client can relay a newer client's op without understanding it;
 *  - the {@link PresenceState} reducer — `join` / `leave` / `heartbeat` /
 *    `sweepStale` / `moveCursor`, with a deterministic per-user caret colour
 *    ({@link assignColor} from `./presence`);
 *  - {@link applyRemote} — per-origin ordering, dedupe by op id, and a
 *    rebase-vs-drop rule for an op that arrives behind its origin's
 *    high-water mark;
 *  - {@link snapshot} / {@link restore} — canonical, defensive persistence of
 *    the whole session state;
 *  - {@link connectionPlan} and {@link describePresence} — the fan-out of
 *    subscribers across a document's rooms and a human summary of the roster.
 *
 * This deliberately builds on — and never modifies — the existing
 * `src/lib/presence.ts` and `src/lib/crdt-doc.ts` primitives. Everything is
 * immutable: no function mutates its arguments and each returns fresh objects
 * so a React store can compare identities.
 */

import { assignColor } from "./presence";

/** Wire-format version stamped on every encoded op frame. */
export const WIRE_VERSION = 1;

/**
 * Awareness states older than this are considered dropped peers. Matches the
 * client-side stale-peer GC window the editor uses (R9.20).
 */
export const DEFAULT_PRESENCE_TTL_MS = 45_000;

/* ------------------------------------------------------------------ clock */

/** A Lamport clock owned by one actor. */
export type LamportClock = {
  /** The client/user that owns the local ticks. */
  actor: string;
  /** Highest logical time observed locally. */
  time: number;
};

/** Coerce arbitrary input into a usable, non-negative clock. */
function coerceClock(clock: unknown): LamportClock {
  const record = isRecord(clock) ? clock : {};
  const actor = typeof record.actor === "string" ? record.actor : "";
  const time =
    typeof record.time === "number" && Number.isFinite(record.time)
      ? Math.max(0, Math.trunc(record.time))
      : 0;
  return { actor, time };
}

/** A fresh clock for `actor` at `time` (non-negative integer, default `0`). */
export function createClock(actor: string, time = 0): LamportClock {
  return coerceClock({ actor, time });
}

/** Advance the local time by one, keeping the actor. Returns a fresh clock. */
export function tick(clock: LamportClock): LamportClock {
  const base = coerceClock(clock);
  return { actor: base.actor, time: base.time + 1 };
}

/**
 * Total, deterministic order on clocks: time first, then actor ascending.
 * `-1` when `a` precedes `b`, `1` when it follows, `0` when identical.
 */
export function compare(a: LamportClock, b: LamportClock): number {
  const left = coerceClock(a);
  const right = coerceClock(b);
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.actor === right.actor) return 0;
  return left.actor < right.actor ? -1 : 1;
}

/**
 * The Lamport *receive* rule: observe `b` from `a` and return `a`'s clock
 * advanced strictly past both. The merged clock keeps `a`'s actor, so the next
 * local {@link tick} stays monotonic relative to everything observed.
 */
export function merge(a: LamportClock, b: LamportClock): LamportClock {
  const left = coerceClock(a);
  const right = coerceClock(b);
  return { actor: left.actor, time: Math.max(left.time, right.time) + 1 };
}

/* -------------------------------------------------------------------- ops */

/** An op is either a value write or a delete (tombstone). */
export type OpKind = "set" | "delete";

/**
 * One transport op. The first five fields are the known wire contract; `extra`
 * holds fields a newer producer added, kept verbatim so a re-encode is
 * lossless (forward compatibility).
 */
export type WireOp = {
  /** Stable op id; also the dedupe key. */
  id: string;
  /** The authoring origin (client/user id). */
  origin: string;
  /** Author-assigned Lamport time. */
  clock: number;
  /** `set` carries `payload`; `delete` tombstones. */
  kind: OpKind;
  /** Op content for `kind === "set"`; `null` otherwise. */
  payload: unknown;
  /** Unknown wire fields from a newer producer, preserved verbatim. */
  extra?: Readonly<Record<string, unknown>>;
};

/** Short keys used on the wire, in canonical order. */
const WIRE_KNOWN_KEYS = ["v", "id", "o", "c", "k", "p"] as const;

/**
 * Encode an op to its compact, versioned wire frame. Known fields use short
 * keys (`v`/`id`/`o`/`c`/`k`/`p`) and `payload` is omitted when `undefined`, so
 * a frame stays small. Fields carried in `extra` are written back at the top
 * level, so `encodeOp(decodeOp(encodeOp(op))) === encodeOp(op)`.
 */
export function encodeOp(op: WireOp): string {
  const frame: Record<string, unknown> = {
    v: WIRE_VERSION,
    id: op.id,
    o: op.origin,
    c: op.clock,
    k: op.kind,
  };
  if (op.payload !== undefined) frame.p = op.payload;
  if (op.extra) {
    for (const [key, value] of Object.entries(op.extra)) {
      if (!WIRE_KNOWN_KEYS.includes(key as (typeof WIRE_KNOWN_KEYS)[number])) frame[key] = value;
    }
  }
  return JSON.stringify(frame);
}

/**
 * Decode a wire frame back into an op. Returns `null` for anything unusable
 * (malformed JSON, a non-object, a missing/blank id/origin, a non-finite clock
 * or an unknown `kind`) so a corrupt frame can never throw or poison state.
 * Unknown top-level fields are collected into `extra` and survive a re-encode.
 */
export function decodeOp(text: string | null | undefined): WireOp | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const version = parsed.v;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) return null;
  if (parsed.k !== "set" && parsed.k !== "delete") return null;

  const op = coerceOp({
    id: parsed.id,
    origin: parsed.o,
    clock: parsed.c,
    kind: parsed.k,
    payload: parsed.p,
  });
  if (op === null) return null;
  const extra = extraFields(parsed);
  if (Object.keys(extra).length > 0) op.extra = extra;
  return op;
}

/** Rebuild the non-reserved top-level fields of a decoded frame as an object. */
function extraFields(frame: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (!WIRE_KNOWN_KEYS.includes(key as (typeof WIRE_KNOWN_KEYS)[number])) extra[key] = value;
  }
  return extra;
}

/** Coerce untrusted op-like input into a {@link WireOp}, or `null` if unusable. */
function coerceOp(raw: unknown): WireOp | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const origin = typeof raw.origin === "string" ? raw.origin.trim() : "";
  const clock = normalizeClockValue(raw.clock);
  if (id === "" || origin === "" || clock === null) return null;
  const op: WireOp = {
    id,
    origin,
    clock,
    kind: raw.kind === "delete" ? "delete" : "set",
    payload: raw.payload ?? null,
  };
  if (isRecord(raw.extra) && Object.keys(raw.extra).length > 0) op.extra = { ...raw.extra };
  return op;
}

/* --------------------------------------------------------------- presence */

/** A collaborator's caret, in document positions, with its resolved colour. */
export type PresenceCursor = { anchor: number; head: number; color: string };

/** One live collaborator in the presence roster. */
export type PresenceUser = {
  id: string;
  name: string;
  /** Deterministic palette colour (an explicit override wins). */
  color: string;
  /** Epoch milliseconds of the first join. */
  joinedAt: number;
  /** Epoch milliseconds of the last heartbeat. */
  lastSeen: number;
  /** Present once the user has published a cursor position. */
  cursor?: PresenceCursor;
};

/** Cumulative counters for {@link applyRemote}. */
export type PresenceStats = {
  /** Ops applied in order (including rebased ones). */
  applied: number;
  /** Unseen ops whose clock arrived behind the origin high-water mark. */
  rebased: number;
  /** Duplicate op ids. */
  dropped: number;
};

/**
 * The full session state: the local identity, the Lamport clock, the presence
 * roster, and the applied-op log plus per-origin ordering.
 */
export type PresenceState = {
  /** The local user id, or `null` before anyone joins. */
  selfId: string | null;
  /** The local Lamport clock. */
  clock: LamportClock;
  /** Participants by id. */
  participants: Readonly<Record<string, PresenceUser>>;
  /** Applied ops by id (a rebased op keeps its id but carries the new clock). */
  ops: Readonly<Record<string, WireOp>>;
  /** Per-origin high-water mark: the highest applied clock per origin. */
  order: Readonly<Record<string, number>>;
  /** Cumulative apply counters. */
  stats: PresenceStats;
};

/** A fresh, empty session state. */
export function createPresence(actor = ""): PresenceState {
  return {
    selfId: null,
    clock: createClock(actor),
    participants: {},
    ops: {},
    order: {},
    stats: { applied: 0, rebased: 0, dropped: 0 },
  };
}

/** Defensively rebuild a session state from untrusted input. */
function normalizeState(state: unknown): PresenceState {
  if (!isRecord(state)) return createPresence();

  const participants: Record<string, PresenceUser> = {};
  if (isRecord(state.participants)) {
    for (const [key, raw] of Object.entries(state.participants)) {
      const user = coerceUser(key, raw);
      if (user !== null) participants[user.id] = user;
    }
  }

  const ops: Record<string, WireOp> = {};
  if (isRecord(state.ops)) {
    for (const raw of Object.values(state.ops)) {
      const op = coerceOp(raw);
      if (op !== null) ops[op.id] = op;
    }
  }

  const order: Record<string, number> = {};
  if (isRecord(state.order)) {
    for (const [key, raw] of Object.entries(state.order)) {
      const clock = normalizeClockValue(raw);
      if (key !== "" && clock !== null) order[key] = clock;
    }
  }

  return {
    selfId: typeof state.selfId === "string" && state.selfId !== "" ? state.selfId : null,
    clock: coerceClock(state.clock),
    participants,
    ops,
    order,
    stats: coerceStats(state.stats),
  };
}

/** Rebuild one participant from untrusted input, or `null` if unusable. */
function coerceUser(id: string, raw: unknown): PresenceUser | null {
  if (!isRecord(raw)) return null;
  const userId = typeof raw.id === "string" && raw.id !== "" ? raw.id : id;
  if (userId === "") return null;
  const user: PresenceUser = {
    id: userId,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : userId,
    color: typeof raw.color === "string" && raw.color !== "" ? raw.color : assignColor(userId),
    joinedAt: toTime(raw.joinedAt),
    lastSeen: toTime(raw.lastSeen),
  };
  const cursor = coerceCursor(raw.cursor, user.color);
  if (cursor !== null) user.cursor = cursor;
  return user;
}

/** Rebuild a cursor from untrusted input, or `null` when absent/unusable. */
function coerceCursor(raw: unknown, fallbackColor: string): PresenceCursor | null {
  if (!isRecord(raw)) return null;
  const span = normalizeSpan(raw.anchor, raw.head);
  const color = typeof raw.color === "string" && raw.color !== "" ? raw.color : fallbackColor;
  return { anchor: span.anchor, head: span.head, color };
}

/** Coerce the three apply counters. */
function coerceStats(raw: unknown): PresenceStats {
  const record = isRecord(raw) ? raw : {};
  return {
    applied: toCount(record.applied),
    rebased: toCount(record.rebased),
    dropped: toCount(record.dropped),
  };
}

/** Options for {@link join} and {@link heartbeat}. */
export type JoinOptions = { now?: number };

/**
 * Add or refresh a participant. The colour is the explicit `color` when given,
 * otherwise the user's deterministic {@link assignColor}. The first join claims
 * `selfId`; a rejoin keeps its original `joinedAt` and refreshes `lastSeen`. A
 * blank id is ignored but still returns a fresh state.
 */
export function join(
  state: PresenceState,
  user: { id: string; name?: string; color?: string },
  options: JoinOptions = {},
): PresenceState {
  const base = normalizeState(state);
  const id = typeof user?.id === "string" ? user.id.trim() : "";
  if (id === "") return { ...base, participants: { ...base.participants } };

  const now = toTime(options.now);
  const existing = base.participants[id];
  const name = typeof user.name === "string" && user.name.trim() !== "" ? user.name : (existing?.name ?? id);
  const color =
    typeof user.color === "string" && user.color.trim() !== "" ? user.color : (existing?.color ?? assignColor(id));

  const participant: PresenceUser = {
    id,
    name,
    color,
    joinedAt: existing?.joinedAt ?? now,
    lastSeen: now,
  };
  if (existing?.cursor) participant.cursor = { ...existing.cursor };

  return {
    ...base,
    selfId: base.selfId ?? id,
    clock: base.clock.actor === "" ? createClock(id, base.clock.time) : base.clock,
    participants: { ...base.participants, [id]: participant },
  };
}

/** Remove a participant. Leaving the local user clears `selfId`. */
export function leave(state: PresenceState, userId: string): PresenceState {
  const base = normalizeState(state);
  const id = typeof userId === "string" ? userId.trim() : "";
  const participants = { ...base.participants };
  delete participants[id];
  return { ...base, participants, selfId: base.selfId === id ? null : base.selfId };
}

/** Refresh a participant's `lastSeen`. Unknown ids are a no-op copy. */
export function heartbeat(
  state: PresenceState,
  userId: string,
  options: JoinOptions = {},
): PresenceState {
  const base = normalizeState(state);
  const id = typeof userId === "string" ? userId.trim() : "";
  const existing = base.participants[id];
  if (existing === undefined) return { ...base, participants: { ...base.participants } };

  const next: PresenceUser = { ...existing, lastSeen: toTime(options.now) };
  if (existing.cursor) next.cursor = { ...existing.cursor };
  return { ...base, participants: { ...base.participants, [id]: next } };
}

/**
 * Drop participants idle for longer than `ttlMs`. A participant exactly at the
 * boundary still counts as present. A non-finite `now`/`ttlMs` keeps everyone
 * (fail-safe: never evict on a bad clock).
 */
export function sweepStale(state: PresenceState, now: number, ttlMs: number): PresenceState {
  const base = normalizeState(state);
  const failSafe = !Number.isFinite(now) || !Number.isFinite(ttlMs);
  const participants: Record<string, PresenceUser> = {};
  for (const [id, user] of Object.entries(base.participants)) {
    if (failSafe || now - user.lastSeen <= ttlMs) participants[id] = user;
  }
  return { ...base, participants };
}

/**
 * Publish a cursor for a known participant. Endpoints are truncated to
 * integers and ordered (`anchor <= head`); the colour is an explicit override
 * or the user id's deterministic palette colour. Unknown users are a no-op.
 */
export function moveCursor(
  state: PresenceState,
  userId: string,
  cursor: { anchor: number; head: number; color?: string },
): PresenceState {
  const base = normalizeState(state);
  const id = typeof userId === "string" ? userId.trim() : "";
  const existing = base.participants[id];
  if (existing === undefined) return { ...base, participants: { ...base.participants } };

  const span = normalizeSpan(cursor?.anchor, cursor?.head);
  const color =
    typeof cursor?.color === "string" && cursor.color.trim() !== "" ? cursor.color : assignColor(id);
  const next: PresenceUser = { ...existing, cursor: { anchor: span.anchor, head: span.head, color } };
  return { ...base, participants: { ...base.participants, [id]: next } };
}

/** Options for {@link applyRemote}: the peer the batch arrived from. */
export type ApplyRemoteOptions = { origin?: string };

/**
 * Apply a batch of remote ops.
 *
 * Ops are first ordered by `(origin, clock, id)` so arrival order never matters
 * and per-origin sequences apply in causal order. Each op is then deduped by
 * id, and its clock is resolved against its origin's high-water mark:
 *
 *  - ahead of the mark → applied as-is;
 *  - behind the mark but unseen → **rebased** to `highWater + 1` and applied,
 *    so a late but genuinely new op is not silently lost;
 *  - already applied (duplicate id) → **dropped**.
 *
 * The local Lamport time advances to the highest effective clock, and the
 * counters accumulate. The input state and op array are never mutated.
 */
export function applyRemote(
  state: PresenceState,
  ops: readonly WireOp[],
  options: ApplyRemoteOptions = {},
): PresenceState {
  const base = normalizeState(state);

  const list: WireOp[] = [];
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = coerceOp(raw);
    if (op !== null) list.push(op);
  }
  list.sort((a, b) => {
    if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
    if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  const appliedOps: Record<string, WireOp> = { ...base.ops };
  const order: Record<string, number> = { ...base.order };
  let applied = base.stats.applied;
  let rebased = base.stats.rebased;
  let dropped = base.stats.dropped;
  let time = base.clock.time;

  for (const op of list) {
    if (Object.prototype.hasOwnProperty.call(appliedOps, op.id)) {
      dropped += 1;
      continue;
    }
    const highWater = order[op.origin] ?? 0;
    let effective = op.clock;
    if (op.clock > highWater) {
      applied += 1;
    } else {
      effective = highWater + 1;
      rebased += 1;
    }
    order[op.origin] = effective;
    appliedOps[op.id] = effective === op.clock ? op : { ...op, clock: effective };
    if (effective > time) time = effective;
  }

  const actor =
    base.clock.actor !== "" ? base.clock.actor : (typeof options.origin === "string" ? options.origin : "");

  return {
    ...base,
    clock: { actor, time },
    ops: appliedOps,
    order,
    stats: { applied, rebased, dropped },
  };
}

/* ------------------------------------------------------ snapshot/restore */

/**
 * Canonical JSON of the whole session. Equal states always serialise to
 * byte-identical text regardless of key insertion order, so it is safe to
 * hash, compare or persist.
 */
export function snapshot(state: PresenceState): string {
  const base = normalizeState(state);
  return stableStringify({
    v: WIRE_VERSION,
    selfId: base.selfId,
    clock: base.clock,
    participants: base.participants,
    ops: base.ops,
    order: base.order,
    stats: base.stats,
  });
}

/**
 * Parse a {@link snapshot} back into a session state. Malformed JSON, a
 * non-object payload or individual corrupt entries degrade to an empty state or
 * dropped entries rather than throwing, so a bad snapshot can never crash a
 * sync.
 */
export function restore(state: string | null | undefined): PresenceState {
  if (typeof state !== "string" || state.trim() === "") return createPresence();
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return createPresence();
  }
  return normalizeState(parsed);
}

/* -------------------------------------------------------- connection plan */

/** One user and the rooms they subscribe to. */
export type ConnectionUser = { id: string; rooms: readonly string[] };

/** Input for {@link connectionPlan}: the users and a document's rooms. */
export type ConnectionPlanInput = {
  users: readonly ConnectionUser[];
  rooms: readonly string[];
};

/** The fan-out of subscribers across a document's rooms. */
export type ConnectionPlan = {
  /** Rooms with at least one subscriber, sorted. */
  rooms: string[];
  /** Candidate rooms nobody subscribes to, sorted. */
  emptyRooms: string[];
  /** Room → sorted unique subscriber ids. */
  subscribers: Record<string, string[]>;
  /** Rooms with two or more subscribers (the ones needing fan-out), sorted. */
  fanOut: string[];
  /** Total distinct user↔room edges. */
  edges: number;
  /** Users subscribing to no candidate room, sorted. */
  idleUsers: string[];
};

/**
 * Compute the room fan-out for a document: which candidate rooms are live,
 * who is in each, the duplicated-subscription count and who is idle. Rooms a
 * user asks for that are not in the document's candidate set are ignored, and
 * duplicate rooms/ids collapse, so the plan is a pure function of the inputs.
 */
export function connectionPlan(input: ConnectionPlanInput): ConnectionPlan {
  const candidateRooms = uniqueStrings(input?.rooms).sort();
  const subscribers = new Map<string, Set<string>>();
  for (const room of candidateRooms) subscribers.set(room, new Set<string>());

  const idle = new Set<string>();
  const edges = new Set<string>();
  for (const user of Array.isArray(input?.users) ? input.users : []) {
    const id = typeof user?.id === "string" ? user.id.trim() : "";
    if (id === "") continue;
    const wanted = uniqueStrings(user?.rooms).filter((room) => subscribers.has(room));
    if (wanted.length === 0) {
      idle.add(id);
      continue;
    }
    for (const room of wanted) {
      subscribers.get(room)?.add(id);
      edges.add(`${room}\u0000${id}`);
    }
  }

  const sortedSubscribers: Record<string, string[]> = {};
  for (const [room, ids] of subscribers) sortedSubscribers[room] = [...ids].sort();

  const activeRooms = candidateRooms.filter((room) => (sortedSubscribers[room]?.length ?? 0) > 0);
  const emptyRooms = candidateRooms.filter((room) => (sortedSubscribers[room]?.length ?? 0) === 0);
  const fanOut = activeRooms.filter((room) => (sortedSubscribers[room]?.length ?? 0) >= 2);

  return {
    rooms: activeRooms,
    emptyRooms,
    subscribers: sortedSubscribers,
    fanOut,
    edges: edges.size,
    idleUsers: [...idle].sort(),
  };
}

/* ------------------------------------------------------------ description */

/** A human-facing summary of the presence roster. */
export type PresenceDescription = {
  /** Number of participants. */
  count: number;
  /** The local user, projected, or `null` when nobody has joined. */
  self: { id: string; name: string; color: string } | null;
  /** Every other participant, sorted by id. */
  others: Array<{ id: string; name: string; color: string; hasCursor: boolean }>;
  /** Ids of everyone with a live cursor, sorted. */
  editing: string[];
  /** e.g. `"2 people viewing"` / `"1 person viewing"` / `"No one viewing"`. */
  label: string;
};

/** Summarise a roster deterministically (participants sorted by id). */
export function describePresence(state: PresenceState): PresenceDescription {
  const base = normalizeState(state);
  const list = Object.values(base.participants).sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const self = base.selfId !== null ? base.participants[base.selfId] : undefined;

  const others = list
    .filter((user) => user.id !== base.selfId)
    .map((user) => ({
      id: user.id,
      name: user.name,
      color: user.color,
      hasCursor: user.cursor !== undefined,
    }));

  const editing = list.filter((user) => user.cursor !== undefined).map((user) => user.id);
  const count = list.length;

  return {
    count,
    self: self === undefined ? null : { id: self.id, name: self.name, color: self.color },
    others,
    editing,
    label: count === 0 ? "No one viewing" : `${count} ${count === 1 ? "person" : "people"} viewing`,
  };
}

/* ---------------------------------------------------------------- helpers */

/** A plain (non-array) object, for defensive shape checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a clock into a non-negative integer, or `null` when unusable. */
function normalizeClockValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

/** Coerce an epoch time into a non-negative integer (default `0`). */
function toTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Coerce a counter into a non-negative integer (default `0`). */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Truncate cursor endpoints to integers and order them `anchor <= head`. */
function normalizeSpan(anchor: unknown, head: unknown): { anchor: number; head: number } {
  const a = toTime(anchor);
  const b = toTime(head);
  return a <= b ? { anchor: a, head: b } : { anchor: b, head: a };
}

/** Unique, trimmed, non-empty strings in first-seen order. */
function uniqueStrings(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Canonical JSON: object keys sorted at every level, `undefined` properties
 * omitted, arrays kept in order. Equal values always stringify identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}
