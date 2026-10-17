import { describe, expect, it } from "vitest";
import {
  EMAIL_MARKER,
  MAX_MESSAGE_LENGTH,
  MAX_SAMPLE_IDS,
  MAX_STACK_LENGTH,
  PATH_MARKER,
  REDACTED,
  SEVERITY_MEDIUM_AT,
  UNKNOWN_MESSAGE,
  buildReport,
  fingerprint,
  groupErrors,
  normalizeError,
  redactMessage,
  shouldSample,
  toBreadcrumb,
  type Breadcrumb,
  type ErrorEvent,
  type ErrorGroup,
  type ErrorReport,
  type NormalizedError,
} from "./error-tracking";

/**
 * Error tracking engine (§17 "Error tracking") — red-first.
 *
 * `src/lib/error-tracking.ts` did not exist when this file was written, so the
 * suite starts red (module-not-found,  "Red-first").
 *
 * This is the framework-free engine behind the error-tracking panel. It turns a
 * thrown value into a stable shape together with a sampling decision, grouping
 * and triage report. No Prisma, no React, no network, no ambient clock or RNG:
 * the unit sandbox is the whole harness.
 *
 * Contract pinned here:
 *  - every helper is total: it returns a value for ANY input (strings, plain
 *    objects, `null`, circular records, hostile throwing getters) and never
 *    throws;
 *  - `normalizeError` yields `{ name, message, stack?, code?, cause? }`, never
 *    invents absent keys and never returns an empty message;
 *  - `fingerprint` is stable across volatile ids and source line numbers, yet
 *    separates different messages, routes and actions;
 *  - `shouldSample` is a pure, deterministic bucket comparison (no RNG);
 *  - `groupErrors` folds repeats by fingerprint with `count`, `firstSeen`,
 *    `lastSeen` and sample ids;
 *  - `redactMessage` strips emails, credentials and file-system paths;
 *  - `buildReport` derives a severity from the group's event count;
 *  - `toBreadcrumb` produces a redacted, serialisable breadcrumb.
 */
describe("normalizeError", () => {
  it("extracts name, message and stack from an Error", () => {
    const result = normalizeError(new Error("boom"));
    expect(result).toMatchObject({ name: "Error", message: "boom" });
    expect(typeof result.stack).toBe("string");
  });

  it("preserves a subclass name", () => {
    class ValidationError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ValidationError";
      }
    }
    const result = normalizeError(new ValidationError("bad field"));
    expect(result.name).toBe("ValidationError");
    expect(result.message).toBe("bad field");
  });

  it("captures a numeric or string code", () => {
    const numeric = Object.assign(new Error("syscall"), { code: "ENOENT" });
    expect(normalizeError(numeric).code).toBe("ENOENT");
    const asNumber = Object.assign(new Error("http"), { code: 503 });
    expect(normalizeError(asNumber).code).toBe("503");
  });

  it("flattens a nested cause to its message", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    expect(normalizeError(error).cause).toBe("inner");
  });

  it("omits stack, code and cause keys when absent", () => {
    expect(normalizeError("just a string")).toEqual({
      name: "Error",
      message: "just a string",
    });
  });

  it("handles a bare string, including a blank one", () => {
    expect(normalizeError("network down")).toEqual({
      name: "Error",
      message: "network down",
    });
    expect(normalizeError("   ").message).toBe("Error");
  });

  it("coerces primitives and symbols", () => {
    expect(normalizeError(42)).toEqual({ name: "Error", message: "42" });
    expect(normalizeError(Symbol("s"))).toEqual({
      name: "Error",
      message: "Symbol(s)",
    });
    expect(normalizeError(false)).toEqual({ name: "Error", message: "false" });
  });

  it("maps null and undefined to a stable unknown message", () => {
    expect(normalizeError(null)).toEqual({
      name: "Error",
      message: UNKNOWN_MESSAGE,
    });
    expect(normalizeError(undefined)).toEqual({
      name: "Error",
      message: UNKNOWN_MESSAGE,
    });
  });

  it("reads name and message off a plain record", () => {
    expect(normalizeError({ name: "FetchError", message: "offline" })).toEqual({
      name: "FetchError",
      message: "offline",
    });
  });

  it("JSON-stringifies a non-error record", () => {
    expect(normalizeError({ code: 5 }).message).toBe('{"code":5}');
  });

  it("falls back to the resolved name when the message is blank", () => {
    expect(normalizeError(new Error("")).message).toBe("Error");
    expect(normalizeError({ name: "Oops", message: "  " }).message).toBe("Oops");
  });

  it("survives a circular record", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(normalizeError(cyclic).message).toBe("[unserializable object]");
  });

  it("survives a throwing property getter", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "name", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(() => normalizeError(hostile)).not.toThrow();
    expect(normalizeError(hostile).message).toBe("[unserializable object]");
  });

  it("does not recurse forever on a self-referential cause", () => {
    const error = new Error("looping");
    (error as Error & { cause?: unknown }).cause = error;
    expect(() => normalizeError(error)).not.toThrow();
    expect(normalizeError(error).name).toBe("Error");
  });

  it("truncates an over-long message and stack", () => {
    const long = normalizeError("x".repeat(MAX_MESSAGE_LENGTH + 500));
    expect(long.message.length).toBe(MAX_MESSAGE_LENGTH + 1);
    expect(long.message.endsWith("\u2026")).toBe(true);

    const error = new Error("m");
    error.stack = "s".repeat(MAX_STACK_LENGTH + 500);
    const stack = normalizeError(error).stack ?? "";
    expect(stack.length).toBe(MAX_STACK_LENGTH + 1);
  });
});

