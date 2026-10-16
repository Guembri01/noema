/**
 * Cross-project roadmap engine (docs/MISSING_FEATURES.md §20 "Roadmap view").
 *
 * Pure, DB-free, clock-free layout logic that turns a flat list of dated work
 * items spread across projects into a renderable roadmap: one shared UTC time
 * axis with aligned tick boundaries, one lane group per project with the items
 * greedily packed into non-overlapping rows, plus rollup / summary helpers.
 *
 * Conventions, matching the rest of `src/lib`:
 *
 * - **All times are ms epochs.** A window is half-open `[from, to)` and an
 *   item's span is `[start, end)` — `end` is exclusive, so back-to-back items
 *   share a row and an item ending exactly on a boundary does not spill over.
 *   An item with no `end` (or `end <= start`) is a zero-duration milestone.
 * - **UTC only, no wall clock.** Tick boundaries are computed from UTC calendar
 *   components and labels are formatted with an explicit `timeZone: "UTC"`, so
 *   output is identical on any machine. The current time never leaks in: `now`
 *   is an explicit option used only to flag overdue items.
 * - **Deterministic.** Items sort by `(start, id)` and projects by
 *   `projectId`, so shuffling the input never changes the layout.
 * - **Fail-safe.** Items without a usable `start` are simply not placed and
 *   non-numeric progress is ignored rather than throwing.
 *
 * This is layout only — the React roadmap surface that consumes it is separate
 * work.
 */

/** Milliseconds in one UTC day. */
export const MS_PER_DAY = 86_400_000;

/** Tick granularity of the roadmap time axis. */
export type RoadmapZoom = "week" | "month" | "quarter";

/** A unit of work placed on the roadmap. Times are ms epochs (UTC). */
export type RoadmapItem = {
  id: string;
  projectId: string;
  title: string;
  /** Inclusive start instant. When absent the item cannot be placed. */
  start?: number;
  /** Exclusive end instant. When absent the item is a zero-duration milestone. */
  end?: number;
  /** Free-form workflow status (e.g. `"todo"`/`"done"`). */
  status?: string;
  /** Completion fraction in `[0, 1]`. */
  progress?: number;
};

/** A half-open viewport on the time axis (`[from, to)`). */
export type RoadmapWindow = { from: number; to: number };

/** One axis period and its display label. */
export type RoadmapAxisTick = {
  /** Inclusive start of the period (aligned to the zoom unit). */
  start: number;
  /** Exclusive end of the period (= the next tick's `start`). */
  end: number;
  label: string;
};

/** The generated time axis: the aligned ticks covering a window. */
export type RoadmapAxis = {
  from: number;
  to: number;
  zoom: RoadmapZoom;
  ticks: RoadmapAxisTick[];
};

/** One item positioned inside a project lane. `x`/`width` are 0..1 fractions. */
export type RoadmapRow<T extends RoadmapItem = RoadmapItem> = {
  item: T;
  /** Left edge as a fraction of the window, in `[0, 1]`. */
  x: number;
  /** Width as a fraction of the window, in `[0, 1]` (0 for a milestone). */
  width: number;
  /** 0-based row inside its project; rows sharing a lane never overlap. */
  laneIndex: number;
  /** True when the item is past `now` and not yet complete. */
  overdue: boolean;
};

/** A project's items packed onto non-overlapping rows, in stable order. */
export type RoadmapLane<T extends RoadmapItem = RoadmapItem> = {
  projectId: string;
  rows: RoadmapRow<T>[];
};

/** The full layout: the shared axis plus one lane group per project. */
export type Roadmap<T extends RoadmapItem = RoadmapItem> = {
  window: RoadmapWindow;
  axis: RoadmapAxis;
  lanes: RoadmapLane<T>[];
};

/** Options for {@link buildRoadmap}. */
export type BuildRoadmapOptions = {
  from: number;
  to: number;
  zoom: RoadmapZoom;
  /** Reference instant for the `overdue` flag. Omitted → nothing is overdue. */
  now?: number;
};

/** Per-project aggregate progress. */
export type ProjectRollup = {
  projectId: string;
  /** Number of items in the project. */
  itemCount: number;
  /** Items that carried a usable numeric progress value. */
  trackedCount: number;
  /** Mean of tracked progress, clamped to `[0, 1]`; `0` when none tracked. */
  progress: number;
};

/** High-level counts describing a roadmap's item list. */
export type RoadmapSummary = {
  total: number;
  projects: number;
  /** Items with a usable `start`. */
  scheduled: number;
  /** Items without a usable `start` (cannot be placed). */
  unscheduled: number;
  /** Zero-duration items. */
  milestones: number;
  /** Items whose progress reached `1`. */
  completed: number;
  /** Items past `now` that are not complete (requires `now`). */
  overdue: number;
  byStatus: Record<string, number>;
};

const WEEK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  year: "numeric",
});

