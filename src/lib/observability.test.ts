import { describe, expect, it, vi } from "vitest";
import {
  CIRCULAR,
  NO_TRACE_ID,
  REDACTED,
  createLogger,
  createMetrics,
  currentTrace,
  isSensitiveKey,
  newSpanId,
  newTraceId,
  percentiles,
  redactValue,
  startSpan,
  withTrace,
  type LogRecord,
} from "./observability";

/**
 * Observability engine (§17 Observability) — red-first.
 *
 * `src/lib/observability.ts` did not exist when this file was first written
 * (module-not-found -> suite red). This is the framework-free heart of the
 * observability slice: a structured logger with redaction + level filtering, a
 * deterministic metrics registry, a trace context / span recorder, and the
 * percentile math used to summarise histograms. No Prisma, no React, no
 * network: the unit sandbox is the harness.
 *
 * Contract pinned here:
 *  - records are `{ ts, level, msg, ...fields, traceId }`, fields flattened and
 *    sensitive keys (`pass*`, `token`, `secret*`, `authorization`, `cookie`)
 *    redacted recursively without mutating the caller's objects;
 *  - level filtering suppresses anything below the configured level (the
 *    filtered call returns `null` and never reaches the sink);
 *  - a span carries `traceId`/`spanId`, picks up the ambient trace/span, and
 *    `end(attrs)` reports a duration from the injected clock;
 *  - `withTrace` scopes an ambient trace for the duration of a function and
 *    restores the previous one;
 *  - `createMetrics().snapshot()` is sorted deterministically (name, then label
 *    key) and is a fresh, decoupled copy;
 *  - `percentiles` uses linear interpolation (R-7), ignores non-finite input and
 *    returns `NaN` for an empty series.
 */

function collect() {
  const out: LogRecord[] = [];
  return { out, sink: (record: LogRecord) => out.push(record) };
}

describe("createLogger: structure", () => {
  it("emits a structured record with ts, level, msg, flattened fields and traceId", () => {
    const { out, sink } = collect();
    const log = createLogger({ sink, now: () => 1000 });

    const record = log.info("hello", { userId: "u1" });

    expect(record).toEqual({ ts: 1000, level: "info", msg: "hello", userId: "u1", traceId: NO_TRACE_ID });
    expect(out).toEqual([record]);
    expect(out[0]).toBe(record);
  });

  it("orders keys as ts, level, msg, ...fields, traceId", () => {
    const { sink } = collect();
    const record = createLogger({ sink, now: () => 1 }).info("m", { a: 1, b: 2 });
    expect(Object.keys(record as object)).toEqual(["ts", "level", "msg", "a", "b", "traceId"]);
  });

  it("reads the clock per call", () => {
    const { sink } = collect();
    let t = 10;
    const log = createLogger({ sink, now: () => t });
    const first = log.info("a");
    t = 20;
    const second = log.info("b");
    expect(first?.ts).toBe(10);
    expect(second?.ts).toBe(20);
  });

  it("merges base fields, letting call fields win", () => {
    const { sink } = collect();
    const log = createLogger({ sink, base: { service: "api", port: 8080 }, now: () => 0 });
    const record = log.info("m", { port: 3000 });
    expect(record).toMatchObject({ service: "api", port: 3000 });
  });

  it("protects reserved keys from base and field override", () => {
    const { sink } = collect();
    const log = createLogger({ sink, base: { level: "nope", msg: "nope", ts: -1 }, now: () => 7 });
    const record = log.info("real", { level: "nope", msg: "nope", ts: -1 });
    expect(record).toMatchObject({ ts: 7, level: "info", msg: "real" });
  });

  it("uses base.traceId when no explicit or ambient trace exists", () => {
    const { sink } = collect();
    const record = createLogger({ sink, base: { traceId: "base-trace" } }).info("m");
    expect(record?.traceId).toBe("base-trace");
  });

  it("lets an explicit field traceId beat base.traceId", () => {
    const { sink } = collect();
    const record = createLogger({ sink, base: { traceId: "base-trace" } }).info("m", { traceId: "field-trace" });
    expect(record?.traceId).toBe("field-trace");
  });
});

