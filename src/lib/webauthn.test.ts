import { describe, expect, it } from "vitest";
import {
  checkSignCount,
  generateChallenge,
  isValidChallenge,
  isValidRpId,
  isSupportedAlgorithm,
  parseCredentialId,
  rpIdFromOrigin,
} from "@/lib/webauthn";

/**
 * WebAuthn / passkey helpers. Everything here is pure apart from
 * `node:crypto`'s CSPRNG, so every branch is unit-testable without a browser
 * or an authenticator: challenges are the only non-deterministic output and
 * are checked structurally (alphabet, length, entropy) rather than by value.
 */

describe("generateChallenge", () => {
  it("defaults to a 32-byte, 43-character base64url challenge", () => {
    const challenge = generateChallenge();
    expect(challenge).toHaveLength(43);
    expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true);
  });

  it("honours an explicit byte count and stays url-safe", () => {
    const challenge = generateChallenge({ bytes: 16 });
    expect(challenge).toHaveLength(22);
    expect(/[+/=]/.test(challenge)).toBe(false);
    expect(isValidChallenge(challenge)).toBe(true);
  });

  it("rejects byte counts outside the 16..64 range", () => {
    expect(() => generateChallenge({ bytes: 15 })).toThrow(RangeError);
    expect(() => generateChallenge({ bytes: 65 })).toThrow(RangeError);
    expect(() => generateChallenge({ bytes: 16.5 })).toThrow(RangeError);
  });

  it("produces distinct challenges across calls", () => {
    expect(generateChallenge()).not.toBe(generateChallenge());
  });
});

describe("isValidChallenge", () => {
  it("accepts a freshly generated challenge", () => {
    expect(isValidChallenge(generateChallenge())).toBe(true);
  });

  it("requires at least 16 decoded bytes", () => {
    expect(isValidChallenge("A".repeat(22))).toBe(true);
    expect(isValidChallenge("A".repeat(8))).toBe(false);
  });

  it("rejects non-strings and blank input", () => {
    expect(isValidChallenge("")).toBe(false);
    expect(isValidChallenge(42)).toBe(false);
    expect(isValidChallenge(null)).toBe(false);
  });

  it("rejects padding, whitespace and out-of-charset characters", () => {
    expect(isValidChallenge("A".repeat(21) + "=")).toBe(false);
    expect(isValidChallenge("A".repeat(20) + " ")).toBe(false);
    expect(isValidChallenge("A".repeat(20) + "+")).toBe(false);
  });

  it("rejects non-canonical encodings", () => {
    // "A".repeat(21)+"B" decodes to the same bytes as the canonical form but
    // leaves non-zero pad bits, so a strict encoder would never emit it.
    expect(isValidChallenge("A".repeat(22))).toBe(true);
    expect(isValidChallenge("A".repeat(21) + "B")).toBe(false);
  });
});

describe("parseCredentialId", () => {
  it("decodes a base64url credential id and normalises it", () => {
    const parsed = parseCredentialId("aGVsbG8");
    expect(parsed).not.toBeNull();
    expect(parsed?.base64url).toBe("aGVsbG8");
    expect(parsed?.bytes.toString("utf8")).toBe("hello");
  });

  it("accepts padded standard base64 and rewrites it as base64url", () => {
    const parsed = parseCredentialId("aGVsbG8=");
    expect(parsed?.base64url).toBe("aGVsbG8");
  });

  it("rejects empty, non-string and malformed inputs", () => {
    expect(parseCredentialId("")).toBeNull();
    expect(parseCredentialId(42)).toBeNull();
    expect(parseCredentialId("a b")).toBeNull();
    expect(parseCredentialId("not!base64")).toBeNull();
  });

  it("rejects credential ids larger than 1024 bytes", () => {
    const oversized = Buffer.alloc(1025).toString("base64url");
    expect(parseCredentialId(oversized)).toBeNull();
    expect(parseCredentialId(Buffer.alloc(1024).toString("base64url"))).not.toBeNull();
  });
});

describe("isSupportedAlgorithm", () => {
  it("accepts the COSE algorithms WebAuthn RP libraries register", () => {
    for (const alg of [-7, -8, -35, -36, -37, -38, -39, -257, -258, -259]) {
      expect(isSupportedAlgorithm(alg)).toBe(true);
    }
  });

  it("rejects unknown, non-numeric and non-integer values", () => {
    expect(isSupportedAlgorithm(-1)).toBe(false);
    expect(isSupportedAlgorithm(0)).toBe(false);
    expect(isSupportedAlgorithm(1.5)).toBe(false);
    expect(isSupportedAlgorithm("ES256")).toBe(false);
    expect(isSupportedAlgorithm(null)).toBe(false);
  });
});

describe("checkSignCount", () => {
  it("accepts a strictly increasing counter", () => {
    expect(checkSignCount(0, 0)).toBe(true);
    expect(checkSignCount(0, 5)).toBe(true);
    expect(checkSignCount(5, 6)).toBe(true);
  });

  it("skips the check when either counter is zero", () => {
    // A zero counter means the authenticator does not implement one, so a
    // reset from a positive value must not be mistaken for a cloned device.
    expect(checkSignCount(5, 0)).toBe(true);
  });

  it("rejects equal or decreasing counters", () => {
    expect(checkSignCount(5, 5)).toBe(false);
    expect(checkSignCount(5, 4)).toBe(false);
  });

  it("rejects negative and non-integer counters", () => {
    expect(checkSignCount(-1, 5)).toBe(false);
    expect(checkSignCount(5, -1)).toBe(false);
    expect(checkSignCount(1.5, 2)).toBe(false);
    expect(checkSignCount(1, "2")).toBe(false);
  });
});

describe("isValidRpId", () => {
  it("matches an allow-listed rp id exactly", () => {
    expect(isValidRpId("example.com", ["example.com"])).toBe(true);
  });

  it("normalises case and a trailing dot", () => {
    expect(isValidRpId("Example.COM", ["example.com"])).toBe(true);
    expect(isValidRpId("example.com.", ["example.com"])).toBe(true);
  });

  it("rejects ids that are absent or only a subdomain of a listed one", () => {
    expect(isValidRpId("login.example.com", ["example.com"])).toBe(false);
    expect(isValidRpId("example.org", ["example.com"])).toBe(false);
  });

  it("fails closed on blank ids or empty/absent allow-lists", () => {
    expect(isValidRpId("", ["example.com"])).toBe(false);
    expect(isValidRpId("example.com", [])).toBe(false);
    expect(isValidRpId("example.com", "example.com")).toBe(false);
  });
});

describe("rpIdFromOrigin", () => {
  it("derives the host from an https origin, ignoring port and path", () => {
    expect(rpIdFromOrigin("https://app.example.com:8443/settings")).toBe("app.example.com");
  });

  it("lowercases the host", () => {
    expect(rpIdFromOrigin("https://APP.Example.com")).toBe("app.example.com");
  });

  it("allows http only for loopback hosts", () => {
    expect(rpIdFromOrigin("http://localhost:3000")).toBe("localhost");
    expect(rpIdFromOrigin("http://127.0.0.1:3000")).toBe("127.0.0.1");
    expect(rpIdFromOrigin("http://example.com")).toBeNull();
  });

  it("rejects non-http(s) schemes, malformed and non-string origins", () => {
    expect(rpIdFromOrigin("ftp://example.com")).toBeNull();
    expect(rpIdFromOrigin("example.com")).toBeNull();
    expect(rpIdFromOrigin(null)).toBeNull();
  });
});
