import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUCKETS,
  createMetricsRegistry,
  toPrometheusText,
  type HistogramMetric,
  type Metric,
} from "@/lib/metrics";

/** Narrow a union member to its histogram shape (throws when the tag is wrong). */
function asHistogram(metric: Metric | undefined): HistogramMetric {
  if (!metric || metric.kind !== "histogram") throw new Error("expected a histogram metric");
  return metric;
}

describe("createMetricsRegistry — counters", () => {
  it("starts empty", () => {
    const reg = createMetricsRegistry();
    expect(reg.snapshot()).toEqual({ families: [] });
    expect(reg.toPrometheusText()).toBe("");
  });

  it("increments by one by default and accumulates explicit amounts", () => {
    const reg = createMetricsRegistry();
    reg.increment("http_requests_total");
    reg.increment("http_requests_total");
    reg.increment("http_requests_total", 3);
    expect(reg.snapshot()).toEqual({
      families: [
        {
          name: "http_requests_total",
          kind: "counter",
          metrics: [{ kind: "counter", labels: {}, value: 5 }],
        },
      ],
    });
  });

  it("keys series by their label set", () => {
    const reg = createMetricsRegistry();
    reg.increment("requests", 1, { route: "/a" });
    reg.increment("requests", 2, { route: "/b" });
    const metrics = reg.snapshot().families[0].metrics;
    expect(metrics).toHaveLength(2);
    expect(metrics.map((m) => m.labels.route)).toEqual(["/a", "/b"]);
    expect(metrics.map((m) => (m.kind === "counter" ? m.value : -1))).toEqual([1, 2]);
  });

  it("rejects non-finite amounts", () => {
    const reg = createMetricsRegistry();
    expect(() => reg.increment("m", Number.NaN)).toThrow(/amount/i);
    expect(() => reg.increment("m", Number.POSITIVE_INFINITY)).toThrow(/amount/i);
  });
});

