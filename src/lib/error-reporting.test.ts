import { describe, expect, it } from "vitest";
import {
  CIRCULAR,
  DEFAULT_MAX_DEPTH,
  MAX_DEDUPE_KEY_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
  REDACTED,
  REPORT_SCHEMA_VERSION,
  TRUNCATED,
  buildReport,
  dedupeKey,
  normalizeError,
  redactSecrets,
  sampleRate,
  type ErrorReport,
  type NormalizedError,
} from "./error-reporting";

/**
 * Error tracking (pure half) — red-first.
 *
 * `src/lib/error-reporting.ts` did not exist when this file was first written
 * (module-not-found -> suite red,  "Red-first").
 *
 * This is the framework-free core behind the planned error-tracking panel: it
 * turns whatever was thrown (`Error`, string, object, `null`, a hostile getter
 * or a circular record) into a stable `{ name, message, stack?, digest? }`,
 * scrubs credentials before anything leaves the process, groups repeats under a
 * deterministic dedupe key, and decides sampling without a clock or RNG of its
 * own. No Prisma, no React, no network — the unit sandbox is the harness.
 *
 * Contract pinned here:
 *  - helpers NEVER throw, for any input, including throwing property getters
 *    and proxies;
 *  - `normalizeError` never invents a `stack`/`digest` key and never returns an
 *    empty message (falls back to the resolved name);
 *  - `redactSecrets` is key-based (substring match, intentionally over-broad)
 *    AND value-based (Bearer/Basic/JWT/sk-/ghp_/xox/AKIA/query-param shapes),
 *    safe against cycles and depth blow-ups, and never mutates its input;
 *  - `dedupeKey` ignores stack traces and collapses volatile ids (UUID, long
 *    hex, 3+ digit runs) so one bug is one group;
 *  - `sampleRate` is a pure comparison — same `(rate, rand)` is always the same
 *    boolean and rates are clamped to [0, 1];
 *  - `buildReport` composes all of the above and redacts the error fields too.
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

  it("copies the Next.js digest when present", () => {
    const error = Object.assign(new Error("server render failed"), {
      digest: "abc123",
    });
    expect(normalizeError(error).digest).toBe("abc123");
  });

  it("omits stack and digest keys when absent", () => {
    expect(normalizeError("just a string")).toEqual({
      name: "Error",
      message: "just a string",
    });
  });

  it("coerces a thrown primitive with String()", () => {
    expect(normalizeError(42)).toEqual({ name: "Error", message: "42" });
    expect(normalizeError(Symbol("s"))).toEqual({
      name: "Error",
      message: "Symbol(s)",
    });
  });

  it("maps null and undefined to a stable unknown message", () => {
    expect(normalizeError(null)).toEqual({
      name: "Error",
      message: "Unknown error",
    });
    expect(normalizeError(undefined)).toEqual({
      name: "Error",
      message: "Unknown error",
    });
  });

  it("reads message and name off a plain record", () => {
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
    expect(normalizeError({ name: "Oops", message: "   " }).message).toBe("Oops");
  });

  it("survives a circular record", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(normalizeError(cyclic).message).toBe("[unserializable object]");
  });

  it("survives a throwing property getter and a circular-safe fallback", () => {
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

describe("redactSecrets", () => {
  it("redacts password/token/authorization keys at any depth", () => {
    const redacted = redactSecrets({
      password: "hunter2",
      nested: { access_token: "abc", apiKey: "k" },
      authorization: "Bearer x",
      name: "Ada",
    });
    expect(redacted).toEqual({
      password: REDACTED,
      nested: { access_token: REDACTED, apiKey: REDACTED },
      authorization: REDACTED,
      name: "Ada",
    });
  });

  it("over-redacts by substring, by design", () => {
    expect(redactSecrets({ tokenCount: 3 })).toEqual({
      tokenCount: REDACTED,
    });
  });

  it("honours extra redactKeys", () => {
    const redacted = redactSecrets(
      { ssn: "123-45-6789", city: "Paris" },
      { redactKeys: ["ssn"] },
    );
    expect(redacted).toEqual({ ssn: REDACTED, city: "Paris" });
  });

  it("scrubs credential-shaped string values, not just keys", () => {
    const redacted = redactSecrets({
      note: "auth failed for Bearer abc.def.ghi",
      header: "Basic Zm9vOmJhcg==",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      key: "sk-live-abcdefghijklmno",
      pat: "ghp_abcdefghijklmnopqrstuvwxyz01",
      slack: "xoxb-123456789012-abcdefghijkl",
      aws: "AKIAIOSFODNN7EXAMPLE",
      url: "https://x.test/cb?token=deadbeefcafe&next=/home",
    }) as Record<string, string>;
    for (const value of Object.values(redacted)) {
      expect(value).toContain(REDACTED);
    }
    expect(redacted.note).toContain("Bearer [redacted]");
    expect(redacted.note).not.toContain("abc.def.ghi");
    expect(redacted.url).toContain("token=[redacted]");
    expect(redacted.url).toContain("next=/home");
    expect(redacted.key).not.toContain("abcdefghijklmno");
  });

  it("leaves non-secret strings and primitives untouched", () => {
    expect(redactSecrets("all clear")).toBe("all clear");
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets({ count: 3, ok: false, missing: null })).toEqual({
      count: 3,
      ok: false,
      missing: null,
    });
  });

  it("marks cycles instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic)).toEqual({
      name: "root",
      self: CIRCULAR,
    });
  });

  it("respects a depth cap", () => {
    expect(
      redactSecrets({ a: { b: { c: 1 } } }, { maxDepth: 1 }),
    ).toEqual({ a: { b: TRUNCATED } });
    expect(DEFAULT_MAX_DEPTH).toBeGreaterThan(1);
  });

  it("walks arrays and does not mutate the input", () => {
    const input = { list: [{ password: "p" }, "plain"] };
    const snapshot = JSON.parse(JSON.stringify(input));
    const redacted = redactSecrets(input);
    expect(redacted).toEqual({ list: [{ password: REDACTED }, "plain"] });
    expect(input).toEqual(snapshot);
  });

  it("never throws on a hostile proxy", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("nope");
        },
      },
    );
    expect(() => redactSecrets(hostile)).not.toThrow();
    expect(redactSecrets(hostile)).toBe(REDACTED);
  });
});

describe("dedupeKey", () => {
  it("is identical for equivalent errors and ignores the stack", () => {
    const a = new Error("request failed");
    const b = new Error("request failed");
    b.stack = "at totally/different.ts:1:1";
    expect(dedupeKey(a)).toBe(dedupeKey(b));
    expect(dedupeKey(a)).toBe("Error: request failed");
  });

  it("separates different names and different messages", () => {
    expect(dedupeKey(new Error("a"))).not.toBe(dedupeKey(new Error("b")));
    const named = Object.assign(new Error("a"), { name: "FetchError" });
    expect(dedupeKey(named)).not.toBe(dedupeKey(new Error("a")));
  });

  it("collapses UUIDs, long hex and 3+ digit runs", () => {
    const uuids = [
      "failed for 550e8400-e29b-41d4-a716-446655440000",
      "failed for 123e4567-e89b-12d3-a456-426614174000",
    ];
    expect(dedupeKey(new Error(uuids[0]))).toBe(dedupeKey(new Error(uuids[1])));
    expect(dedupeKey(new Error(uuids[0]))).toBe("Error: failed for <uuid>");

    expect(dedupeKey(new Error("req abc123def456 died"))).toBe(
      "Error: req <hex> died",
    );
    expect(dedupeKey(new Error("timeout after 1500 ms"))).toBe(
      dedupeKey(new Error("timeout after 99999 ms")),
    );
  });

  it("clamps an absurdly long key", () => {
    const key = dedupeKey(new Error("y".repeat(MAX_DEDUPE_KEY_LENGTH + 50)));
    expect(key.length).toBe(MAX_DEDUPE_KEY_LENGTH);
    expect(key.endsWith("\u2026")).toBe(true);
  });

  it("never throws for a non-error value", () => {
    expect(() => dedupeKey(undefined)).not.toThrow();
    expect(dedupeKey(null)).toBe("Error: Unknown error");
  });
});

describe("sampleRate", () => {
  it("returns true for every draw at rate 1", () => {
    expect(sampleRate(1, 0)).toBe(true);
    expect(sampleRate(1, 0.999999)).toBe(true);
  });

  it("returns false for every draw at rate 0", () => {
    expect(sampleRate(0, 0)).toBe(false);
    expect(sampleRate(0, 0.999999)).toBe(false);
  });

  it("compares the draw against the rate", () => {
    expect(sampleRate(0.5, 0.49)).toBe(true);
    expect(sampleRate(0.5, 0.5)).toBe(false);
    expect(sampleRate(0.5, 0.51)).toBe(false);
  });

  it("is deterministic for the same inputs", () => {
    expect(sampleRate(0.25, 0.2)).toBe(sampleRate(0.25, 0.2));
  });

  it("clamps out-of-range and non-finite rates", () => {
    expect(sampleRate(-3, 0)).toBe(false);
    expect(sampleRate(4, 0.99)).toBe(true);
    expect(sampleRate(Number.NaN, 0)).toBe(false);
  });

  it("treats a non-finite draw as a miss", () => {
    expect(sampleRate(0.5, Number.NaN)).toBe(false);
  });
});

describe("buildReport", () => {
  it("composes a schema-versioned report", () => {
    const report = buildReport(new Error("boom"), {
      route: "/w/demo",
      userId: "u1",
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.dedupeKey).toBe("Error: boom");
    expect(report.error).toMatchObject({ name: "Error", message: "boom" });
    expect(report.context).toEqual({ route: "/w/demo", userId: "u1" });
  });

  it("redacts secret context keys", () => {
    const report = buildReport(new Error("x"), {
      token: "abc",
      password: "p",
      route: "/home",
    });
    expect(report.context).toEqual({
      token: REDACTED,
      password: REDACTED,
      route: "/home",
    });
  });

  it("redacts credentials embedded in the error message", () => {
    const report = buildReport(
      new Error("auth failed for Bearer sekret123"),
      {},
    );
    expect(report.error.message).not.toContain("sekret123");
    expect(report.error.message).toContain("[redacted]");
  });

  it("carries the digest through", () => {
    const error = Object.assign(new Error("render failed"), { digest: "d1" });
    expect(buildReport(error, {}).error.digest).toBe("d1");
  });

  it("defaults a missing context to an empty record", () => {
    const report = buildReport(new Error("boom"));
    expect(report.context).toEqual({});
  });

  it("keeps the dedupe key stable across repeat reports", () => {
    const first = buildReport(new Error("same"), {});
    const second = buildReport(new Error("same"), { a: 1 });
    expect(first.dedupeKey).toBe(second.dedupeKey);
  });

  it("never throws for hostile inputs and still yields a typed report", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "message", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    let report: ErrorReport | undefined;
    expect(() => {
      report = buildReport(hostile, undefined);
    }).not.toThrow();
    expect(typeof report?.error.name).toBe("string");
    expect(typeof report?.error.message).toBe("string");
    expect(typeof report?.dedupeKey).toBe("string");
  });

  it("does not mutate the caller's context", () => {
    const context: Record<string, unknown> = { token: "abc", route: "/x" };
    buildReport(new Error("x"), context);
    expect(context).toEqual({ token: "abc", route: "/x" });
  });
});

// A compile-time guard that the public surface stays additive and typed.
const _typeCheck: [NormalizedError, ErrorReport] = [
  { name: "Error", message: "m" },
  { schemaVersion: 1, dedupeKey: "k", error: { name: "Error", message: "m" }, context: {} },
];
void _typeCheck;
