/**
 * Telemetry wiring — the process-side glue that makes the pure observability
 * cores load-bearing in the running app.
 *
 * Before this module, `observability.ts`, `metrics.ts` and
 * `feature-flag-store.ts` were inert: each had a full unit suite and zero
 * production importers. This file is the single place that owns their
 * process-wide instances and exposes a small façade the app actually calls
 * (`src/app/api/health/route.ts`, `src/app/api/metrics/route.ts` and the
 * `diagnostics` server action).
 *
 * Reconciliation (state the relationship, do not duplicate it):
 * - {@link snapshot}/{@link percentileReport} come from `observability.ts`,
 *   which is the canonical in-process registry of counters + histograms and the
 *   percentiles implementation.
 * - `metrics.ts` is delegated to as the Prometheus exposition + gauge layer:
 *   every {@link recordCounter}/{@link recordHistogram} fans out to both
 *   registries, and {@link recordGauge} exists only here, so `metrics.ts`
 *   (gauges + `toPrometheusText`) is genuinely load-bearing rather than a
 *   parallel copy of the same state.
 * - `feature-flag-store.ts` is the registry/resolver behind {@link
 *   effectiveFlags}: the built-in {@link DEFAULT_FLAGS} registry has the
 *   `FLAG_*` environment layer applied at read time.
 *
 * The logger sink is an in-memory ring buffer (bounded, redacted by the logger
 * itself) so a diagnostic reader can surface recent records without shipping a
 * log shipper; wiring a real OpenTelemetry exporter is still a follow-up.
 */

import {
  LOG_LEVELS,
  createLogger,
  createMetrics,
  newSpanId,
  newTraceId,
  percentiles,
  startSpan,
  withTrace,
  type CounterOptions,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type Logger,
  type MetricLabels,
  type MetricOptions,
  type Metrics as ObservabilityMetrics,
  type MetricsSnapshot as ObservabilitySnapshot,
} from "@/lib/observability";
import { createMetricsRegistry, type MetricsRegistry } from "@/lib/metrics";
import {
  applyFlagEnv,
  createFlagStore,
  resolveAll,
  snapshot as flagSnapshotOf,
  type FlagResolution,
  type FlagStore,
  type FlagStoreSnapshot,
} from "@/lib/feature-flag-store";
import type { Flag, FlagContext } from "@/lib/feature-flags";

/* -------------------------------------------------------------------------- */
/* Capacity + defaults                                                        */
/* -------------------------------------------------------------------------- */

/** Most recent structured log records retained for diagnostic reads. */
const LOG_CAPACITY = 200;
/** Most recent raw latency observations retained per series for percentiles. */
const LATENCY_CAPACITY = 512;
/** Percentile ranks exposed by {@link percentileReport} by default. */
export const DEFAULT_PERCENTILES: readonly number[] = [50, 95, 99];

/**
 * The built-in flag registry. These are process-scoped capabilities (not
 * per-user experiments), so the baseline is `enabled: true` and the `FLAG_*`
 * environment layer is the operator kill switch.
 */
export const DEFAULT_FLAGS: readonly Flag[] = [
  { key: "diagnostics_endpoint", enabled: true },
  { key: "error_reporting", enabled: true },
  { key: "structured_logging", enabled: true },
  { key: "metrics_percentiles", enabled: true, rollout: 100 },
];

/** Context used when no caller is available (system reads, cron, probes). */
const SYSTEM_FLAG_CONTEXT: FlagContext = { userId: "system" };

/* -------------------------------------------------------------------------- */
/* Process-wide state                                                         */
/* -------------------------------------------------------------------------- */

type LatencySeries = { name: string; labels: MetricLabels; values: number[] };

let logRing: LogRecord[] = [];
const latencySeries = new Map<string, LatencySeries>();

/**
 * Stable sink closure: it reads the current `logRing` binding, so
 * {@link resetTelemetry} can swap the buffer without rebuilding the logger.
 */
const logSink: LogSink = (record) => {
  logRing.push(record);
  if (logRing.length > LOG_CAPACITY) logRing.splice(0, logRing.length - LOG_CAPACITY);
};

/** Minimum severity to emit; `LOG_LEVEL` (case-insensitive) or `"info"`. */
function levelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

function buildLogger(): Logger {
  return createLogger({ level: levelFromEnv(), sink: logSink });
}

let logger: Logger = buildLogger();
let observability: ObservabilityMetrics = createMetrics();
let exposition: MetricsRegistry = createMetricsRegistry();

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

