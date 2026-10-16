/**
 * "Last edited by" tracking engine (docs/MISSING_FEATURES.md §4 "Last edited
 * by", docs/FEATURE_MATRIX.md "Last edited by").
 *
 * Today the workspace only records property/table writes through the activity
 * log, so a page's "last editor" ignores title and body changes made outside
 * the database view. This engine treats every {@link EditEvent} kind
 * (`title`/`content`/`property`/`structure`/`comment`) as an edit when it
 * answers "who touched this last?", collapses rapid same-author bursts into a
 * readable history, and degrades a deleted author to the entity creator (then
 * "Unknown").
 *
 * Everything is pure and in-memory: no prisma, no routes, no React and no
 * ambient clock — `describeLastEdited`/`isStale` are handed the current
 * instant, so relative labels are deterministic and unit-testable. Inputs are
 * never mutated and results are always fresh objects.
 *
 * Unit-pinned red-first by `src/lib/last-edited.test.ts`.
 */

/** The kind of thing an edit happened to. */
export type EditEntityType = "page" | "row" | "property" | "comment";

/** What changed. Every kind counts as an edit (see module docs). */
export type EditKind = "title" | "content" | "property" | "structure" | "comment";

/** One recorded edit. `at` is an ISO-8601 instant. */
export type EditEvent = {
  readonly id: string;
  readonly entityType: EditEntityType;
  readonly entityId: string;
  /** Author id, or a system/placeholder id when there is no human author. */
  readonly actorId: string;
  readonly kind: EditKind;
  /** ISO-8601 timestamp; compared by instant, not by string shape. */
  readonly at: string;
  /** Optional one-line description of the change. */
  readonly summary?: string;
};

/** The most recent edit touching an entity. */
export type EditorSummary = {
  readonly actorId: string;
  readonly at: string;
  readonly kind: EditKind;
  readonly summary?: string;
};

/** One entry in a collapsed editor history. */
export type EditorHistoryEntry = {
  readonly actorId: string;
  /** The newest instant in the collapsed burst. */
  readonly at: string;
  /** The kind of the newest edit in the burst. */
  readonly kind: EditKind;
  /** The most recent non-empty summary in the burst, when any. */
  readonly summary?: string;
  /** How many raw edits were collapsed into this entry (≥ 1). */
  readonly count: number;
};

/** A resolved workspace member, for turning an actor id into a name. */
export type EditMember = {
  readonly id: string;
  readonly name: string;
  /** Marks the entity's owner, used by the `"creator"` display fallback. */
  readonly isCreator?: boolean;
};

/** Immutable actor-id → display-name map. */
export type ActorMap = Readonly<Record<string, string>>;

/** Minimal shape needed to name an editor; `lastEditor` output satisfies it. */
export type EditorRef = { readonly actorId: string } | null | undefined;

/** Default burst window: edits by one author within 5 minutes collapse. */
export const DEFAULT_COALESCE_WINDOW_MS = 5 * 60_000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Millisecond instant of an ISO timestamp; unparseable input sorts as oldest. */
function millisOf(at: string): number {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Normalise a clock argument that may be a `Date` or an epoch number. */
function clockOf(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/** Append an edit, returning a new log and leaving `events` untouched. */
export function recordEdit(events: readonly EditEvent[], event: EditEvent): EditEvent[] {
  return [...events, event];
}

/**
 * The most recent edit for `entityId`, across EVERY edit kind — content and
 * title writes included, which is the gap this engine closes. Ties on `at` go
 * to the later-recorded event. Returns `null` when the entity has no edits.
 */
export function lastEditor(
  events: readonly EditEvent[],
  query: { readonly entityId: string },
): EditorSummary | null {
  let best: EditEvent | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.entityId !== query.entityId) continue;
    const time = millisOf(event.at);
    if (best === null || time > bestTime || (time === bestTime && index > bestIndex)) {
      best = event;
      bestTime = time;
      bestIndex = index;
    }
  }
  if (best === null) return null;
  return best.summary === undefined
    ? { actorId: best.actorId, at: best.at, kind: best.kind }
    : { actorId: best.actorId, at: best.at, kind: best.kind, summary: best.summary };
}

