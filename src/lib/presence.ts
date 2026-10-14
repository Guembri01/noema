/**
 * Presence & live cursors (F4) — the pure, deterministic core.
 *
 * A collaboration room is a list of `Participant`s: who is here, since when,
 * what caret colour they carry, and where their cursor sits. This module owns
 * every decision that must be provable without a socket or a DOM — upserting a
 * participant from a heartbeat, evicting the idle, hashing an id to a stable
 * colour, clamping a remote caret to the local document, and labelling a
 * cursor. Nothing here touches the network, React or the DB; a real-time
 * transport just feeds these functions whatever it receives.
 *
 * Everything is immutable: no function mutates its arguments, and each returns
 * fresh arrays/objects so a React store can compare identities.
 */

/** A collaborator's caret, in document positions. */
export type Cursor = { anchor: number; head: number };

/** One live collaborator. `color` is optional (assignColor fills the gap). */
export type Participant = {
  id: string;
  name: string;
  color?: string;
  /** Epoch milliseconds of the last heartbeat. */
  lastSeen: number;
  cursor?: Cursor;
};

/**
 * The fixed caret palette, in assignment order — same Notion-style tint names
 * the rest of the app stores (`ROW_COLOR_PALETTE` in `@/lib/row-color-rules`),
 * so a cursor chip and a coloured row speak one colour language. Names, not
 * hex: CSS owns the values and a dark theme can remap them.
 */
export const PRESENCE_PALETTE = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type PresenceColor = (typeof PRESENCE_PALETTE)[number];

/**
 * FNV-1a (32-bit) over UTF-16 code units. Chosen because it is tiny, has no
 * dependencies, and spreads short, similar ids ("user-1"/"user-2") across the
 * palette far better than a naive length/char sum.
 */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically map a participant id to a palette colour. The same id
 * always yields the same colour (across reloads and clients), so a caret does
 * not change tint when the server list arrives in a different order.
 */
export function assignColor(id: string): PresenceColor {
  const key = typeof id === "string" ? id : "";
  return PRESENCE_PALETTE[hashId(key) % PRESENCE_PALETTE.length];
}

/** Shallow copy of a participant, cloning the cursor so it is never aliased. */
function copyParticipant(participant: Participant): Participant {
  const copy: Participant = {
    id: participant.id,
    name: participant.name,
    lastSeen: participant.lastSeen,
  };
  if (participant.color !== undefined) copy.color = participant.color;
  if (participant.cursor !== undefined) {
    copy.cursor = { anchor: participant.cursor.anchor, head: participant.cursor.head };
  }
  return copy;
}

/**
 * Insert or refresh a participant by `id`, returning a new list.
 *
 * - An existing id is replaced in place, so the room's order does not churn as
 *   heartbeats arrive.
 * - A new id is appended.
 * - A participant with no usable id (empty/blank) is ignored; the input is
 *   still copied, so the result never aliases the caller's array.
 * - The input array and its entries are never mutated; the stored participant
 *   is a fresh object (with a cloned cursor).
 */
export function upsertParticipant(
  list: readonly Participant[],
  participant: Participant,
): Participant[] {
  const roster = Array.isArray(list) ? list : [];
  const id = typeof participant?.id === "string" ? participant.id.trim() : "";
  if (!id) return [...roster];

  const next: Participant[] = [];
  let replaced = false;
  for (const entry of roster) {
    if (entry.id === id) {
      next.push(copyParticipant(participant));
      replaced = true;
    } else {
      next.push(entry);
    }
  }
  if (!replaced) next.push(copyParticipant(participant));
  return next;
}

/**
 * Drop participants idle for longer than `ttlMs`, returning a new list.
 *
 * A participant is stale when `now - lastSeen > ttlMs`, so one exactly at the
 * boundary still counts as present. `lastSeen` that is not a finite number
 * (a corrupt heartbeat) is evicted rather than trusted; a non-finite `now` or
 * `ttlMs` keeps everyone (fail-safe: never evict on a bad clock).
 */
export function evictStale(
  list: readonly Participant[],
  now: number,
  ttlMs: number,
): Participant[] {
  const roster = Array.isArray(list) ? list : [];
  return roster.filter((entry) => {
    const lastSeen = entry?.lastSeen;
    if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return false;
    if (!Number.isFinite(now) || !Number.isFinite(ttlMs)) return true;
    return now - lastSeen <= ttlMs;
  });
}

/** Options for `visibleParticipants`. */
export type VisibleOptions = {
  now: number;
  ttlMs: number;
};

/**
 * The participants currently shown in the room, most-recently-seen first.
 *
 * Equivalent to `evictStale` followed by a stable, fully deterministic sort:
 * descending `lastSeen`, then `id` ascending so equal heartbeats never render
 * in a different sequence for different callers. The input is not mutated.
 */
export function visibleParticipants(
  list: readonly Participant[],
  options: VisibleOptions,
): Participant[] {
  const { now, ttlMs } = options ?? { now: Number.NaN, ttlMs: Number.NaN };
  return evictStale(list, now, ttlMs).sort((a, b) => {
    if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Clamp a remote caret to the local document and order its endpoints.
 *
 * Positions are truncated to integers and clamped into `[0, docSize]`;
 * non-finite input collapses to `0`; a non-finite or negative `docSize` is
 * treated as `0` (an empty document). After clamping, the endpoints are swapped
 * if needed so `anchor <= head` — a selection is the same span either direction
 * it was dragged. Always returns a fresh object.
 */
export function normalizeCursor(
  cursor: Partial<Cursor> | null | undefined,
  docSize: number,
): Cursor {
  const size = Number.isFinite(docSize) ? Math.max(0, Math.trunc(docSize)) : 0;
  const clamp = (value: number | undefined): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
    return Math.min(Math.max(n, 0), size);
  };
  const a = clamp(cursor?.anchor);
  const b = clamp(cursor?.head);
  return a <= b ? { anchor: a, head: b } : { anchor: b, head: a };
}

/** Label shown next to a live cursor; blank/missing names become "Anonymous". */
export function cursorLabel(participant: { name?: string } | null | undefined): string {
  const name = typeof participant?.name === "string" ? participant.name.trim() : "";
  return name === "" ? "Anonymous" : name;
}