/** Emit one structured record at `level`; returns it, or `null` when filtered. */
export function log(level: LogLevel, msg: string, fields?: LogFields): LogRecord | null {
  return logger.log(level, msg, fields);
}

/** The most recent `limit` records, oldest first (a bounded, redacted view). */
export function recentLogs(limit = 50): readonly LogRecord[] {
  const count = Math.max(0, Math.floor(limit));
  return logRing.slice(Math.max(0, logRing.length - count));
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/** Canonical, order-independent key for one metric series. */
function seriesKey(name: string, labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  return `${name}\u0000${names.map((key) => `${key}\u0001${labels[key]}`).join("\u0002")}`;
}

/** Add `amount` (default 1) to a counter in both registries. */
export function recordCounter(name: string, options: CounterOptions = {}): void {
  observability.counter(name, options);
  exposition.increment(name, options.amount ?? 1, options.labels);
}

/** Record one finite observation into a histogram in both registries. */
export function recordHistogram(name: string, value: number, options: MetricOptions = {}): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  observability.histogram(name, value, options);
  exposition.observe(name, value, options.labels);

  const labels = options.labels ?? {};
  const key = seriesKey(name, labels);
  const existing = latencySeries.get(key);
  if (existing) {
    existing.values.push(value);
    if (existing.values.length > LATENCY_CAPACITY) {
      existing.values.splice(0, existing.values.length - LATENCY_CAPACITY);
    }
    return;
  }
  latencySeries.set(key, { name, labels: { ...labels }, values: [value] });
}

/** Set a gauge in the exposition registry (the only gauge registry). */
export function recordGauge(name: string, value: number, options: MetricOptions = {}): void {
  if (typeof value !== "number") return;
  exposition.gauge(name, value, options.labels);
}

/** The canonical counters/histograms snapshot (`observability.ts`). */
export function snapshot(): ObservabilitySnapshot {
  return observability.snapshot();
}

/** The Prometheus text exposition of the same writes (`metrics.ts`). */
export function prometheusText(): string {
  return exposition.toPrometheusText();
}

/** Percentiles for one histogram series, keyed `p50`/`p95`/… by rank. */
export type LatencyPercentiles = {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly percentiles: Readonly<Record<string, number>>;
};

/**
 * Percentiles for every latency series recorded through {@link recordHistogram}
 * (linear interpolation, via `observability.percentiles`). Series are ordered by
 * name then label, so two calls over the same state are deep-equal.
 */
export function percentileReport(
  ranks: readonly number[] = DEFAULT_PERCENTILES,
): readonly LatencyPercentiles[] {
  const cleanRanks = ranks.filter(
    (rank) => typeof rank === "number" && Number.isFinite(rank) && rank >= 0 && rank <= 100,
  );
  const series = [...latencySeries.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : seriesKey(a.name, a.labels) < seriesKey(b.name, b.labels) ? -1 : 1,
  );
  return series.map((entry) => {
    const values = percentiles(entry.values, cleanRanks);
    const byRank: Record<string, number> = {};
    cleanRanks.forEach((rank, index) => {
      byRank[`p${rank}`] = values[index];
    });
    return {
      name: entry.name,
      labels: { ...entry.labels },
      count: entry.values.length,
      percentiles: byRank,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Feature flags                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A fresh flag store: the built-in registry plus the current `FLAG_*`
 * environment layer. Rebuilt per call so a change to the environment (or a test)
 * is reflected immediately.
 */
export function flagStore(): FlagStore {
  return applyFlagEnv(createFlagStore({ flags: DEFAULT_FLAGS }), process.env);
}

/** Resolve every registered flag for `context` (defaults to the system context). */
export function effectiveFlags(
  context: FlagContext = SYSTEM_FLAG_CONTEXT,
): readonly FlagResolution[] {
  return resolveAll(flagStore(), context);
}

/** A serialisable snapshot (registry + both override layers) of the flag store. */
export function flagSnapshot(): FlagStoreSnapshot {
  return flagSnapshotOf(flagStore());
}

/* -------------------------------------------------------------------------- */
/* Tracing                                                                    */
/* -------------------------------------------------------------------------- */

export { newSpanId, newTraceId, startSpan, withTrace };

/* -------------------------------------------------------------------------- */
/* Test/admin reset                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Drop every in-process accumulator (logs, metrics, latency series) and rebuild
 * the logger from the current environment. Intended for tests and an admin
 * reset; the running app never needs it.
 */
export function resetTelemetry(): void {
  logRing = [];
  latencySeries.clear();
  observability = createMetrics();
  exposition = createMetricsRegistry();
  logger = buildLogger();
}
