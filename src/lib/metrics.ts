/**
 * Observability metrics — a pure, in-memory registry of counters, gauges and
 * histograms plus a deterministic Prometheus text-exposition serializer.
 *
 * The registry is the one deliberately stateful piece: callers mutate it with
 * `increment`, `gauge`, `observe` and read it back with `snapshot`. Everything
 * downstream of a snapshot is pure — `toPrometheusText` sorts and renders the
 * snapshot without touching the registry — so two serializations of the same
 * snapshot are byte-identical, and a snapshot is always a fresh, decoupled copy
 * (mutating it never affects the registry). No DB, no routes, no React.
 *
 * Series identity is the *pair* of a metric name and its (sorted) label set, so
 * `requests{route="/a"}` and `requests{route="/b"}` are distinct series while a
 * metric name always maps to exactly one kind and one label-name set. Counters
 * and histogram observations require finite numbers; gauges may hold `NaN` or
 * `±Infinity`, which serialize as `NaN` / `+Inf` / `-Inf`.
 */

/** A series' label set. Values are strings; names are validated on write. */
export type MetricLabels = Readonly<Record<string, string>>;

/** The three metric kinds this registry supports. */
export type MetricKind = "counter" | "gauge" | "histogram";

/** Default histogram bucket upper bounds, in the classic Prometheus shape. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Tuning for a registry; every field is optional. */
export type MetricsConfig = {
  /** Positive, finite histogram upper bounds; sorted and de-duplicated. Defaults to {@link DEFAULT_BUCKETS}. */
  buckets?: readonly number[];
};

/** A counter series: monotonically increasing value for one label set. */
export type CounterMetric = {
  kind: "counter";
  labels: MetricLabels;
  value: number;
};

/** A gauge series: the latest value for one label set. */
export type GaugeMetric = {
  kind: "gauge";
  labels: MetricLabels;
  value: number;
};

/** A histogram series. `counts` are cumulative, aligned with `buckets`. */
export type HistogramMetric = {
  kind: "histogram";
  labels: MetricLabels;
  /** Upper bounds, ascending; the implicit `+Inf` bucket is not listed. */
  buckets: readonly number[];
  /** Cumulative observation counts per bucket (length matches `buckets`). */
  counts: readonly number[];
  /** Total observations (the `+Inf` bucket). */
  count: number;
  /** Sum of all observed values. */
  sum: number;
};

/** Any single time series in a snapshot. */
export type Metric = CounterMetric | GaugeMetric | HistogramMetric;

/** All series sharing a metric name: one kind, one optional help line. */
export type MetricFamily = {
  name: string;
  kind: MetricKind;
  help?: string;
  metrics: Metric[];
};

/** A point-in-time, decoupled view of the whole registry. */
export type MetricsSnapshot = {
  families: MetricFamily[];
};

/** The mutable registry handle returned by {@link createMetricsRegistry}. */
export type MetricsRegistry = {
  /** Add `amount` (default 1) to the counter `name`; requires a finite amount. */
  increment(name: string, amount?: number, labels?: MetricLabels): void;
  /** Set the gauge `name` to `value` (overwriting, not accumulating). */
  gauge(name: string, value: number, labels?: MetricLabels): void;
  /** Record one observation into the histogram `name`; requires a finite value. */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** Attach a HELP line to metric `name` for the exposition output. */
  describe(name: string, help: string): void;
  /** Drop every series and registered help line. */
  reset(): void;
  /** A fresh, sorted, decoupled snapshot of the current state. */
  snapshot(): MetricsSnapshot;
  /** Serialize the current state with {@link toPrometheusText}. */
  toPrometheusText(): string;
};

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function assertMetricName(name: string): void {
  if (typeof name !== "string" || !METRIC_NAME_RE.test(name)) {
    throw new Error(`invalid metric name: ${JSON.stringify(name)}`);
  }
}

function assertLabelName(name: string): void {
  if (!LABEL_NAME_RE.test(name)) {
    throw new Error(`invalid label name: ${JSON.stringify(name)}`);
  }
}

/** Normalize buckets: keep positive finite bounds, de-duplicate, sort ascending. */
function normalizeBuckets(buckets: readonly number[] | undefined): number[] {
  if (buckets === undefined) return [...DEFAULT_BUCKETS];
  const seen = new Set<number>();
  for (const bound of buckets) {
    if (typeof bound === "number" && Number.isFinite(bound) && bound > 0) seen.add(bound);
  }
  return [...seen].sort((a, b) => a - b);
}

