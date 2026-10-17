/**
 * Observability engine — the pure, framework-free core behind the platform's
 * structured logs, metrics and traces (§17 Observability).
 *
 * Three additive pieces share one module:
 *
 * - **Logging.** `createLogger({ level, sink, now, base })` returns a logger
 *   whose `debug/info/warn/error` methods emit a flat record shaped
 *   `{ ts, level, msg, ...fields, traceId }` to the injected `sink`. Records
 *   below the configured level never reach the sink (the call returns `null`).
 *   Every field value is redacted before it leaves the process: sensitive keys
 *   (the repository's one secret-key list, `src/lib/redaction.ts`, plus caller
 *   `redactKeys`) become `"[redacted]"`, recursively through nested objects and
 *   arrays, cycle-safe and without mutating the caller's input.
 * - **Metrics.** `createMetrics()` is the one deliberately stateful piece:
 *   `counter`/`histogram` accumulate, and `snapshot()` returns a fresh,
 *   decoupled view sorted deterministically (metric name, then canonical label
 *   key) so two snapshots of the same state are deep-equal.
 * - **Tracing.** `withTrace(ctx, fn)` scopes an ambient trace for the duration
 *   of `fn` (restoring the previous scope afterwards), `startSpan(name, ctx)`
 *   records a span that inherits the ambient trace/span and reports a duration
 *   from the injected clock via `end(attrs)`, and `percentiles` summarises a
 *   series with linear interpolation (R-7).
 *
 * There is no clock, DB or network hidden here: `now` is injectable, traces
 * are synchronous scopes, and the ids are generated locally from the platform
 * CSPRNG (`src/lib/random.ts`) — never `Math.random`. Wiring an OpenTelemetry
 * exporter or a real log shipper is a follow-up; this module is the additive,
 * unit-pinned core.
 */

import { isSecretKey } from "./redaction";
import { randomBytes, toHex } from "./random";

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

/** The four log severities, ascending. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** The severities in ascending order. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Marker that replaces a value whose key is secret-shaped. */
export const REDACTED = "[redacted]";

/** Marker for a back-reference that would otherwise recurse forever. */
export const CIRCULAR = "[circular]";

/** Trace id used when a record carries no ambient or configured trace. */
export const NO_TRACE_ID = "-";

/** Default recursion cap for redaction. */
export const DEFAULT_MAX_REDACT_DEPTH = 8;

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Whether a field key holds a secret and must be redacted. The built-in rule
 * is the repository's shared list (`src/lib/redaction.ts`) and is intentionally
 * broad (a substring match, so `tokenCount` is masked too); `extraKeys` adds
 * precise, case-insensitive exact matches for names the built-ins miss (e.g.
 * `ssn`).
 */
export function isSensitiveKey(key: string, extraKeys?: readonly string[]): boolean {
  if (typeof key !== "string") return false;
  const lower = key.toLowerCase();
  if (extraKeys?.some((candidate) => candidate.toLowerCase() === lower)) return true;
  return isSecretKey(key);
}

