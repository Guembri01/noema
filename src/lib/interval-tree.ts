/**
 * Interval utilities — pure set algebra over numeric half-open spans.
 *
 * An `Interval` is `[start, end)`: `start` is inclusive, `end` is exclusive, so
 * back-to-back spans (`a.end === b.start`) never overlap and can coexist. This
 * is the same convention `@/lib/timeline` and `@/lib/calendar-multiday` use for
 * events, and the unit is opaque (ms epochs, minutes, indices — callers choose).
 *
 * Everything here is pure, deterministic and non-mutating: inputs are never
 * modified, outputs are freshly allocated and **sorted by `(start, end)`** with
 * input order breaking ties, so the same arguments always yield the same bytes
 * regardless of the order they were supplied in. No clocks, no `Date`, no I/O.
 *
 * This is data-structure logic only — the views that render a schedule or a
 * resource timeline are separate work.
 */

/** A half-open numeric interval `[start, end)`. */
export type Interval = { start: number; end: number };

/** Field accessors that project an arbitrary item onto an interval. */
export type IntervalAccessors<T> = {
  startOf: (item: T) => number;
  endOf: (item: T) => number;
};

/** An `Interval` paired with the item it was built from. */
export type IntervalEntry<T> = {
  start: number;
  end: number;
  item: T;
};

/** A point probe (a single instant) or a half-open range probe. */
export type IntervalProbe = number | Interval;

/** Deterministic order: ascending start, then ascending end. */
function compareIntervals(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end;
}

/** Reject non-finite bounds and reversed spans; empty spans (`end === start`) are allowed. */
function assertInterval(interval: Interval): void {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) {
    throw new RangeError(
      `interval bounds must be finite numbers, got [${interval.start}, ${interval.end})`,
    );
  }
  if (interval.end < interval.start) {
    throw new RangeError(
      `interval end must not precede start, got [${interval.start}, ${interval.end})`,
    );
  }
}

/**
 * Project items through `{ startOf, endOf }` into a sorted interval list.
 *
 * Each returned entry keeps a reference to its source `item`, so a query can
 * hand the caller back the original objects. The output is sorted by
 * `(start, end)`; entries with identical bounds stay in their input order.
 *
 * @throws RangeError when a projected bound is not finite or the end precedes
 *   the start.
 */
export function buildIntervals<T>(
  items: readonly T[],
  accessors: IntervalAccessors<T>,
): IntervalEntry<T>[] {
  const entries = items.map((item) => {
    const entry: IntervalEntry<T> = {
      start: accessors.startOf(item),
      end: accessors.endOf(item),
      item,
    };
    assertInterval(entry);
    return entry;
  });
  return entries.sort(compareIntervals);
}

/**
 * Every stored interval that overlaps `probe`, in stored (sorted) order.
 *
 * A numeric probe is a point tested half-open: an interval matches when
 * `start <= point < end`, so a shared boundary matches the interval that
 * *starts* there, never the one that ends there. An `Interval` probe is a
 * half-open range; it matches when the spans' interiors intersect
 * (`max(starts) < min(ends)`), so touching ranges do not match. Zero-length
 * intervals and zero-length probes therefore overlap nothing.
 *
 * @throws RangeError when an `Interval` probe is non-finite or reversed.
 */
export function queryOverlaps<T extends Interval>(
  intervals: readonly T[],
  probe: IntervalProbe,
): T[] {
  if (typeof probe === "number") {
    return intervals.filter((interval) => interval.start <= probe && probe < interval.end);
  }
  assertInterval(probe);
  return intervals.filter(
    (interval) => Math.max(interval.start, probe.start) < Math.min(interval.end, probe.end),
  );
}

/**
 * Copy `intervals` with `interval` added in sorted position.
 *
 * The input is not mutated. Ties keep stable order, so the newly inserted
 * interval lands after any existing interval with the same bounds.
 *
 * @throws RangeError for an invalid `interval`.
 */
export function insert<T extends Interval>(intervals: readonly T[], interval: T): T[] {
  assertInterval(interval);
  return [...intervals, interval].sort(compareIntervals);
}

/**
 * Copy `intervals` without the spans whose bounds equal `target`'s.
 *
 * Matching is structural (`start` **and** `end`), so every duplicate of
 * `target` is dropped; any other field is ignored. The input is not mutated and
 * the relative order of the survivors is preserved.
 */
export function remove<T extends Interval>(intervals: readonly T[], target: Interval): T[] {
  return intervals.filter(
    (interval) => interval.start !== target.start || interval.end !== target.end,
  );
}

/**
 * The maximum number of intervals concurrent at any single instant.
 *
 * A standard sweep: every non-empty interval contributes a `+1` at its start
 * and a `-1` at its end. At a shared instant the ends are applied **before**
 * the starts, so back-to-back intervals (`a.end === b.start`) are never counted
 * together. Zero-length intervals cover no instant and are ignored. Returns 0
 * for an empty set.
 *
 * @throws RangeError for an invalid interval.
 */
export function maxOverlap(intervals: readonly Interval[]): number {
  const points: Array<{ at: number; delta: number }> = [];
  for (const interval of intervals) {
    assertInterval(interval);
    if (interval.start === interval.end) continue;
    points.push({ at: interval.start, delta: 1 }, { at: interval.end, delta: -1 });
  }
  // At equal instants, -1 (end) sorts before +1 (start): half-open spans do not overlap.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    if (active > peak) peak = active;
  }
  return peak;
}

/**
 * Collapse intervals into the minimal sorted list of disjoint spans.
 *
 * Spans that overlap **or merely touch** (`a.end === b.start`) merge, since
 * together they cover a single continuous block; a span nested inside another
 * is absorbed. An isolated zero-length span is kept as-is. The input is not
 * mutated.
 *
 * @throws RangeError for an invalid interval.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  for (const interval of intervals) assertInterval(interval);

  const sorted = [...intervals].sort(compareIntervals);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}