describe("fingerprint", () => {
  it("returns a stable, prefixed hash", () => {
    const fp = fingerprint(new Error("boom"));
    expect(typeof fp).toBe("string");
    expect(fp.startsWith("fp_")).toBe(true);
    expect(fingerprint(new Error("boom"))).toBe(fp);
  });

  it("ignores volatile uuid and hex ids", () => {
    const first = fingerprint(
      new Error("failed for 550e8400-e29b-41d4-a716-446655440000"),
    );
    const second = fingerprint(
      new Error("failed for 123e4567-e89b-12d3-a456-426614174000"),
    );
    expect(first).toBe(second);

    const hexA = fingerprint(new Error("req abcdef123456 died"));
    const hexB = fingerprint(new Error("req fedcba654321 died"));
    expect(hexA).toBe(hexB);
  });

  it("ignores numeric id and line-number churn", () => {
    expect(fingerprint(new Error("timeout after 1500 ms"))).toBe(
      fingerprint(new Error("timeout after 99999 ms")),
    );
    expect(fingerprint(new Error("boom at app.ts:12:5"))).toBe(
      fingerprint(new Error("boom at app.ts:99:1")),
    );
  });

  it("separates different names and messages", () => {
    expect(fingerprint(new Error("a"))).not.toBe(fingerprint(new Error("b")));
    expect(fingerprint({ name: "FetchError", message: "a" })).not.toBe(
      fingerprint(new Error("a")),
    );
  });

  it("folds route and action into the hash", () => {
    const base = fingerprint(new Error("boom"));
    expect(fingerprint(new Error("boom"), { route: "/w/a" })).not.toBe(base);
    expect(
      fingerprint(new Error("boom"), { route: "/w/a", action: "save" }),
    ).not.toBe(fingerprint(new Error("boom"), { route: "/w/a" }));
  });

  it("never throws for non-error input", () => {
    expect(() => fingerprint(null)).not.toThrow();
    expect(() => fingerprint(undefined)).not.toThrow();
    expect(() => fingerprint("plain")).not.toThrow();
    expect(typeof fingerprint(null)).toBe("string");
  });
});

describe("shouldSample", () => {
  it("captures every fingerprint at rate 1 and none at rate 0", () => {
    expect(shouldSample("fp_abc", 1)).toBe(true);
    expect(shouldSample("fp_abc", 0)).toBe(false);
  });

  it("is deterministic for the same fingerprint and rate", () => {
    const first = shouldSample("fp_stable", 0.5);
    expect(shouldSample("fp_stable", 0.5)).toBe(first);
  });

  it("is monotonic in the rate", () => {
    for (let i = 0; i < 200; i++) {
      const fp = fingerprint(new Error(`boom-${i}`));
      if (shouldSample(fp, 0.3)) {
        expect(shouldSample(fp, 0.7)).toBe(true);
      }
    }
  });

  it("clamps out-of-range and non-finite rates", () => {
    expect(shouldSample("fp_x", -3)).toBe(false);
    expect(shouldSample("fp_x", 4)).toBe(true);
    expect(shouldSample("fp_x", Number.NaN)).toBe(false);
  });

  it("splits a population roughly evenly at rate 0.5", () => {
    let captured = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldSample(`fp_bucket_${i}`, 0.5)) captured += 1;
    }
    expect(captured).toBeGreaterThan(200);
    expect(captured).toBeLessThan(800);
  });
});