/** Options for {@link redactValue}. */
export type RedactOptions = {
  /** Extra key names treated as secret, matched case-insensitively. */
  readonly redactKeys?: readonly string[];
  /** Maximum object depth to descend before leaving values untouched. */
  readonly maxDepth?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function redactInto(
  value: unknown,
  extraKeys: readonly string[] | undefined,
  maxDepth: number,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > maxDepth) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    return value.map((item) => redactInto(item, extraKeys, maxDepth, seen, depth + 1));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = isSensitiveKey(key, extraKeys)
        ? REDACTED
        : redactInto(value[key], extraKeys, maxDepth, seen, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Deep-copy `value`, replacing any secret-shaped key's value with
 * {@link REDACTED}. Arrays and plain objects are rebuilt; other values pass
 * through untouched. Cycles become {@link CIRCULAR} and the caller's input is
 * never mutated.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_REDACT_DEPTH;
  return redactInto(value, options.redactKeys, maxDepth, new WeakSet<object>(), 0);
}

/* -------------------------------------------------------------------------- */
/* Trace context                                                              */
/* -------------------------------------------------------------------------- */

/** The ambient trace scope carried by {@link withTrace}. */
export type TraceContext = {
  /** Trace id shared by every span in the trace. */
  readonly traceId: string;
  /** The active span's id, when inside a span. */
  readonly spanId?: string;
};

const traceStack: TraceContext[] = [];

/** The innermost ambient trace scope, or `null` when none is active. */
export function currentTrace(): TraceContext | null {
  return traceStack.length === 0 ? null : traceStack[traceStack.length - 1];
}

/**
 * Run `fn` with `ctx` as the ambient trace, restoring the previous scope
 * afterwards (even if `fn` throws). Synchronous by design: the scope is a stack
 * entry, not an async-local store.
 */
export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  traceStack.push(ctx);
  try {
    return fn();
  } finally {
    traceStack.pop();
  }
}

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

/** Structured fields attached to a log record. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A flat structured log record: reserved keys plus the caller's redacted fields. */
export type LogRecord = Readonly<Record<string, unknown>> & {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  readonly traceId: string;
};

/** Destination for emitted records (a console, a buffer, a shipper, …). */
export type LogSink = (record: LogRecord) => void;

/** Construction options for {@link createLogger}; every field is optional. */
export type LoggerConfig = {
  /** Minimum severity to emit. Defaults to `"info"`. */
  readonly level?: LogLevel;
  /** Where records go. Defaults to a no-op (records are still returned). */
  readonly sink?: LogSink;
  /** Clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Fields merged into every record (call fields win). */
  readonly base?: LogFields;
  /** Extra secret-shaped keys for redaction, matched case-insensitively. */
  readonly redactKeys?: readonly string[];
};

const RESERVED_RECORD_KEYS = new Set(["ts", "level", "msg", "traceId"]);

/** A level-filtering structured logger. */
export type Logger = {
  /** The configured minimum severity. */
  readonly level: LogLevel;
  /** Emit at an explicit level; returns the record, or `null` when filtered. */
  log(level: LogLevel, msg: string, fields?: LogFields): LogRecord | null;
  debug(msg: string, fields?: LogFields): LogRecord | null;
  info(msg: string, fields?: LogFields): LogRecord | null;
  warn(msg: string, fields?: LogFields): LogRecord | null;
  error(msg: string, fields?: LogFields): LogRecord | null;
};

/** Create a structured logger. */
export function createLogger(config: LoggerConfig = {}): Logger {
  const level = config.level ?? "info";
  const threshold = LEVEL_RANK[level];
  const sink = config.sink ?? ((): void => {});
  const now = config.now ?? ((): number => Date.now());
  const base = config.base ?? {};
  const redactKeys = config.redactKeys;

  function emit(recordLevel: LogLevel, msg: string, fields?: LogFields): LogRecord | null {
    if (LEVEL_RANK[recordLevel] < threshold) return null;

    // Merge base + call fields, then lift `traceId` out so it stays authoritative.
    const merged: Record<string, unknown> = { ...base, ...fields };
    const explicitTrace = merged.traceId;
    delete merged.traceId;
    const redacted = redactValue(merged, { redactKeys }) as Record<string, unknown>;

    const traceId =
      typeof explicitTrace === "string"
        ? explicitTrace
        : currentTrace()?.traceId ?? NO_TRACE_ID;

    const record: Record<string, unknown> = { ts: now(), level: recordLevel, msg };
    for (const key of Object.keys(redacted)) {
      if (RESERVED_RECORD_KEYS.has(key)) continue;
      record[key] = redacted[key];
    }
    record.traceId = traceId;

    const finalRecord = record as LogRecord;
    sink(finalRecord);
    return finalRecord;
  }

  return {
    level,
    log: emit,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

/* -------------------------------------------------------------------------- */
/* Spans                                                                      */
/* -------------------------------------------------------------------------- */

/** Options for {@link startSpan}. */
export type SpanContext = {
  /** Trace id; defaults to the ambient trace, then a fresh id. */
  readonly traceId?: string;
  /** Parent span id; defaults to the ambient span when no explicit trace id. */
  readonly parentId?: string;
  /** Clock for start/end times, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Attributes captured at span start. */
  readonly attrs?: LogFields;
};

/** A finished span. */
export type SpanRecord = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  /** `endTime - startTime`, in the injected clock's units. */
  readonly duration: number;
  /** Start attrs merged with the attrs passed to `end` (end wins). */
  readonly attrs: LogFields;
};

/** A running span recorder. */
export type Span = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  /** Finish the span; idempotent (later calls return the first record). */
  end(attrs?: LogFields): SpanRecord;
};

