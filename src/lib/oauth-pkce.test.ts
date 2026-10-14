import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  codeChallengePlain,
  codeChallengeS256,
  generateCodeVerifier,
  isValidVerifier,
  verifyChallenge,
} from "@/lib/oauth-pkce";

// RFC 7636 appendix B reference pair.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("base64Url", () => {
  it("encodes without padding using the url-safe alphabet", () => {
    expect(base64UrlEncode(Buffer.from("hello"))).toBe("aGVsbG8");
  });

  it("round-trips arbitrary bytes", () => {
    const buffer = Buffer.from([0xfb, 0xff, 0x00, 0x10, 0xee, 0x3f]);
    expect(base64UrlDecode(base64UrlEncode(buffer)).equals(buffer)).toBe(true);
  });

  it("decodes input that is missing padding", () => {
    expect(base64UrlDecode("aGVsbG8").toString("utf8")).toBe("hello");
  });

  it("never emits +, / or =", () => {
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe, 0xfd]));
    expect(/[+/=]/.test(encoded)).toBe(false);
  });
});

describe("generateCodeVerifier", () => {
  it("defaults to 64 characters", () => {
    expect(generateCodeVerifier()).toHaveLength(64);
  });

  it("respects the boundary lengths 43 and 128", () => {
    expect(generateCodeVerifier(43)).toHaveLength(43);
    expect(generateCodeVerifier(128)).toHaveLength(128);
  });

  it("uses only the RFC 7636 unreserved charset", () => {
    expect(/^[A-Za-z0-9\-._~]+$/.test(generateCodeVerifier(100))).toBe(true);
  });

  it("produces distinct verifiers across calls", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("rejects lengths outside 43..128", () => {
    expect(() => generateCodeVerifier(42)).toThrow();
    expect(() => generateCodeVerifier(129)).toThrow();
  });
});

describe("isValidVerifier", () => {
  it("accepts a freshly generated verifier", () => {
    expect(isValidVerifier(generateCodeVerifier())).toBe(true);
  });

  it("accepts the RFC 7636 reference verifier", () => {
    expect(isValidVerifier(RFC_VERIFIER)).toBe(true);
  });

  it("rejects verifiers that are too short or too long", () => {
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
  });

  it("rejects out-of-charset characters", () => {
    expect(isValidVerifier("a".repeat(42) + "!")).toBe(false);
  });
});

describe("codeChallengeS256", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(codeChallengeS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("is deterministic", () => {
    expect(codeChallengeS256(RFC_VERIFIER)).toBe(codeChallengeS256(RFC_VERIFIER));
  });

  it("yields a 43-character base64url digest", () => {
    expect(codeChallengeS256(RFC_VERIFIER)).toHaveLength(43);
  });
});

describe("codeChallengePlain", () => {
  it("returns the verifier unchanged", () => {
    expect(codeChallengePlain(RFC_VERIFIER)).toBe(RFC_VERIFIER);
  });
});

describe("verifyChallenge", () => {
  it("accepts a matching S256 challenge", () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE, "S256")).toBe(true);
  });

  it("accepts a matching plain challenge", () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_VERIFIER, "plain")).toBe(true);
  });

  it("treats the method case-insensitively", () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE, "s256")).toBe(true);
  });

  it("rejects a mismatched verifier", () => {
    expect(verifyChallenge("x".repeat(43), RFC_CHALLENGE, "S256")).toBe(false);
  });

  it("rejects an unknown challenge method", () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE, "S512")).toBe(false);
  });

  it("rejects a malformed verifier", () => {
    expect(verifyChallenge("short", RFC_CHALLENGE, "S256")).toBe(false);
  });
});