type NormalizedLabels = {
  /** Label names, sorted ascending (the canonical name set for the metric). */
  names: string[];
  /** A fresh record with keys in sorted order. */
  values: Record<string, string>;
  /** Deterministic series key over the sorted label set. */
  key: string;
};

/** Validate a label set and produce a canonical, sorted copy plus a series key. */
function normalizeLabels(labels: MetricLabels | undefined): NormalizedLabels {
  const names = Object.keys(labels ?? {}).sort(compareStrings);
  const values: Record<string, string> = {};
  for (const name of names) {
    assertLabelName(name);
    const value = (labels as Readonly<Record<string, unknown>>)[name];
    if (typeof value !== "string") {
      throw new Error(`label value for ${JSON.stringify(name)} must be a string`);
    }
    values[name] = value;
  }
  return {
    names,
    values,
    key: names.map((name) => `${name}\u0001${values[name]}`).join("\u0002"),
  };
}

/** Deterministic key over a label set, used to order samples in the output. */
function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort(compareStrings)
    .map((name) => `${name}\u0001${labels[name]}`)
    .join("\u0002");
}

type CounterState = { kind: "counter"; labels: MetricLabels; value: number };
type GaugeState = { kind: "gauge"; labels: MetricLabels; value: number };
type HistogramState = {
  kind: "histogram";
  labels: MetricLabels;
  buckets: readonly number[];
  /** Non-cumulative per-bucket counts; cumulated in {@link toMetric}. */
  counts: number[];
  count: number;
  sum: number;
};
type SeriesState = CounterState | GaugeState | HistogramState;

type FamilyState = {
  kind: MetricKind;
  /** The metric's fixed label-name set (first writer wins). */
  labelNames: readonly string[];
  series: Map<string, SeriesState>;
};

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** Resolve (and, if needed, create) the family + series slot for a write. */
function resolve(
  families: Map<string, FamilyState>,
  name: string,
  kind: MetricKind,
  labels: MetricLabels | undefined,
): { family: FamilyState; normalized: NormalizedLabels } {
  assertMetricName(name);
  const normalized = normalizeLabels(labels);
  const existing = families.get(name);
  if (!existing) {
    const family: FamilyState = { kind, labelNames: normalized.names, series: new Map() };
    families.set(name, family);
    return { family, normalized };
  }
  if (existing.kind !== kind) {
    throw new Error(
      `metric ${JSON.stringify(name)} kind conflict: registered as ${existing.kind}, cannot use it as ${kind}`,
    );
  }
  if (!sameNames(existing.labelNames, normalized.names)) {
    throw new Error(
      `metric ${JSON.stringify(name)} has inconsistent label names: ` +
        `expected [${existing.labelNames.join(", ")}], got [${normalized.names.join(", ")}]`,
    );
  }
  return { family: existing, normalized };
}

/** Build one snapshot metric from stored state, copying into fresh objects. */
function toMetric(series: SeriesState): Metric {
  if (series.kind === "histogram") {
    const counts: number[] = [];
    let running = 0;
    for (const bucketCount of series.counts) {
      running += bucketCount;
      counts.push(running);
    }
    return {
      kind: "histogram",
      labels: { ...series.labels },
      buckets: [...series.buckets],
      counts,
      count: series.count,
      sum: series.sum,
    };
  }
  if (series.kind === "counter") {
    return { kind: "counter", labels: { ...series.labels }, value: series.value };
  }
  return { kind: "gauge", labels: { ...series.labels }, value: series.value };
}