describe("createLogger: level filtering", () => {
  it("defaults to info, dropping debug before the sink", () => {
    const { out, sink } = collect();
    const log = createLogger({ sink });
    expect(log.debug("d")).toBeNull();
    expect(out).toHaveLength(0);
  });

  it("emits every level when configured to debug", () => {
    const { out, sink } = collect();
    const log = createLogger({ sink, level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(out.map((r) => r.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("suppresses debug and info at warn level", () => {
    const { out, sink } = collect();
    const log = createLogger({ sink, level: "warn" });
    expect(log.debug("d")).toBeNull();
    expect(log.info("i")).toBeNull();
    expect(log.warn("w")).not.toBeNull();
    expect(log.error("e")).not.toBeNull();
    expect(out.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("only emits error at error level", () => {
    const { out, sink } = collect();
    const log = createLogger({ sink, level: "error" });
    expect(log.debug("d")).toBeNull();
    expect(log.info("i")).toBeNull();
    expect(log.warn("w")).toBeNull();
    expect(log.error("e")).not.toBeNull();
    expect(out.map((r) => r.level)).toEqual(["error"]);
  });
});

describe("redaction", () => {
  it("flags pass*, token, secret*, authorization and cookie keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("passphrase")).toBe(true);
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("secretKey")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("cookie")).toBe(true);
  });

  it("leaves ordinary keys alone", () => {
    expect(isSensitiveKey("username")).toBe(false);
    expect(isSensitiveKey("email")).toBe(false);
    expect(isSensitiveKey("requestId")).toBe(false);
  });

  it("masks the api/private-key names the error reporter masks (B35)", () => {
    // The logger used to carry a narrower list than the error reporter, so
    // `apiKey` and `privateKey` were masked in one place and printed in the
    // other. One list rules both now.
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("privateKey")).toBe(true);
    expect(isSensitiveKey("accessKey")).toBe(true);
    expect(isSensitiveKey("dbUrl")).toBe(true);
    expect(isSensitiveKey("credential")).toBe(true);
    expect(isSensitiveKey("sessionId")).toBe(true);
  });

  it("redacts a secret-shaped field the error reporter masks", () => {
    const { sink } = collect();
    const record = createLogger({ sink }).info("ai call", {
      apiKey: "sk-live-abcdefghijklmnop",
      dbUrl: "postgresql://noema:pw@localhost:5433/noema",
    });
    expect(record).toMatchObject({
      apiKey: REDACTED,
      dbUrl: REDACTED,
    });
  });

  it("honours caller-supplied exact keys", () => {
    expect(isSensitiveKey("ssn", ["ssn"])).toBe(true);
    expect(isSensitiveKey("SSN", ["ssn"])).toBe(true);
    expect(isSensitiveKey("username", ["ssn"])).toBe(false);
  });

  it("redacts sensitive fields on a log record", () => {
    const { sink } = collect();
    const record = createLogger({ sink }).info("login", {
      username: "ada",
      password: "hunter2",
      authorization: "Bearer abc",
      cookie: "sid=1",
    });
    expect(record).toMatchObject({
      username: "ada",
      password: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
    });
  });

  it("redacts nested objects recursively", () => {
    const { sink } = collect();
    const record = createLogger({ sink }).info("m", {
      user: { name: "ada", secretKey: "s3cr3t" },
    });
    expect(record).toMatchObject({ user: { name: "ada", secretKey: REDACTED } });
  });

  it("redacts objects nested inside arrays", () => {
    const { sink } = collect();
    const record = createLogger({ sink }).info("m", {
      items: [{ token: "t1", id: "a" }, { token: "t2", id: "b" }],
    });
    expect(record).toMatchObject({
      items: [{ token: REDACTED, id: "a" }, { token: REDACTED, id: "b" }],
    });
  });

  it("never mutates the caller's field object", () => {
    const { sink } = collect();
    const fields = { nested: { password: "p" }, list: [{ secret: "s" }] };
    createLogger({ sink }).info("m", fields);
    expect(fields.nested.password).toBe("p");
    expect(fields.list[0].secret).toBe("s");
  });

  it("applies caller redactKeys", () => {
    const { sink } = collect();
    const record = createLogger({ sink, redactKeys: ["ssn"] }).info("m", { ssn: "123-45-6789" });
    expect(record?.ssn).toBe(REDACTED);
  });

  it("survives circular references without throwing", () => {
    const { sink } = collect();
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const record = createLogger({ sink }).info("m", { node });
    expect(record).toMatchObject({ node: { name: "root", self: CIRCULAR } });
  });

  it("redactValue returns a fresh structure without mutating its input", () => {
    const input = { password: "p", nested: { token: "t" }, list: [{ secret: "s" }] };
    const output = redactValue(input) as Record<string, unknown>;
    expect(output).toMatchObject({
      password: REDACTED,
      nested: { token: REDACTED },
      list: [{ secret: REDACTED }],
    });
    expect(output).not.toBe(input);
    expect(input.password).toBe("p");
  });
});

describe("spans and trace context", () => {
  it("generates hex ids of a stable shape", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not derive the ids from Math.random (B35)", () => {
    const spy = vi.spyOn(Math, "random");
    try {
      const first = newTraceId();
      const second = newTraceId();
      expect(spy).not.toHaveBeenCalled();
      expect(first).not.toBe(second);
    } finally {
      spy.mockRestore();
    }
  });

  it("records a duration from the injected clock", () => {
    let t = 100;
    const span = startSpan("query", { traceId: "t1", now: () => t });
    t = 350;
    const record = span.end();
    expect(record).toMatchObject({ traceId: "t1", name: "query", startTime: 100, endTime: 350, duration: 250 });
  });

  it("merges start attrs with end attrs, letting end win", () => {
    const span = startSpan("op", { traceId: "t", now: () => 0, attrs: { a: 1, b: 1 } });
    const record = span.end({ b: 2, c: 3 });
    expect(record.attrs).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("is idempotent: end returns the same record on later calls", () => {
    const span = startSpan("op", { traceId: "t", now: () => 5 });
    const first = span.end({ x: 1 });
    const second = span.end({ x: 2 });
    expect(second).toBe(first);
    expect(second.attrs).toEqual({ x: 1 });
  });

  it("links a child span to its parent within one trace", () => {
    const parent = startSpan("parent", { traceId: "t1" });
    const child = startSpan("child", { traceId: parent.traceId, parentId: parent.spanId });
    expect(child.traceId).toBe("t1");
    expect(child.parentId).toBe(parent.spanId);
  });

  it("inherits the ambient trace id inside withTrace", () => {
    withTrace({ traceId: "amb" }, () => {
      expect(startSpan("x").traceId).toBe("amb");
    });
  });

  it("returns the wrapped function's value", () => {
    expect(withTrace({ traceId: "t" }, () => 42)).toBe(42);
  });

  it("restores the previous context after nested scopes", () => {
    expect(currentTrace()).toBeNull();
    withTrace({ traceId: "outer" }, () => {
      expect(currentTrace()?.traceId).toBe("outer");
      withTrace({ traceId: "inner" }, () => {
        expect(currentTrace()?.traceId).toBe("inner");
      });
      expect(currentTrace()?.traceId).toBe("outer");
    });
    expect(currentTrace()).toBeNull();
  });

  it("tags log records with the ambient trace id", () => {
    const { out, sink } = collect();
    withTrace({ traceId: "tr-1" }, () => {
      createLogger({ sink }).info("inside");
    });
    expect(out[0].traceId).toBe("tr-1");
  });
});

describe("createMetrics", () => {
  it("counts increments for a named series", () => {
    const metrics = createMetrics();
    metrics.counter("http_requests");
    metrics.counter("http_requests");
    metrics.counter("http_requests", { amount: 3 });
    const [sample] = metrics.snapshot().counters;
    expect(sample).toEqual({ name: "http_requests", kind: "counter", labels: {}, value: 5 });
  });

  it("keeps distinct label sets as distinct series", () => {
    const metrics = createMetrics();
    metrics.counter("req", { labels: { route: "/a" } });
    metrics.counter("req", { labels: { route: "/b" } });
    metrics.counter("req", { labels: { route: "/a" } });
    const counters = metrics.snapshot().counters;
    expect(counters).toHaveLength(2);
    expect(counters.map((c) => c.value).sort()).toEqual([1, 2]);
  });

  it("aggregates histogram count, sum, min, max and avg", () => {
    const metrics = createMetrics();
    metrics.histogram("latency", 10);
    metrics.histogram("latency", 30);
    metrics.histogram("latency", 20);
    const [sample] = metrics.snapshot().histograms;
    expect(sample).toMatchObject({ name: "latency", kind: "histogram", count: 3, sum: 60, min: 10, max: 30, avg: 20 });
  });

  it("groups histogram observations by label set", () => {
    const metrics = createMetrics();
    metrics.histogram("latency", 5);
    metrics.histogram("latency", 40, { labels: { route: "/a" } });
    const histograms = metrics.snapshot().histograms;
    expect(histograms).toHaveLength(2);
    expect(histograms.map((h) => h.count)).toEqual([1, 1]);
  });

  it("orders the snapshot deterministically regardless of insertion order", () => {
    const a = createMetrics();
    a.counter("http_requests", { labels: { route: "/b", method: "GET" } });
    a.counter("http_requests", { labels: { route: "/a", method: "GET" } });
    a.histogram("latency", 1, { labels: { route: "/b" } });
    a.histogram("latency", 1, { labels: { route: "/a" } });

    const b = createMetrics();
    b.histogram("latency", 1, { labels: { route: "/a" } });
    b.histogram("latency", 1, { labels: { route: "/b" } });
    b.counter("http_requests", { labels: { route: "/a", method: "GET" } });
    b.counter("http_requests", { labels: { route: "/b", method: "GET" } });

    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it("sorts label keys within a sample", () => {
    const metrics = createMetrics();
    metrics.counter("req", { labels: { zeta: "1", alpha: "2" } });
    const [sample] = metrics.snapshot().counters;
    expect(Object.keys(sample.labels)).toEqual(["alpha", "zeta"]);
  });

  it("returns a decoupled copy that later writes do not touch", () => {
    const metrics = createMetrics();
    metrics.counter("early");
    const snapshot = metrics.snapshot();
    metrics.counter("later");
    expect(snapshot.counters.map((c) => c.name)).toEqual(["early"]);
    expect(metrics.snapshot().counters.map((c) => c.name)).toEqual(["early", "later"]);
  });

  it("rejects non-finite histogram observations", () => {
    const metrics = createMetrics();
    expect(() => metrics.histogram("latency", Number.NaN)).toThrow();
    expect(() => metrics.histogram("latency", Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects non-string label values", () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter("req", { labels: { route: 1 as unknown as string } }),
    ).toThrow();
  });
});

describe("percentiles", () => {
  it("computes p50/p95/p99 with linear interpolation", () => {
    const [p50, p95, p99] = percentiles([1, 2, 3, 4], [50, 95, 99]);
    expect(p50).toBeCloseTo(2.5, 10);
    expect(p95).toBeCloseTo(3.85, 10);
    expect(p99).toBeCloseTo(3.97, 10);
  });

  it("returns the min at p0 and the max at p100", () => {
    expect(percentiles([1, 2, 3, 4], [0, 100])).toEqual([1, 4]);
  });

  it("returns the single value for every percentile", () => {
    expect(percentiles([7], [0, 50, 100])).toEqual([7, 7, 7]);
  });

  it("returns NaN for an empty series", () => {
    expect(percentiles([], [50, 95]).every((n) => Number.isNaN(n))).toBe(true);
  });

  it("sorts unsorted input before interpolating", () => {
    expect(percentiles([4, 1, 3, 2], [50])).toEqual([2.5]);
  });

  it("ignores non-finite values", () => {
    expect(percentiles([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 2], [50])).toEqual([2]);
  });

  it("aligns output with the requested percentile order", () => {
    expect(percentiles([10, 20], [100, 0])).toEqual([20, 10]);
  });

  it("rejects percentiles outside [0, 100]", () => {
    expect(() => percentiles([1, 2, 3], [-1])).toThrow();
    expect(() => percentiles([1, 2, 3], [101])).toThrow();
  });
});