/**
 * Collapsed edit history for `entityId`, newest first.
 *
 * Consecutive events by the same author whose adjacent gap is at most
 * `coalesceMs` (default {@link DEFAULT_COALESCE_WINDOW_MS}) merge into a single
 * entry with a `count`; the representative keeps the newest `at`/`kind` and the
 * most recent non-empty `summary`. A different author always breaks the run.
 * `limit` caps the number of collapsed entries (after coalescing).
 */
export function editorHistory(
  events: readonly EditEvent[],
  query: {
    readonly entityId: string;
    readonly limit?: number;
    readonly coalesceMs?: number;
  },
): EditorHistoryEntry[] {
  const limit = query.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) return [];
  const window = query.coalesceMs ?? DEFAULT_COALESCE_WINDOW_MS;

  const matching = events
    .map((event, index) => ({ event, index, time: millisOf(event.at) }))
    .filter((row) => row.event.entityId === query.entityId)
    // Newest first; equal instants fall back to later-recorded first.
    .sort((a, b) => b.time - a.time || b.index - a.index);

  const entries: EditorHistoryEntry[] = [];
  let previousTime = Number.NaN;
  for (const row of matching) {
    const previous = entries.length > 0 ? entries[entries.length - 1] : undefined;
    const canMerge =
      previous !== undefined &&
      previous.actorId === row.event.actorId &&
      previousTime - row.time <= window;
    if (canMerge && previous !== undefined) {
      const summary = previous.summary ?? row.event.summary;
      entries[entries.length - 1] =
        summary === undefined
          ? { actorId: previous.actorId, at: previous.at, kind: previous.kind, count: previous.count + 1 }
          : { actorId: previous.actorId, at: previous.at, kind: previous.kind, summary, count: previous.count + 1 };
    } else {
      entries.push(
        row.event.summary === undefined
          ? { actorId: row.event.actorId, at: row.event.at, kind: row.event.kind, count: 1 }
          : {
              actorId: row.event.actorId,
              at: row.event.at,
              kind: row.event.kind,
              summary: row.event.summary,
              count: 1,
            },
      );
    }
    previousTime = row.time;
  }

  return Number.isFinite(limit) ? entries.slice(0, limit) : entries;
}

/**
 * Turn an actor id into a display name. An active member wins; otherwise, when
 * `fallback` is `"creator"`, the entity's creator is named. Anything else —
 * `fallback: "unknown"`, a null editor, or a missing creator — is `"Unknown"`,
 * so a deleted author never renders a bare id.
 */
export function resolveDisplayName(
  editor: EditorRef,
  options: {
    readonly members: readonly EditMember[];
    readonly fallback: "creator" | "unknown";
  },
): string {
  if (editor === null || editor === undefined) return "Unknown";
  const member = options.members.find((candidate) => candidate.id === editor.actorId);
  if (member !== undefined) return member.name;
  if (options.fallback === "creator") {
    const creator = options.members.find((candidate) => candidate.isCreator === true);
    if (creator !== undefined) return creator.name;
  }
  return "Unknown";
}

/** Relative phrase for a positive age in milliseconds. */
function relativeLabel(age: number, at: number): string {
  if (!Number.isFinite(age) || age < 60_000) return "just now";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(age / 3_600_000);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(age / 86_400_000);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * A footer label for the last edit: `"Edited 5 min ago by Ada"`. The author is
 * omitted when no name is known, and a `null` result renders `"Never edited"`.
 */
export function describeLastEdited(
  result: EditorSummary | null,
  options: { readonly now: Date | number; readonly actorName?: string | null },
): string {
  if (result === null) return "Never edited";
  const label = relativeLabel(clockOf(options.now) - millisOf(result.at), millisOf(result.at));
  const by = options.actorName ? ` by ${options.actorName}` : "";
  return `Edited ${label}${by}`;
}

/**
 * Whether an entity has gone quiet: `true` when its newest edit is at least
 * `staleAfterMs` old, and also when it has never been edited.
 */
export function isStale(
  events: readonly EditEvent[],
  query: {
    readonly entityId: string;
    readonly now: Date | number;
    readonly staleAfterMs: number;
  },
): boolean {
  const latest = lastEditor(events, { entityId: query.entityId });
  if (latest === null) return true;
  return clockOf(query.now) - millisOf(latest.at) >= query.staleAfterMs;
}

/** Merge two actor maps into a fresh one; `b` wins on key conflicts. */
export function mergeActorMaps(a: ActorMap, b: ActorMap): ActorMap {
  return { ...a, ...b };
}
