/**
 * Estimate units — pure conversions and counting for ticket/issue estimates
 * (docs/MISSING_FEATURES.md). Estimates are stored as a number plus a unit;
 * this module is the single place that knows how the units relate so callers
 * can add apples to oranges without losing the unit the user typed.
 *
 * The canonical base is `points`: `points` and `hours` are 1:1 and `1 day`
 * is worth `8` of them (`8 hours` / `8 points`) by default. The table is
 * per-call overridable — pass `{ days: 6 }` for a 6-hour workday — and a bad
 * override (non-finite or `<= 0`) falls back to the default rather than
 * producing `Infinity`/`NaN` silently.
 *
 * Everything here is pure and dependency-free. Unknown units are coerced to
 * `points`, non-finite values are treated as absent, `convert` returns `NaN`
 * (never throws) for unmappable input, and no function mutates its arguments.
 */

/** The estimate units this module understands, in canonical tie-break order. */
export const ESTIMATE_UNITS = ["points", "hours", "days"] as const;

export type EstimateUnit = (typeof ESTIMATE_UNITS)[number];

/** How many canonical points one of each unit is worth. */
export type EstimateConversion = Record<EstimateUnit, number>;

/** Default table: 1 day === 8 hours === 8 points (1 point === 1 hour). */
export const DEFAULT_ESTIMATE_CONVERSION: EstimateConversion = {
  points: 1,
  hours: 1,
  days: 8,
};

/** Loose item shape accepted from stored ticket rows. */
export type EstimateInput = {
  estimate: number | null | undefined;
  estimateUnit?: string | null;
};

/** A single estimate expressed in one target unit. */
export type NormalizedEstimate = {
  estimate: number;
  unit: EstimateUnit;
};

/** Result of `sumEstimates`: a total plus the unit it is expressed in. */
export type EstimateSummary = {
  total: number;
  unit: EstimateUnit;
  count: number;
};

/** Round to hundredths so float conversion never leaks `7.999999` output. */
const roundHundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * Type guard for the three known units. Non-strings, `null`, `undefined` and
 * anything else are rejected, so it can narrow raw form/DB values directly.
 */
export function isEstimateUnit(value: unknown): value is EstimateUnit {
  return typeof value === "string" && (ESTIMATE_UNITS as readonly string[]).includes(value);
}

/** Resolve one unit's factor, falling back to the default for bad overrides. */
function factorFor(unit: EstimateUnit, conversion: Partial<EstimateConversion>): number {
  const override = conversion[unit];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  return DEFAULT_ESTIMATE_CONVERSION[unit];
}

/** Coerce a raw stored unit to a known one, defaulting to `points`. */
function resolveUnit(raw: unknown): EstimateUnit {
  return isEstimateUnit(raw) ? raw : "points";
}

/**
 * Convert `value` from one unit to another through the canonical points base,
 * rounded to two decimals. Returns `NaN` (never throws) when `value` is not
 * finite or either unit is unknown. `conversion` may override any unit; invalid
 * overrides are ignored.
 */
export function convert(
  value: number,
  from: EstimateUnit,
  to: EstimateUnit,
  conversion: Partial<EstimateConversion> = {},
): number {
  if (!Number.isFinite(value)) return Number.NaN;
  if (!isEstimateUnit(from) || !isEstimateUnit(to)) return Number.NaN;
  return roundHundredths((value * factorFor(from, conversion)) / factorFor(to, conversion));
}

/**
 * Sum estimates into a single "dominant" unit — the unit used by the most
 * items after coercion (a deterministic tie-break follows `ESTIMATE_UNITS`,
 * so `points` beats `hours` beats `days`). Every valid estimate is converted
 * into that unit first. Missing/non-finite estimates are skipped but still
 * counted in `count` (matching the number of rows considered). An empty or
 * all-invalid list yields `{ total: 0, unit: "points", count }`.
 */
export function sumEstimates(
  items: readonly EstimateInput[],
  conversion: Partial<EstimateConversion> = {},
): EstimateSummary {
  const counts = new Map<EstimateUnit, number>();
  let points = 0;

  for (const item of items) {
    const value = item.estimate;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const unit = resolveUnit(item.estimateUnit);
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
    points += value * factorFor(unit, conversion);
  }

  let dominant: EstimateUnit = "points";
  let best = -1;
  for (const unit of ESTIMATE_UNITS) {
    const seen = counts.get(unit) ?? 0;
    if (seen > best) {
      best = seen;
      dominant = unit;
    }
  }

  return {
    total: convert(points, "points", dominant, conversion),
    unit: dominant,
    count: items.length,
  };
}

/**
 * Convert every valid estimate to a single target unit (default `points`) so
 * rows can be compared or displayed on one scale. Missing/non-finite estimates
 * are dropped; unknown units default to `points`. Preserves order, returns a
 * fresh array, and never mutates its input.
 */
export function normalizeEstimates(
  items: readonly EstimateInput[],
  to: EstimateUnit = "points",
  conversion: Partial<EstimateConversion> = {},
): NormalizedEstimate[] {
  const target = resolveUnit(to);
  const normalized: NormalizedEstimate[] = [];

  for (const item of items) {
    const value = item.estimate;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const unit = resolveUnit(item.estimateUnit);
    normalized.push({ estimate: convert(value, unit, target, conversion), unit: target });
  }

  return normalized;
}

/**
 * Human-readable estimate ("3 points", "1.5 days", "-1 day"). Rounds to two
 * decimals, uses the singular noun for an absolute value of exactly `1`, and
 * renders an em dash for missing/non-finite values. Unknown units fall back to
 * `points` rather than throwing.
 */
export function formatEstimate(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const resolved = resolveUnit(unit);
  const rounded = roundHundredths(value);
  const noun = resolved === "hours" ? "hour" : resolved === "days" ? "day" : "point";
  return `${rounded} ${Math.abs(rounded) === 1 ? noun : `${noun}s`}`;
}
