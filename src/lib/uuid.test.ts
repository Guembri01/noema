import { describe, expect, it } from "vitest";
import {
  UUID_V7_MAX_TIMESTAMP,
  isUuid,
  isUuidV7,
  normalizeUuid,
  parseUuid,
  uuidv4,
  uuidv7,
} from "@/lib/uuid";
import type { UuidParseError, UuidParseResult } from "@/lib/uuid";

/**
 * UUID helpers — pure formatting and inspection over Node's `crypto`.
 *
 * Red-first: `src/lib/uuid.ts` did not exist when this file was written.
 * Generation is random except for uuidv7, whose injected timestamp makes the
 * time-ordered prefix deterministic and therefore testable offline. Inspection
 * (`isUuid`, `parseUuid`, `normalizeUuid`, `isUuidV7`) accepts canonical,
 * braced, compact-hex, binary and URN forms, case-insensitively, but only for
 * RFC 4122 UUIDs of versions 1 through 7.
 */

/** Assert a parse failed with a specific reason without losing narrowing. */
function expectError(result: UuidParseResult, error: UuidParseError): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(error);
}

/** A canonical v4 UUID used as a fixture throughout. */
const V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/** A raw 16-byte v7 UUID (version nibble 7, RFC variant). */
const V7_BYTES = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x76, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);

describe("uuidv4", () => {
  it("mints a canonical RFC 4122 v4 UUID", () => {
    const id = uuidv4();
    expect(isUuid(id)).toBe(true);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const parsed = parseUuid(id);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.version).toBe(4);
  });

  it("never repeats across many mintings", () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidv4()));
    expect(ids.size).toBe(200);
  });
});

describe("uuidv7", () => {
  const TS = 0x0123_4567_89ab;

  it("encodes the injected timestamp, version and variant", () => {
    const id = uuidv7(TS);
    expect(id.slice(0, 8)).toBe("01234567");
    expect(id.slice(9, 13)).toBe("89ab");
    expect(id[14]).toBe("7");
    expect(id[19]).toMatch(/[89ab]/);
    expect(isUuidV7(id)).toBe(true);
  });

  it("accepts a Date for the timestamp", () => {
    expect(uuidv7(new Date(TS)).slice(0, 13)).toBe(uuidv7(TS).slice(0, 13));
  });

  it("is time-ordered by the injected timestamp", () => {
    expect(uuidv7(1_000) < uuidv7(2_000_000)).toBe(true);
  });

  it("handles the zero and maximum timestamps", () => {
    expect(uuidv7(0).slice(0, 13)).toBe("00000000-0000");
    expect(isUuidV7(uuidv7(UUID_V7_MAX_TIMESTAMP))).toBe(true);
  });

  it("rejects timestamps outside the 48-bit millisecond range", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(UUID_V7_MAX_TIMESTAMP + 1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
    expect(() => uuidv7(Number.NaN)).toThrow(RangeError);
    expect(() => uuidv7(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("stays unique for a fixed timestamp", () => {
    const ids = new Set(Array.from({ length: 50 }, () => uuidv7(TS)));
    expect(ids.size).toBe(50);
  });
});

describe("isUuid", () => {
  it("accepts canonical, braced, compact, binary and URN forms, any case", () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V4.toUpperCase())).toBe(true);
    expect(isUuid(`{${V4}}`)).toBe(true);
    expect(isUuid(V4.replace(/-/g, ""))).toBe(true);
    expect(isUuid(`urn:uuid:${V4}`)).toBe(true);
    expect(isUuid(V7_BYTES)).toBe(true);
  });

  it("accepts every supported version 1 through 7", () => {
    for (let version = 1; version <= 7; version += 1) {
      expect(isUuid(V4.replace("-4", `-${version}`))).toBe(true);
    }
  });

  it("rejects values that are not UUID-shaped", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("   ")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(`${V4} `)).toBe(false);
    expect(isUuid(V4.slice(0, -1))).toBe(false);
    expect(isUuid(V4.replace("a567", "g567"))).toBe(false);
    expect(isUuid(new Uint8Array(15))).toBe(false);
  });

  it("rejects unsupported versions and non-RFC variants", () => {
    expect(isUuid("f47ac10b-58cc-8372-a567-0e02b2c3d479")).toBe(false); // v8
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false); // nil / v0
    expect(isUuid("f47ac10b-58cc-4372-0567-0e02b2c3d479")).toBe(false); // variant 0
    expect(isUuid("f47ac10b-58cc-4372-c567-0e02b2c3d479")).toBe(false); // variant c
  });
});