function assertZoom(zoom: RoadmapZoom): void {
  if (zoom !== "week" && zoom !== "month" && zoom !== "quarter") {
    throw new RangeError(`zoom must be "week", "month" or "quarter", got ${String(zoom)}`);
  }
}

function assertInstant(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite ms epoch, got ${value}`);
  }
}

/** Read an optional finite number off an unknown object property. */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A 0..1 progress fraction, or `undefined` when absent/invalid. */
function progressOf(item: unknown, key: string): number | undefined {
  const value = readNumber(item, key);
  if (value === undefined) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** The half-open span of an item, or `null` when it has no usable start. */
function spanOf(item: RoadmapItem): { start: number; end: number } | null {
  if (typeof item.start !== "number" || !Number.isFinite(item.start)) return null;
  const end =
    typeof item.end === "number" && Number.isFinite(item.end) ? item.end : item.start;
  return { start: item.start, end };
}

/** True for a zero-duration item: no `end`, or `end <= start`. */
function isMilestoneItem(item: RoadmapItem): boolean {
  const span = spanOf(item);
  if (!span) return false;
  return span.end <= span.start;
}

function isOverdue(item: RoadmapItem, now: number | undefined): boolean {
  if (now === undefined || !Number.isFinite(now)) return false;
  const span = spanOf(item);
  if (!span) return false;
  const progress = progressOf(item, "progress");
  if (progress !== undefined && progress >= 1) return false;
  return span.end < now;
}

/** The UTC instant the zoom period containing `ms` begins at. */
function periodStart(ms: number, zoom: RoadmapZoom): number {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  switch (zoom) {
    case "week": {
      const mondayOffset = (date.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
      return Date.UTC(year, month, date.getUTCDate() - mondayOffset);
    }
    case "month":
      return Date.UTC(year, month, 1);
    case "quarter":
      return Date.UTC(year, Math.floor(month / 3) * 3, 1);
  }
}

/** The start of the period immediately after the one beginning at `ms`. */
function periodAfter(ms: number, zoom: RoadmapZoom): number {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (zoom) {
    case "week":
      return Date.UTC(year, month, day + 7);
    case "month":
      return Date.UTC(year, month + 1, 1);
    case "quarter":
      return Date.UTC(year, month + 3, 1);
  }
}

function tickLabel(ms: number, zoom: RoadmapZoom): string {
  const date = new Date(ms);
  switch (zoom) {
    case "week":
      return WEEK_FORMAT.format(ms);
    case "month":
      return MONTH_FORMAT.format(ms);
    case "quarter":
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  }
}

/**
 * Generate the aligned tick boundaries covering `[from, to)` at `zoom`.
 *
 * Ticks are aligned to UTC calendar boundaries — Monday for `"week"`, the 1st
 * for `"month"`, the first day of Jan/Apr/Jul/Oct for `"quarter"`. The first
 * tick starts at or before `from` (the period containing it) and the last tick
 * starts strictly before `to`; each tick ends exactly where the next begins.
 * A degenerate/inverted window yields no ticks.
 *
 * @throws RangeError for an unknown zoom or non-finite `from`/`to`.
 */
export function roadmapAxis(from: number, to: number, zoom: RoadmapZoom): RoadmapAxis {
  assertZoom(zoom);
  assertInstant(from, "from");
  assertInstant(to, "to");
  const ticks: RoadmapAxisTick[] = [];
  if (to > from) {
    let cursor = periodStart(from, zoom);
    while (cursor < to) {
      const next = periodAfter(cursor, zoom);
      ticks.push({ start: cursor, end: next, label: tickLabel(cursor, zoom) });
      cursor = next;
    }
  }
  return { from, to, zoom, ticks };
}

/**
 * Clamp an item's span to `[window.from, window.to]`.
 *
 * Fully inside → unchanged. Hanging off an edge → clipped. A missing `end`
 * means an instant at `start`; an item fully before/after the window collapses
 * to a zero-length span at the near edge. Returns `null` when the item has no
 * usable `start`.
 */
export function clampToWindow(
  item: RoadmapItem,
  window: RoadmapWindow,
): { start: number; end: number } | null {
  const span = spanOf(item);
  if (!span) return null;
  const start = Math.min(Math.max(span.start, window.from), window.to);
  const end = Math.min(Math.max(span.end, window.from), window.to);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** True when an item's span intersects the half-open window. */
function intersectsWindow(item: RoadmapItem, window: RoadmapWindow): boolean {
  const span = spanOf(item);
  if (!span) return false;
  if (!(window.to > window.from)) return false;
  if (span.end <= span.start) {
    return span.start >= window.from && span.start < window.to;
  }
  return span.start < window.to && span.end > window.from;
}

/**
 * Extract the zero-duration milestones (no `end`, or `end <= start`) from a
 * list, in the deterministic `(start, id)` order. Items without a usable
 * `start` are skipped.
 */
export function milestones<T extends RoadmapItem>(items: readonly T[]): T[] {
  return items
    .filter(isMilestoneItem)
    .sort(
      (a, b) => (spanOf(a)?.start ?? 0) - (spanOf(b)?.start ?? 0) || a.id.localeCompare(b.id),
    );
}

/**
 * Pack items into non-overlapping lanes per project and position them on the
 * shared axis.
 *
 * Items are grouped by `projectId` (lanes ordered by `projectId`) and each
 * group is greedily coloured: sorted by `(start, id)` and given the lowest lane
 * whose previous item ends at or before this one starts (half-open spans, so
 * back-to-back items share a lane). `x`/`width` are fractions of the window
 * computed from the clamped span; milestones get `width: 0`.
 *
 * Items without a usable `start`, or entirely outside the window, are not
 * placed. A degenerate/inverted window yields no lanes. Inputs are never
 * mutated and the result is deterministic regardless of input order.
 */
export function buildRoadmap<T extends RoadmapItem>(
  items: readonly T[],
  options: BuildRoadmapOptions,
): Roadmap<T> {
  const { from, to, zoom, now } = options;
  const axis = roadmapAxis(from, to, zoom);
  const window: RoadmapWindow = { from, to };
  const duration = to - from;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { window, axis, lanes: [] };
  }

  const byProject = new Map<string, T[]>();
  for (const item of items) {
    if (!intersectsWindow(item, window)) continue;
    const list = byProject.get(item.projectId);
    if (list) list.push(item);
    else byProject.set(item.projectId, [item]);
  }

  const lanes = [...byProject.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((projectId) => {
      const projectItems = [...(byProject.get(projectId) ?? [])].sort(
        (a, b) => (spanOf(a)?.start ?? 0) - (spanOf(b)?.start ?? 0) || a.id.localeCompare(b.id),
      );
      // laneEnd[lane] = end instant of the most recent item placed there.
      const laneEnd: number[] = [];
      const rows: RoadmapRow<T>[] = [];
      for (const item of projectItems) {
        const span = spanOf(item);
        if (!span) continue;
        let laneIndex = laneEnd.findIndex((end) => end <= span.start);
        if (laneIndex === -1) {
          laneIndex = laneEnd.length;
          laneEnd.push(span.end);
        } else {
          laneEnd[laneIndex] = span.end;
        }
        const clamped = clampToWindow(item, window);
        if (!clamped) continue;
        rows.push({
          item,
          x: (clamped.start - from) / duration,
          width: (clamped.end - clamped.start) / duration,
          laneIndex,
          overdue: isOverdue(item, now),
        });
      }
      return { projectId, rows };
    });

  return { window, axis, lanes };
}

/**
 * Aggregate progress per project.
 *
 * For each project the mean of every item's numeric progress (read from
 * `progressKey`, default `"progress"`) is computed and clamped to `[0, 1]`;
 * non-numeric values are ignored. `trackedCount` is how many items
 * contributed and `progress` is `0` when none did. Projects are ordered by
 * `projectId`.
 */
export function projectRollup<T extends RoadmapItem>(
  items: readonly T[],
  options: { progressKey?: string } = {},
): ProjectRollup[] {
  const progressKey = options.progressKey ?? "progress";
  const groups = new Map<string, { itemCount: number; trackedCount: number; sum: number }>();
  for (const item of items) {
    let group = groups.get(item.projectId);
    if (!group) {
      group = { itemCount: 0, trackedCount: 0, sum: 0 };
      groups.set(item.projectId, group);
    }
    group.itemCount += 1;
    const value = progressOf(item, progressKey);
    if (value !== undefined) {
      group.trackedCount += 1;
      group.sum += value;
    }
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([projectId, group]) => ({
      projectId,
      itemCount: group.itemCount,
      trackedCount: group.trackedCount,
      progress: group.trackedCount === 0 ? 0 : group.sum / group.trackedCount,
    }));
}

/**
 * Summarise an item list: totals, project count, scheduling, milestones,
 * completion, overdue (relative to an explicit `now`) and a status tally.
 * Nothing here reads the clock.
 */
export function describeRoadmap<T extends RoadmapItem>(
  items: readonly T[],
  options: { now?: number } = {},
): RoadmapSummary {
  const byStatus: Record<string, number> = {};
  let scheduled = 0;
  let milestones_ = 0;
  let completed = 0;
  let overdue = 0;
  for (const item of items) {
    const span = spanOf(item);
    if (span) {
      scheduled += 1;
      if (isMilestoneItem(item)) milestones_ += 1;
    }
    const progress = progressOf(item, "progress");
    if (progress !== undefined && progress >= 1) completed += 1;
    if (isOverdue(item, options.now)) overdue += 1;
    if (typeof item.status === "string" && item.status.length > 0) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
  }
  const projects = new Set(items.map((item) => item.projectId)).size;
  return {
    total: items.length,
    projects,
    scheduled,
    unscheduled: items.length - scheduled,
    milestones: milestones_,
    completed,
    overdue,
    byStatus,
  };
}