describe("createMetricsRegistry — gauges", () => {
  it("sets a value rather than accumulating", () => {
    const reg = createMetricsRegistry();
    reg.gauge("queue_depth", 3);
    reg.gauge("queue_depth", 7);
    reg.gauge("queue_depth", 5);
    expect(reg.snapshot().families[0].metrics[0]).toEqual({
      kind: "gauge",
      labels: {},
      value: 5,
    });
  });

  it("keys series by their label set", () => {
    const reg = createMetricsRegistry();
    reg.gauge("pool_size", 4, { pool: "read" });
    reg.gauge("pool_size", 9, { pool: "write" });
    const metrics = reg.snapshot().families[0].metrics;
    expect(metrics.map((m) => (m.kind === "gauge" ? m.value : -1))).toEqual([4, 9]);
  });

  it("carries non-finite values through to the snapshot", () => {
    const reg = createMetricsRegistry();
    reg.gauge("a_temperature", Number.NaN);
    reg.gauge("b_capacity", Number.POSITIVE_INFINITY);
    const values = reg.snapshot().families.map((family) =>
      family.metrics[0].kind === "gauge" ? family.metrics[0].value : 0,
    );
    expect(values[0]).toBeNaN();
    expect(values[1]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("createMetricsRegistry — histograms", () => {
  it("counts observations, sums values, and cumulates buckets", () => {
    const reg = createMetricsRegistry({ buckets: [0.5, 1] });
    reg.observe("latency_seconds", 0.3);
    reg.observe("latency_seconds", 0.7);
    reg.observe("latency_seconds", 2);
    expect(reg.snapshot()).toEqual({
      families: [
        {
          name: "latency_seconds",
          kind: "histogram",
          metrics: [
            {
              kind: "histogram",
              labels: {},
              buckets: [0.5, 1],
              counts: [1, 2],
              count: 3,
              sum: 3,
            },
          ],
        },
      ],
    });
  });

  it("treats the upper bound as inclusive", () => {
    const reg = createMetricsRegistry({ buckets: [0.5, 1] });
    reg.observe("h", 0.5);
    expect(asHistogram(reg.snapshot().families[0].metrics[0]).counts).toEqual([1, 1]);
  });

  it("uses the default buckets when none are configured", () => {
    const reg = createMetricsRegistry();
    reg.observe("h", 0);
    expect(asHistogram(reg.snapshot().families[0].metrics[0]).buckets).toEqual([
      ...DEFAULT_BUCKETS,
    ]);
  });

  it("normalizes custom buckets by dropping invalid entries, sorting and de-duplicating", () => {
    const reg = createMetricsRegistry({ buckets: [1, Number.NaN, -1, 0.5, 0.5, 0] });
    reg.observe("h", 0.4);
    const metric = asHistogram(reg.snapshot().families[0].metrics[0]);
    expect(metric.buckets).toEqual([0.5, 1]);
    expect(metric.counts).toEqual([1, 1]);
  });

  it("keeps an empty bucket list (only the implicit +Inf bucket)", () => {
    const reg = createMetricsRegistry({ buckets: [] });
    reg.observe("h", 2);
    const metric = asHistogram(reg.snapshot().families[0].metrics[0]);
    expect(metric.buckets).toEqual([]);
    expect(metric.counts).toEqual([]);
    expect(metric.count).toBe(1);
    expect(metric.sum).toBe(2);
  });

  it("rejects non-finite observations", () => {
    const reg = createMetricsRegistry();
    expect(() => reg.observe("h", Number.NaN)).toThrow(/value/i);
    expect(() => reg.observe("h", Number.NEGATIVE_INFINITY)).toThrow(/value/i);
  });
});

describe("snapshot", () => {
  it("sorts families by name and series by their label set", () => {
    const reg = createMetricsRegistry();
    reg.increment("zeta_total", 1);
    reg.increment("alpha_total", 1, { k: "2" });
    reg.increment("alpha_total", 1, { k: "1" });
    const snapshot = reg.snapshot();
    expect(snapshot.families.map((family) => family.name)).toEqual(["alpha_total", "zeta_total"]);
    expect(snapshot.families[0].metrics.map((m) => m.labels.k)).toEqual(["1", "2"]);
  });

  it("returns fresh arrays and label objects decoupled from the registry", () => {
    const reg = createMetricsRegistry();
    reg.increment("c", 1, { k: "v" });
    const first = reg.snapshot();
    const second = reg.snapshot();
    expect(second).toEqual(first);
    expect(second.families).not.toBe(first.families);
    second.families.length = 0;
    expect(reg.snapshot().families).toHaveLength(1);
    expect(reg.snapshot().families[0].metrics[0].labels).not.toBe(
      reg.snapshot().families[0].metrics[0].labels,
    );
  });
});

describe("createMetricsRegistry — validation", () => {
  it("rejects invalid metric names", () => {
    const reg = createMetricsRegistry();
    for (const bad of ["", "1abc", "has space", "a-b", "a.b", "a" + "\n" + "b"]) {
      expect(() => reg.increment(bad)).toThrow(/metric name/i);
    }
    expect(() => reg.increment("ns:a_b:c9", 1)).not.toThrow();
  });

  it("rejects invalid label names", () => {
    const reg = createMetricsRegistry();
    expect(() => reg.increment("m", 1, { "1bad": "x" })).toThrow(/label name/i);
    expect(() => reg.increment("m", 1, { "has-dash": "x" })).toThrow(/label name/i);
  });

  it("rejects non-string label values", () => {
    const reg = createMetricsRegistry();
    expect(() => reg.increment("m", 1, { n: 3 as unknown as string })).toThrow(/label value/i);
  });

  it("rejects reusing a name with a different kind", () => {
    const reg = createMetricsRegistry();
    reg.increment("dup", 1);
    expect(() => reg.gauge("dup", 1)).toThrow(/kind/i);
    expect(() => reg.observe("dup", 1)).toThrow(/kind/i);
  });

  it("rejects inconsistent label names within a metric", () => {
    const reg = createMetricsRegistry();
    reg.increment("m", 1, { a: "1" });
    expect(() => reg.increment("m", 1, { b: "2" })).toThrow(/label names/i);
  });
});

describe("toPrometheusText", () => {
  it("emits a TYPE line and a labelled sample for counters", () => {
    const reg = createMetricsRegistry();
    reg.increment("http_requests_total", 5, { method: "GET", status: "200" });
    expect(reg.toPrometheusText()).toBe(
      "# TYPE http_requests_total counter\n" + 'http_requests_total{method="GET",status="200"} 5\n',
    );
  });

  it("omits the braces when a sample has no labels", () => {
    const reg = createMetricsRegistry();
    reg.gauge("up", 1);
    expect(reg.toPrometheusText()).toBe("# TYPE up gauge\nup 1\n");
  });

  it("emits HELP from describe, escaping backslashes and newlines", () => {
    const reg = createMetricsRegistry();
    reg.describe("m", "Line one\nLine \\ two");
    reg.increment("m", 1);
    expect(reg.toPrometheusText()).toBe(
      "# HELP m Line one\\nLine \\\\ two\n" + "# TYPE m counter\nm 1\n",
    );
  });

  it("escapes backslashes, quotes and newlines in label values", () => {
    const reg = createMetricsRegistry();
    reg.increment("m", 1, { note: 'he said "hi"\nand \\ done' });
    expect(reg.toPrometheusText()).toBe(
      "# TYPE m counter\n" + 'm{note="he said \\"hi\\"\\nand \\\\ done"} 1\n',
    );
  });

  it("serializes histograms with buckets, +Inf, sum and count", () => {
    const reg = createMetricsRegistry({ buckets: [0.5, 1] });
    reg.observe("latency_seconds", 0.3);
    reg.observe("latency_seconds", 0.7);
    reg.observe("latency_seconds", 2);
    expect(reg.toPrometheusText()).toBe(
      "# TYPE latency_seconds histogram\n" +
        'latency_seconds_bucket{le="0.5"} 1\n' +
        'latency_seconds_bucket{le="1"} 2\n' +
        'latency_seconds_bucket{le="+Inf"} 3\n' +
        "latency_seconds_sum 3\n" +
        "latency_seconds_count 3\n",
    );
  });

  it("places labels before le and appends them on every histogram line", () => {
    const reg = createMetricsRegistry({ buckets: [1] });
    reg.observe("latency_seconds", 0.5, { method: "GET" });
    expect(reg.toPrometheusText()).toBe(
      "# TYPE latency_seconds histogram\n" +
        'latency_seconds_bucket{method="GET",le="1"} 1\n' +
        'latency_seconds_bucket{method="GET",le="+Inf"} 1\n' +
        'latency_seconds_sum{method="GET"} 0.5\n' +
        'latency_seconds_count{method="GET"} 1\n',
    );
  });

  it("orders families by name and samples by labels, emitting HELP/TYPE once per family", () => {
    const reg = createMetricsRegistry();
    reg.increment("z_total", 1);
    reg.increment("a_total", 1, { k: "b" });
    reg.increment("a_total", 1, { k: "a" });
    reg.describe("a_total", "A total.");
    expect(reg.toPrometheusText()).toBe(
      "# HELP a_total A total.\n" +
        "# TYPE a_total counter\n" +
        'a_total{k="a"} 1\n' +
        'a_total{k="b"} 1\n' +
        "# TYPE z_total counter\n" +
        "z_total 1\n",
    );
  });

  it("formats non-finite gauges and normalizes negative zero", () => {
    const reg = createMetricsRegistry();
    reg.gauge("a", Number.NaN);
    reg.gauge("b", Number.POSITIVE_INFINITY);
    reg.gauge("c", Number.NEGATIVE_INFINITY);
    reg.gauge("d", -0);
    const text = reg.toPrometheusText();
    expect(text).toContain("a NaN");
    expect(text).toContain("b +Inf");
    expect(text).toContain("c -Inf");
    expect(text).toContain("d 0\n");
    expect(text).not.toContain("-0");
  });

  it("returns an empty string for an empty registry", () => {
    expect(toPrometheusText(createMetricsRegistry().snapshot())).toBe("");
  });

  it("is byte-identical across repeated snapshots", () => {
    const reg = createMetricsRegistry({ buckets: [1, 2] });
    reg.observe("h", 0.5, { k: "v" });
    reg.increment("c", 2, { k: "v" });
    expect(toPrometheusText(reg.snapshot())).toBe(toPrometheusText(reg.snapshot()));
  });
});

describe("createMetricsRegistry — reset", () => {
  it("clears every family and the registered help", () => {
    const reg = createMetricsRegistry();
    reg.describe("m", "help");
    reg.increment("m", 1);
    reg.reset();
    expect(reg.snapshot()).toEqual({ families: [] });
    reg.increment("m", 1);
    expect(reg.toPrometheusText()).toBe("# TYPE m counter\nm 1\n");
  });
});