describe("parseUuid", () => {
  it("returns the canonical form, version and 16 bytes", () => {
    const parsed = parseUuid(V4.toUpperCase());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.canonical).toBe(V4);
      expect(parsed.version).toBe(4);
      expect(parsed.bytes).toHaveLength(16);
      expect(parsed.bytes[0]).toBe(0xf4);
      expect(parsed.bytes[15]).toBe(0x79);
    }
  });

  it("decodes the binary form byte-for-byte", () => {
    const parsed = parseUuid(V7_BYTES);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.version).toBe(7);
      expect(parsed.canonical).toBe("00112233-4455-7677-8899-aabbccddeeff");
      expect(Array.from(parsed.bytes)).toEqual(Array.from(V7_BYTES));
    }
  });

  it("classifies empty, malformed and unsupported input", () => {
    expectError(parseUuid(""), "empty");
    expectError(parseUuid("   "), "empty");
    expectError(parseUuid(null), "empty");
    expectError(parseUuid(undefined), "empty");
    expectError(parseUuid("nope"), "malformed");
    expectError(parseUuid(42), "malformed");
    expectError(parseUuid(`${V4} `), "malformed");
    expectError(parseUuid("f47ac10b-58cc-4372-0567-0e02b2c3d479"), "malformed");
    expectError(parseUuid("f47ac10b-58cc-8372-a567-0e02b2c3d479"), "unsupported_version");
    expectError(parseUuid("00000000-0000-0000-0000-000000000000"), "unsupported_version");
  });
});

describe("normalizeUuid", () => {
  it("canonicalises every accepted input form", () => {
    expect(normalizeUuid(V4.toUpperCase())).toBe(V4);
    expect(normalizeUuid(`{${V4.toUpperCase()}}`)).toBe(V4);
    expect(normalizeUuid(V4.replace(/-/g, "").toUpperCase())).toBe(V4);
    expect(normalizeUuid(`urn:uuid:${V4.toUpperCase()}`)).toBe(V4);
    expect(normalizeUuid(V7_BYTES)).toBe("00112233-4455-7677-8899-aabbccddeeff");
  });

  it("is idempotent and returns null for invalid input", () => {
    const once = normalizeUuid(`{${V4.toUpperCase()}}`);
    expect(once).toBe(V4);
    expect(normalizeUuid(once)).toBe(once);
    expect(normalizeUuid("nope")).toBeNull();
    expect(normalizeUuid("")).toBeNull();
    expect(normalizeUuid(123)).toBeNull();
  });
});

describe("isUuidV7", () => {
  it("distinguishes v7 from other UUID versions and non-UUIDs", () => {
    expect(isUuidV7(uuidv7(0))).toBe(true);
    expect(isUuidV7(V7_BYTES)).toBe(true);
    expect(isUuidV7(uuidv4())).toBe(false);
    expect(isUuidV7("f47ac10b-58cc-1372-a567-0e02b2c3d479")).toBe(false);
    expect(isUuidV7("f47ac10b-58cc-6372-a567-0e02b2c3d479")).toBe(false);
    expect(isUuidV7("nope")).toBe(false);
    expect(isUuidV7(null)).toBe(false);
  });
});
