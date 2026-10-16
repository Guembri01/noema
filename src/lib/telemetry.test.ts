import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FLAGS,
  effectiveFlags,
  flagSnapshot,
  log,
  percentileReport,
  prometheusText,
  recentLogs,
  recordCounter,
  recordGauge,
  recordHistogram,
  resetTelemetry,
  snapshot,
} from "@/lib/telemetry";

/*
   Wiring proof for `telemetry.ts`: the pure `observability.ts` /
   `metrics.ts` / `feature-flag-store.ts` cores are reachable and load-bearing
   from one process-wide façade — a bounded logger ring, a counters/histograms
   snapshot with percentiles, the Prometheus exposition (gauges), and the
   effective feature flags.
*/

const prevLogLevel = process.env.LOG_LEVEL;
const FLAG_ENV_VARS = [
  "FLAG_DIAGNOSTICS_ENDPOINT",
  "FLAG_ERROR_REPORTING",
  "FLAG_STRUCTURED_LOGGING",
  "FLAG_METRICS_PERCENTILES",
] as const;
const prevFlagEnv = FLAG_ENV_VARS.map((name) => [name, process.env[name]] as const);

beforeEach(() => {
  delete process.env.LOG_LEVEL;
  for (const name of FLAG_ENV_VARS) delete process.env[name];
  resetTelemetry();
});

afterEach(() => {
  resetTelemetry();
  if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLogLevel;
  for (const [name, value] of prevFlagEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("telemetry logger", () => {
  it("emits a redacted structured record into the bounded ring", () => {
    const record = log("info", "hello", { userId: "u1", token: "secret-value" });
    expect(record).not.toBeNull();
    expect(record).toMatchObject({ level: "info", msg: "hello", userId: "u1" });
    expect(record?.token).toBe("[redacted]");

    const tail = recentLogs(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.msg).toBe("hello");
  });

  it("filters records below the configured level before the sink", () => {
    expect(log("debug", "quiet")).toBeNull();
    expect(recentLogs()).toHaveLength(0);
  });

  it("bounds the ring to the most recent records", () => {
    for (let index = 0; index < 250; index += 1) log("info", `m${index}`);
    const tail = recentLogs(1000);
    expect(tail).toHaveLength(200);
    expect(tail[tail.length - 1]?.msg).toBe("m249");
  });
});

describe("telemetry metrics snapshot", () => {
  it("accumulates counters and histograms into the observability snapshot", () => {
    recordCounter("requests_total", { labels: { route: "/a" } });
    recordCounter("requests_total", { amount: 2, labels: { route: "/a" } });
    recordCounter("requests_total", { labels: { route: "/b" } });
    recordHistogram("latency_ms", 10, { labels: { route: "/a" } });
    recordHistogram("latency_ms", 30, { labels: { route: "/a" } });

    const snap = snapshot();
    const routeA = snap.counters.find(
      (counter) => counter.name === "requests_total" && counter.labels.route === "/a",
    );
    expect(routeA?.value).toBe(3);

    const histogram = snap.histograms.find((entry) => entry.name === "latency_ms");
    expect(histogram?.count).toBe(2);
    expect(histogram?.sum).toBe(40);
    expect(histogram?.min).toBe(10);
    expect(histogram?.max).toBe(30);
    expect(histogram?.avg).toBe(20);
  });

  it("computes percentiles over the recorded observations", () => {
    for (const value of [10, 20, 30, 40, 50]) {
      recordHistogram("p_ms", value, { labels: { route: "/x" } });
    }
    const [series] = percentileReport([50, 95]);
    expect(series?.name).toBe("p_ms");
    expect(series?.labels.route).toBe("/x");
    expect(series?.count).toBe(5);
    expect(series?.percentiles.p50).toBe(30);
    expect(series?.percentiles.p95).toBeCloseTo(48);
  });

  it("exposes gauges through the metrics.ts Prometheus exposition", () => {
    recordGauge("app_uptime_seconds", 42);
    expect(prometheusText()).toContain("app_uptime_seconds 42");
  });

  it("returns decoupled snapshots that later writes do not mutate", () => {
    recordCounter("c_total");
    const first = snapshot();
    recordCounter("c_total");
    expect(first.counters.find((counter) => counter.name === "c_total")?.value).toBe(1);
    expect(snapshot().counters.find((counter) => counter.name === "c_total")?.value).toBe(2);
  });

  it("ignores non-finite histogram observations", () => {
    recordHistogram("bad_ms", Number.NaN);
    expect(snapshot().histograms).toHaveLength(0);
    expect(percentileReport()).toHaveLength(0);
  });
});

describe("telemetry feature flags", () => {
  it("lists every built-in flag, enabled, straight from the registry", () => {
    const flags = effectiveFlags();
    expect(flags.map((flag) => flag.key).sort()).toEqual(
      DEFAULT_FLAGS.map((flag) => flag.key).sort(),
    );
    expect(flags.every((flag) => flag.enabled)).toBe(true);
    expect(flags.every((flag) => flag.source === "flag")).toBe(true);
  });

  it("lets a FLAG_<KEY> environment variable override the registry", () => {
    process.env.FLAG_DIAGNOSTICS_ENDPOINT = "false";
    try {
      const flag = effectiveFlags().find((entry) => entry.key === "diagnostics_endpoint");
      expect(flag?.enabled).toBe(false);
      expect(flag?.source).toBe("env");
    } finally {
      delete process.env.FLAG_DIAGNOSTICS_ENDPOINT;
    }
  });

  it("snapshots the store shape (registry + empty override layers)", () => {
    const snap = flagSnapshot();
    expect(snap.flags.map((flag) => flag.key)).toEqual(DEFAULT_FLAGS.map((flag) => flag.key));
    expect(snap.overrides).toEqual({});
    expect(snap.env).toEqual({});
  });
});