describe("groupErrors", () => {
  const event = (overrides: Partial<ErrorEvent> = {}): ErrorEvent => ({
    error: new Error("boom"),
    ...overrides,
  });

  it("returns an empty array for no events", () => {
    expect(groupErrors([])).toEqual([]);
  });

  it("folds the same fingerprinted error into one group", () => {
    const groups = groupErrors([
      event({ id: "e1", error: new Error("boom"), timestamp: 100 }),
      event({ id: "e2", error: new Error("boom"), timestamp: 300 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.firstSeen).toBe(100);
    expect(groups[0]?.lastSeen).toBe(300);
    expect(groups[0]?.sampleIds).toEqual(["e1", "e2"]);
  });

  it("groups by fingerprint even as volatile ids change", () => {
    const groups = groupErrors([
      event({ id: "a", error: new Error("failed for id 1001") }),
      event({ id: "b", error: new Error("failed for id 2002") }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
  });

  it("separates distinct fingerprints", () => {
    const groups = groupErrors([
      event({ error: new Error("alpha") }),
      event({ error: new Error("beta") }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps one group per explicit fingerprint override", () => {
    const groups = groupErrors([
      event({ id: "x", fingerprint: "fp_custom" }),
      event({ id: "y", fingerprint: "fp_custom" }),
      event({ id: "z", error: new Error("other") }),
    ]);
    expect(groups).toHaveLength(2);
    const custom = groups.find((g) => g.fingerprint === "fp_custom");
    expect(custom?.count).toBe(2);
  });

  it("caps the sample ids it retains", () => {
    const events = Array.from({ length: MAX_SAMPLE_IDS + 3 }, (_, index) =>
      event({ id: `e${index}` }),
    );
    const groups = groupErrors(events);
    expect(groups[0]?.sampleIds).toHaveLength(MAX_SAMPLE_IDS);
    expect(groups[0]?.sampleIds[0]).toBe("e0");
  });

  it("carries representative name, message, route and action", () => {
    const groups = groupErrors([
      event({
        id: "e1",
        error: Object.assign(new Error("nope"), { name: "FetchError" }),
        route: "/w/demo",
        action: "load",
        timestamp: 5,
      }),
    ]);
    expect(groups[0]).toMatchObject({
      name: "FetchError",
      message: "nope",
      route: "/w/demo",
      action: "load",
    });
  });

  it("orders groups by count descending", () => {
    const groups = groupErrors([
      event({ id: "a1", error: new Error("rare") }),
      event({ id: "b1", error: new Error("common") }),
      event({ id: "b2", error: new Error("common") }),
      event({ id: "b3", error: new Error("common") }),
    ]);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.message ?? groups[0]?.name).toBeTruthy();
  });

  it("treats a missing timestamp as zero", () => {
    const groups = groupErrors([event({ id: "e1" })]);
    expect(groups[0]?.firstSeen).toBe(0);
    expect(groups[0]?.lastSeen).toBe(0);
  });
});

describe("redactMessage", () => {
  it("masks email addresses", () => {
    expect(redactMessage("contact ada@example.com now")).toBe(
      `contact ${EMAIL_MARKER} now`,
    );
  });

  it("masks bearer, jwt and vendor tokens", () => {
    expect(redactMessage("auth failed for Bearer abcdefgh12345678")).toContain(
      `Bearer ${REDACTED}`,
    );
    expect(redactMessage("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln")).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9",
    );
    expect(redactMessage("key sk-live-abcdefghijklmno")).not.toContain(
      "abcdefghijklmno",
    );
    expect(redactMessage("pat ghp_abcdefghijklmnopqrstuvwxyz01")).toContain(
      REDACTED,
    );
    expect(redactMessage("slack xoxb-123456789012-abcdefghijkl")).toContain(
      REDACTED,
    );
    expect(redactMessage("aws AKIAIOSFODNN7EXAMPLE")).toContain(REDACTED);
  });

  it("masks credential query parameters but keeps the name", () => {
    expect(redactMessage("https://x.test/cb?token=deadbeefcafe&next=/home")).toBe(
      `https://x.test/cb?token=${REDACTED}&next=/home`,
    );
  });

  it("masks unix and windows file paths", () => {
    const unix = redactMessage("crashed at /home/ada/project/src/app.ts:1:1");
    expect(unix).toContain(PATH_MARKER);
    expect(unix).not.toContain("/home/ada");
    const windows = redactMessage("opened C:\\Users\\Ada\\secret.txt");
    expect(windows).toContain(PATH_MARKER);
    expect(windows).not.toContain("secret.txt");
  });

  it("leaves ordinary text untouched and is idempotent", () => {
    expect(redactMessage("all clear")).toBe("all clear");
    const once = redactMessage("contact ada@example.com at /home/ada/x.ts");
    expect(redactMessage(once)).toBe(once);
  });

  it("handles an empty message", () => {
    expect(redactMessage("")).toBe("");
  });
});

describe("buildReport", () => {
  const group = (overrides: Partial<ErrorGroup> = {}): ErrorGroup => ({
    fingerprint: "fp_report",
    count: 1,
    firstSeen: 10,
    lastSeen: 20,
    sampleIds: ["e1"],
    name: "Error",
    message: "boom",
    ...overrides,
  });

  it("carries the group's identity and timing", () => {
    const report = buildReport(group());
    expect(report.fingerprint).toBe("fp_report");
    expect(report.count).toBe(1);
    expect(report.firstSeen).toBe(10);
    expect(report.lastSeen).toBe(20);
    expect(report.sampleIds).toEqual(["e1"]);
  });

  it("derives severity from the event count", () => {
    expect(buildReport(group({ count: 1 })).severity).toBe("low");
    expect(buildReport(group({ count: SEVERITY_MEDIUM_AT })).severity).toBe(
      "medium",
    );
    expect(buildReport(group({ count: 50 })).severity).toBe("high");
    expect(buildReport(group({ count: 500 })).severity).toBe("critical");
  });

  it("redacts contacts and tokens in the title", () => {
    const report = buildReport(
      group({ message: "mail ada@example.com failed for Bearer sekret123" }),
    );
    expect(report.title).not.toContain("ada@example.com");
    expect(report.title).not.toContain("sekret123");
    expect(report.title).toContain(EMAIL_MARKER);
  });

  it("folds name, fingerprint and count into the title", () => {
    const report = buildReport(
      group({ name: "FetchError", message: "offline", count: 7 }),
    );
    expect(report.title).toContain("FetchError");
    expect(report.title).toContain("offline");
    expect(report.title).toContain("7");
  });
});

describe("toBreadcrumb", () => {
  const event = (overrides: Partial<ErrorEvent> = {}): ErrorEvent => ({
    error: new Error("boom"),
    ...overrides,
  });

  it("produces an error-category breadcrumb", () => {
    const crumb = toBreadcrumb(event({ timestamp: 42 }));
    expect(crumb.category).toBe("error");
    expect(crumb.level).toBe("error");
    expect(crumb.timestamp).toBe(42);
  });

  it("redacts the breadcrumb message", () => {
    const crumb = toBreadcrumb(
      event({ error: new Error("mail ada@example.com") }),
    );
    expect(crumb.message).toContain(EMAIL_MARKER);
    expect(crumb.message).not.toContain("ada@example.com");
  });

  it("carries route, action and fingerprint in data", () => {
    const crumb = toBreadcrumb(
      event({ route: "/w/demo", action: "save", fingerprint: "fp_here" }),
    );
    expect(crumb.data).toEqual({
      fingerprint: "fp_here",
      route: "/w/demo",
      action: "save",
    });
  });

  it("defaults a missing timestamp to zero and never throws", () => {
    expect(toBreadcrumb(event()).timestamp).toBe(0);
    expect(() => toBreadcrumb({ error: null })).not.toThrow();
  });
});

// A compile-time guard that the public surface stays additive and typed.
const _typeCheck: [NormalizedError, ErrorGroup, ErrorReport, Breadcrumb] = [
  { name: "Error", message: "m" },
  {
    fingerprint: "fp",
    count: 1,
    firstSeen: 0,
    lastSeen: 0,
    sampleIds: [],
    name: "Error",
    message: "m",
  },
  buildReport({
    fingerprint: "fp",
    count: 1,
    firstSeen: 0,
    lastSeen: 0,
    sampleIds: [],
    name: "Error",
    message: "m",
  }),
  toBreadcrumb({ error: new Error("m") }),
];
void _typeCheck;
