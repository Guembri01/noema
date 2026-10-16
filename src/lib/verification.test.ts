import { describe, expect, it } from "vitest";
import {
  describeVerification,
  isVerified,
  parseVerification,
  toggleVerification,
  validateVerification,
  VERIFICATION_NOTE_MAX,
  type VerificationErrorCode,
  type VerificationValidation,
} from "@/lib/verification";

/* The VERIFICATION cell stores `{ verifiedById, verifiedAt, note? }` (R89.28).
   These fixtures mirror that stored shape, plus the junk an untrusted JSON
   round-trip can actually produce. Every time-dependent call is handed a fixed
   `now` so nothing here reads an ambient clock. */

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const T1 = Date.parse("2026-04-01T09:30:00.000Z");
const ISO0 = new Date(T0).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const stamp = (overrides: Partial<Record<string, unknown>> = {}) => ({
  verifiedById: "u1",
  verifiedAt: ISO0,
  ...overrides,
});

const codes = (result: VerificationValidation): VerificationErrorCode[] =>
  result.ok ? [] : result.errors.map((error) => error.code);

describe("parseVerification", () => {
  it("returns an empty value for anything that is not a plain object", () => {
    expect(parseVerification(null)).toEqual({});
    expect(parseVerification(undefined)).toEqual({});
    expect(parseVerification("u1")).toEqual({});
    expect(parseVerification(42)).toEqual({});
    expect(parseVerification(true)).toEqual({});
    expect(parseVerification([])).toEqual({});
    expect(parseVerification(() => undefined)).toEqual({});
  });

  it("keeps a full stamp and normalises the timestamp to canonical ISO", () => {
    expect(
      parseVerification({
        verifiedById: "u1",
        verifiedAt: "2026-03-01T12:00:00Z",
        note: "looks good",
      }),
    ).toEqual({
      verifiedById: "u1",
      verifiedAt: "2026-03-01T12:00:00.000Z",
      note: "looks good",
    });
  });

  it("normalises a date-only timestamp to midnight UTC", () => {
    expect(parseVerification(stamp({ verifiedAt: "2026-03-01" }))).toEqual({
      verifiedById: "u1",
      verifiedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("trims a padded actor id and drops a blank one", () => {
    expect(parseVerification(stamp({ verifiedById: "  u1  " })).verifiedById).toBe("u1");
    expect(parseVerification(stamp({ verifiedById: "   " }))).toEqual({
      verifiedAt: ISO0,
    });
  });

  it("drops an unparseable timestamp or a non-string one", () => {
    expect(parseVerification(stamp({ verifiedAt: "not-a-date" })).verifiedAt).toBeUndefined();
    expect(parseVerification(stamp({ verifiedAt: 123 })).verifiedAt).toBeUndefined();
    expect(
      parseVerification(stamp({ verifiedAt: new Date(T0) })).verifiedAt,
    ).toBeUndefined();
  });

  it("keeps a real note but drops blank and non-string notes", () => {
    expect(parseVerification(stamp({ note: "hello" })).note).toBe("hello");
    expect(parseVerification(stamp({ note: "   " })).note).toBeUndefined();
    expect(parseVerification(stamp({ note: 7 })).note).toBeUndefined();
  });

  it("treats the canonical cleared shape (explicit nulls) as not verified", () => {
    expect(
      parseVerification({ verifiedById: null, verifiedAt: null }),
    ).toEqual({});
  });

  it("ignores unknown keys and a legacy boolean alias with no actor", () => {
    expect(parseVerification({ verified: true, checked: true, extra: 1 })).toEqual({});
  });

  it("never throws on a circular value", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseVerification(circular)).not.toThrow();
    expect(parseVerification(circular)).toEqual({});
  });
});

describe("isVerified", () => {
  it("is false for an empty or cleared value", () => {
    expect(isVerified({}, { now: T0 })).toBe(false);
    expect(isVerified(null, { now: T0 })).toBe(false);
    expect(
      isVerified({ verifiedById: null, verifiedAt: null }, { now: T0 }),
    ).toBe(false);
  });

  it("is true for a full stamp when no freshness window is given", () => {
    expect(isVerified(stamp(), { now: T0 + 5 * DAY })).toBe(true);
  });

  it("needs both the actor and the timestamp", () => {
    expect(isVerified({ verifiedById: "u1" }, { now: T0 })).toBe(false);
    expect(isVerified({ verifiedAt: ISO0 }, { now: T0 })).toBe(false);
  });

  it("accepts a raw stored value, extra keys and all", () => {
    expect(isVerified({ ...stamp(), extra: "ignored" }, { now: T0 })).toBe(true);
    expect(isVerified("junk", { now: T0 })).toBe(false);
  });

  it("honours maxAgeMs: fresh is verified, aged out is not", () => {
    expect(isVerified(stamp(), { now: T0 + 1000, maxAgeMs: 5000 })).toBe(true);
    expect(isVerified(stamp(), { now: T0 + 5001, maxAgeMs: 5000 })).toBe(false);
  });

  it("counts the exact boundary instant as still fresh", () => {
    expect(isVerified(stamp(), { now: T0, maxAgeMs: 0 })).toBe(true);
    expect(isVerified(stamp(), { now: T0 + 5000, maxAgeMs: 5000 })).toBe(true);
    expect(isVerified(stamp(), { now: T0 + 1, maxAgeMs: 0 })).toBe(false);
  });

  it("treats a future timestamp as fresh", () => {
    expect(
      isVerified({ verifiedById: "u1", verifiedAt: new Date(T0 + DAY).toISOString() }, {
        now: T0,
        maxAgeMs: 1000,
      }),
    ).toBe(true);
  });

  it("treats an unusable window or clock as no limit", () => {
    expect(isVerified(stamp(), { now: T0 + DAY, maxAgeMs: -1 })).toBe(true);
    expect(isVerified(stamp(), { now: T0 + DAY, maxAgeMs: Number.NaN })).toBe(true);
    expect(isVerified(stamp(), { now: Number.NaN, maxAgeMs: 1000 })).toBe(true);
  });
});

describe("toggleVerification", () => {
  it("stamps the session actor at the injected instant", () => {
    expect(toggleVerification({}, { userId: "u1", now: T0 })).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("preserves an existing note when stamping", () => {
    expect(toggleVerification({ note: "checked" }, { userId: "u1", now: T0 })).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
      note: "checked",
    });
  });

  it("clears the stamp pair when the same actor toggles it off, keeping the note", () => {
    expect(
      toggleVerification(
        { ...stamp({ note: "checked" }) },
        { userId: "u1", now: T1 },
      ),
    ).toEqual({ note: "checked" });
  });

  it("refuses to clear a stamp left by a different actor", () => {
    const foreign = stamp();
    expect(toggleVerification(foreign, { userId: "u2", now: T1 })).toEqual(foreign);
    expect(
      toggleVerification(
        { ...stamp({ note: "checked" }) },
        { userId: "u2", now: T1 },
      ),
    ).toEqual({ ...stamp({ note: "checked" }) });
  });

  it("clears an incomplete same-actor stamp but refuses a foreign one", () => {
    expect(
      toggleVerification({ verifiedById: "u1" }, { userId: "u1", now: T1 }),
    ).toEqual({});
    expect(
      toggleVerification({ verifiedById: "u1" }, { userId: "u2", now: T1 }),
    ).toEqual({ verifiedById: "u1" });
  });

  it("refuses to verify without a real session actor", () => {
    expect(toggleVerification({}, { userId: "   ", now: T0 })).toEqual({});
    expect(toggleVerification({ note: "x" }, { userId: "", now: T0 })).toEqual({
      note: "x",
    });
  });

  it("refuses to verify with an unusable instant", () => {
    expect(toggleVerification({}, { userId: "u1", now: Number.NaN })).toEqual({});
  });

  it("round-trips verify -> clear -> verify", () => {
    const verified = toggleVerification({}, { userId: "u1", now: T0 });
    const cleared = toggleVerification(verified, { userId: "u1", now: T1 });
    expect(cleared).toEqual({});
    expect(toggleVerification(cleared, { userId: "u1", now: T1 })).toEqual({
      verifiedById: "u1",
      verifiedAt: new Date(T1).toISOString(),
    });
  });

  it("is deterministic for a fixed clock and differs across clocks", () => {
    expect(toggleVerification({}, { userId: "u1", now: T0 })).toEqual(
      toggleVerification({}, { userId: "u1", now: T0 }),
    );
    expect(toggleVerification({}, { userId: "u1", now: T0 }).verifiedAt).not.toBe(
      toggleVerification({}, { userId: "u1", now: T1 }).verifiedAt,
    );
  });

  it("never mutates its input", () => {
    const input = { note: "keep" };
    toggleVerification(input, { userId: "u1", now: T0 });
    expect(input).toEqual({ note: "keep" });
  });

  it("stamps cleanly from junk input", () => {
    expect(toggleVerification(null, { userId: "u1", now: T0 })).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
    expect(toggleVerification("junk", { userId: "u1", now: T0 })).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });
});

describe("validateVerification", () => {
  it("accepts empty, cleared and full values", () => {
    expect(validateVerification(null).ok).toBe(true);
    expect(validateVerification(undefined).ok).toBe(true);
    expect(validateVerification({}).ok).toBe(true);
    expect(
      validateVerification({ verifiedById: null, verifiedAt: null }).ok,
    ).toBe(true);
    expect(validateVerification(stamp({ note: "ok" })).ok).toBe(true);
  });

  it("ignores unknown extra keys", () => {
    expect(validateVerification({ ...stamp(), extra: "ignored" }).ok).toBe(true);
  });

  it("flags a non-object shape", () => {
    expect(codes(validateVerification("u1"))).toEqual(["INVALID_SHAPE"]);
    expect(codes(validateVerification(42))).toEqual(["INVALID_SHAPE"]);
    expect(codes(validateVerification([]))).toEqual(["INVALID_SHAPE"]);
  });

  it("flags an actor that is neither a non-empty string nor null", () => {
    expect(codes(validateVerification(stamp({ verifiedById: 7 })))).toEqual([
      "INVALID_ACTOR",
    ]);
    expect(codes(validateVerification({ verifiedById: "", verifiedAt: ISO0 }))).toEqual([
      "INVALID_ACTOR",
    ]);
  });

  it("flags an unparseable timestamp", () => {
    expect(codes(validateVerification(stamp({ verifiedAt: "nope" })))).toEqual([
      "INVALID_TIMESTAMP",
    ]);
  });

  it("flags a half stamp as incomplete", () => {
    expect(codes(validateVerification({ verifiedById: "u1" }))).toEqual([
      "INCOMPLETE_STAMP",
    ]);
    expect(codes(validateVerification({ verifiedAt: ISO0 }))).toEqual([
      "INCOMPLETE_STAMP",
    ]);
  });

  it("flags a non-string note and an over-long note", () => {
    expect(codes(validateVerification(stamp({ note: 12 })))).toEqual(["INVALID_NOTE"]);
    expect(
      codes(validateVerification(stamp({ note: "x".repeat(VERIFICATION_NOTE_MAX + 1) }))),
    ).toEqual(["NOTE_TOO_LONG"]);
    expect(
      validateVerification(stamp({ note: "x".repeat(VERIFICATION_NOTE_MAX) })).ok,
    ).toBe(true);
  });

  it("collects every problem it finds", () => {
    const result = validateVerification({
      verifiedById: 7,
      verifiedAt: "nope",
      note: 12,
    });
    expect(codes(result).sort()).toEqual([
      "INVALID_ACTOR",
      "INVALID_NOTE",
      "INVALID_TIMESTAMP",
    ]);
  });

  it("never throws on odd input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateVerification(circular)).not.toThrow();
    expect(validateVerification(circular).ok).toBe(true);
  });
});

describe("describeVerification", () => {
  it("labels empty and junk values as not verified", () => {
    expect(describeVerification({})).toBe("Not verified");
    expect(describeVerification(null)).toBe("Not verified");
    expect(describeVerification("junk")).toBe("Not verified");
    expect(describeVerification({ verifiedById: "u1" })).toBe("Not verified");
  });

  it("renders the actor id and date for a full stamp", () => {
    expect(describeVerification(stamp())).toBe("Verified ✓ · u1 · 2026-03-01");
  });

  it("prefers a supplied actor name, falling back when blank", () => {
    expect(describeVerification(stamp(), { actorName: "Ada Lovelace" })).toBe(
      "Verified ✓ · Ada Lovelace · 2026-03-01",
    );
    expect(describeVerification(stamp(), { actorName: "   " })).toBe(
      "Verified ✓ · u1 · 2026-03-01",
    );
  });

  it("labels an aged-out stamp as stale", () => {
    expect(
      describeVerification(stamp(), { now: T0 + 2 * DAY, maxAgeMs: DAY }),
    ).toBe("Verification stale · u1 · 2026-03-01");
  });

  it("does not call a stamp stale without both now and a window", () => {
    expect(describeVerification(stamp(), { now: T0 + 2 * DAY })).toBe(
      "Verified ✓ · u1 · 2026-03-01",
    );
    expect(describeVerification(stamp(), { maxAgeMs: DAY })).toBe(
      "Verified ✓ · u1 · 2026-03-01",
    );
  });
});