/**
 * `length` hex characters from the platform CSPRNG. A trace id carries 128
 * bits and a span id 64 — the sizes OpenTelemetry uses — so two ids of the
 * same kind never collide by accident and cannot be guessed from another.
 */
function randomHex(length: number): string {
  return toHex(randomBytes(Math.ceil(length / 2))).slice(0, length);
}

/** Generate a 128-bit trace id as 32 lowercase hex characters. */
export function newTraceId(): string {
  return randomHex(32);
}

/** Generate a 64-bit span id as 16 lowercase hex characters. */
export function newSpanId(): string {
  return randomHex(16);
}

/**
 * Start a span. The trace id falls back to the ambient scope (then a fresh id),
 * and the parent falls back to the ambient span only when no explicit trace id
 * was given — so a caller can cross into a different trace without inheriting
 * the wrong parent.
 */
export function startSpan(name: string, ctx: SpanContext = {}): Span {
  const ambient = currentTrace();
  const traceId = ctx.traceId ?? ambient?.traceId ?? newTraceId();
  const parentId =
    ctx.parentId ?? (ctx.traceId === undefined ? ambient?.spanId : undefined);
  const spanId = newSpanId();
  const clock = ctx.now ?? ((): number => Date.now());
  const startTime = clock();
  const startAttrs: Record<string, unknown> = { ...ctx.attrs };
  let finished: SpanRecord | null = null;

  return {
    traceId,
    spanId,
    ...(parentId === undefined ? {} : { parentId }),
    name,
    startTime,
    end(endAttrs?: LogFields): SpanRecord {
      if (finished) return finished;
      const endTime = clock();
      finished = {
        traceId,
        spanId,
        ...(parentId === undefined ? {} : { parentId }),
        name,
        startTime,
        endTime,
        duration: endTime - startTime,
        attrs: { ...startAttrs, ...endAttrs },
      };
      return finished;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/** A metric's label set. Values are strings so series identity is unambiguous. */
export type MetricLabels = Readonly<Record<string, string>>;

/** Options shared by the metric write methods. */
export type MetricOptions = {
  readonly labels?: MetricLabels;
};

/** Options for {@link Metrics.counter}. */
export type CounterOptions = MetricOptions & {
  /** Amount to add; defaults to `1`. Must be finite. */
  readonly amount?: number;
};

/** A counter series in a snapshot. */
export type CounterSample = {
  readonly name: string;
  readonly kind: "counter";
  readonly labels: MetricLabels;
  readonly value: number;
};

/** A histogram series in a snapshot. */
export type HistogramSample = {
  readonly name: string;
  readonly kind: "histogram";
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
};

/** Any metric series in a snapshot. */
export type MetricSample = CounterSample | HistogramSample;

/** A sorted, decoupled view of a metrics registry. */
export type MetricsSnapshot = {
  readonly counters: readonly CounterSample[];
  readonly histograms: readonly HistogramSample[];
};

/** The mutable metrics registry handle returned by {@link createMetrics}. */
export type Metrics = {
  /** Add `amount` (default 1) to the counter series. Requires a finite amount. */
  counter(name: string, options?: CounterOptions): void;
  /** Record one observation into the histogram series. Requires a finite value. */
  histogram(name: string, value: number, options?: MetricOptions): void;
  /** A fresh, sorted, decoupled snapshot of the current state. */
  snapshot(): MetricsSnapshot;
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function normalizeLabels(labels: MetricLabels | undefined): {
  key: string;
  values: Record<string, string>;
} {
  const names = Object.keys(labels ?? {}).sort(compareStrings);
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = (labels as Readonly<Record<string, unknown>>)[name];
    if (typeof value !== "string") {
      throw new Error(`metric label ${JSON.stringify(name)} must be a string`);
    }
    values[name] = value;
  }
  return { key: labelKey(values), values };
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort(compareStrings)
    .map((name) => `${name}\u0001${labels[name]}`)
    .join("\u0002");
}

function compareSamples(a: MetricSample, b: MetricSample): number {
  const byName = compareStrings(a.name, b.name);
  if (byName !== 0) return byName;
  return compareStrings(labelKey(a.labels), labelKey(b.labels));
}

type CounterState = { name: string; labels: MetricLabels; value: number };
type HistogramState = {
  name: string;
  labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
};

/** Create a fresh in-memory metrics registry. */
export function createMetrics(): Metrics {
  const counters = new Map<string, CounterState>();
  const histograms = new Map<string, HistogramState>();

  return {
    counter(name, options = {}) {
      const amount = options.amount ?? 1;
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        throw new Error(`counter ${JSON.stringify(name)} amount must be a finite number`);
      }
      const { key, values } = normalizeLabels(options.labels);
      const seriesKey = `${name}\u0000${key}`;
      const existing = counters.get(seriesKey);
      if (existing) {
        existing.value += amount;
      } else {
        counters.set(seriesKey, { name, labels: values, value: amount });
      }
    },

    histogram(name, value, options = {}) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`histogram ${JSON.stringify(name)} value must be a finite number`);
      }
      const { key, values } = normalizeLabels(options.labels);
      const seriesKey = `${name}\u0000${key}`;
      const existing = histograms.get(seriesKey);
      if (existing) {
        existing.count += 1;
        existing.sum += value;
        if (value < existing.min) existing.min = value;
        if (value > existing.max) existing.max = value;
      } else {
        histograms.set(seriesKey, { name, labels: values, count: 1, sum: value, min: value, max: value });
      }
    },

    snapshot() {
      const counterSamples: CounterSample[] = [...counters.values()]
        .map((state) => ({
          name: state.name,
          kind: "counter" as const,
          labels: { ...state.labels },
          value: state.value,
        }))
        .sort(compareSamples);
      const histogramSamples: HistogramSample[] = [...histograms.values()]
        .map((state) => ({
          name: state.name,
          kind: "histogram" as const,
          labels: { ...state.labels },
          count: state.count,
          sum: state.sum,
          min: state.min,
          max: state.max,
          avg: state.count === 0 ? Number.NaN : state.sum / state.count,
        }))
        .sort(compareSamples);
      return { counters: counterSamples, histograms: histogramSamples };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Percentiles                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Percentiles of `values` at the requested ranks, using linear interpolation
 * between closest ranks (the R-7 / "linear" method, as used by NumPy). Results
 * align with `ps`; non-finite inputs are ignored; an empty series yields `NaN`
 * for every rank. Ranks outside `[0, 100]` (or non-finite) throw.
 */
export function percentiles(values: readonly number[], ps: readonly number[]): number[] {
  const clean = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);

  return ps.map((p) => {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new Error(`percentile must be a finite number in [0, 100], got ${String(p)}`);
    }
    if (clean.length === 0) return Number.NaN;
    if (clean.length === 1) return clean[0];
    const rank = (p / 100) * (clean.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return clean[lower];
    const weight = rank - lower;
    return clean[lower] + (clean[upper] - clean[lower]) * weight;
  });
}