/** Create a fresh registry, normalizing the histogram bucket configuration. */
export function createMetricsRegistry(config: MetricsConfig = {}): MetricsRegistry {
  const buckets = normalizeBuckets(config.buckets);
  const families = new Map<string, FamilyState>();
  const helpOf = new Map<string, string>();

  function snapshot(): MetricsSnapshot {
    const out: MetricFamily[] = [...families.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([name, family]) => {
        const metrics = [...family.series.entries()]
          .sort(([a], [b]) => compareStrings(a, b))
          .map(([, series]) => toMetric(series));
        const help = helpOf.get(name);
        return help === undefined
          ? { name, kind: family.kind, metrics }
          : { name, kind: family.kind, help, metrics };
      });
    return { families: out };
  }

  return {
    increment(name, amount = 1, labels) {
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        throw new Error(`amount for ${JSON.stringify(name)} must be a finite number`);
      }
      const { family, normalized } = resolve(families, name, "counter", labels);
      const existing = family.series.get(normalized.key);
      if (existing && existing.kind === "counter") {
        existing.value += amount;
        return;
      }
      family.series.set(normalized.key, {
        kind: "counter",
        labels: normalized.values,
        value: amount,
      });
    },

    gauge(name, value, labels) {
      if (typeof value !== "number") {
        throw new Error(`value for ${JSON.stringify(name)} must be a number`);
      }
      const { family, normalized } = resolve(families, name, "gauge", labels);
      const existing = family.series.get(normalized.key);
      if (existing && existing.kind === "gauge") {
        existing.value = value;
        return;
      }
      family.series.set(normalized.key, {
        kind: "gauge",
        labels: normalized.values,
        value,
      });
    },

    observe(name, value, labels) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`value for ${JSON.stringify(name)} must be a finite number`);
      }
      const { family, normalized } = resolve(families, name, "histogram", labels);
      let series = family.series.get(normalized.key);
      if (!series || series.kind !== "histogram") {
        series = {
          kind: "histogram",
          labels: normalized.values,
          buckets: [...buckets],
          counts: buckets.map(() => 0),
          count: 0,
          sum: 0,
        };
        family.series.set(normalized.key, series);
      }
      series.count += 1;
      series.sum += value;
      const index = series.buckets.findIndex((bound) => value <= bound);
      if (index >= 0) series.counts[index] += 1;
    },

    describe(name, help) {
      assertMetricName(name);
      if (typeof help !== "string") {
        throw new Error(`help for ${JSON.stringify(name)} must be a string`);
      }
      helpOf.set(name, help);
    },

    reset() {
      families.clear();
      helpOf.clear();
    },

    snapshot,

    toPrometheusText() {
      return toPrometheusText(snapshot());
    },
  };
}

/** Format a number the way the Prometheus text format expects. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Object.is(value, -0)) return "0";
  return String(value);
}

/** Escape a label value: backslash, double quote and newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Escape HELP text: backslash and newline (quotes are literal there). */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Render `{name="value",…}` with names sorted; `+Inf`/`le` extras come last. */
function labelBlock(labels: MetricLabels, extra?: MetricLabels): string {
  const entries: [string, string][] = Object.keys(labels)
    .sort(compareStrings)
    .map((name) => [name, labels[name]]);
  if (extra) {
    for (const name of Object.keys(extra).sort(compareStrings)) entries.push([name, extra[name]]);
  }
  if (entries.length === 0) return "";
  const body = entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",");
  return `{${body}}`;
}

/** The sample lines for one metric; histograms expand to bucket/sum/count. */
function sampleLines(name: string, metric: Metric): string[] {
  if (metric.kind !== "histogram") {
    return [`${name}${labelBlock(metric.labels)} ${formatValue(metric.value)}`];
  }
  const lines: string[] = [];
  metric.buckets.forEach((bound, index) => {
    lines.push(
      `${name}_bucket${labelBlock(metric.labels, { le: formatValue(bound) })} ${metric.counts[index]}`,
    );
  });
  lines.push(`${name}_bucket${labelBlock(metric.labels, { le: "+Inf" })} ${metric.count}`);
  lines.push(`${name}_sum${labelBlock(metric.labels)} ${formatValue(metric.sum)}`);
  lines.push(`${name}_count${labelBlock(metric.labels)} ${metric.count}`);
  return lines;
}

/**
 * Serialize a snapshot into the Prometheus text exposition format. Families are
 * emitted in ascending name order (HELP before TYPE, each once), samples within
 * a family in ascending label order, and the whole document ends in a newline.
 * An empty snapshot serializes to the empty string.
 */
export function toPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  const families = [...snapshot.families].sort((a, b) => compareStrings(a.name, b.name));
  for (const family of families) {
    if (family.help !== undefined) {
      lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    }
    lines.push(`# TYPE ${family.name} ${family.kind}`);
    const metrics = [...family.metrics].sort((a, b) =>
      compareStrings(labelKey(a.labels), labelKey(b.labels)),
    );
    for (const metric of metrics) lines.push(...sampleLines(family.name, metric));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
