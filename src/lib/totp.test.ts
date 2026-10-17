import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUrl,
  totp,
  verifyTotp,
} from "@/lib/totp";

// RFC 6238 appendix B: secret "12345678901234567890" (ASCII).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("round-trips", () => {
    const buffer = Buffer.from("12345678901234567890", "ascii");
    expect(base32Decode(base32Encode(buffer)).equals(buffer)).toBe(true);
  });
});

describe("TOTP (RFC 6238 vectors)", () => {
  it("matches the published SHA-1 values", () => {
    expect(totp(RFC_SECRET, 59_000, 30, 8)).toBe("94287082");
    expect(totp(RFC_SECRET, 1_111_111_109_000, 30, 8)).toBe("07081804");
    expect(totp(RFC_SECRET, 1_234_567_890_000, 30, 8)).toBe("89005924");
  });

  it("produces 6 digits by default", () => {
    expect(totp(RFC_SECRET, 59_000)).toHaveLength(6);
  });

  it("HOTP counter 0 matches the RFC 4226 vector", () => {
    expect(hotp(base32Decode(RFC_SECRET), 0, 6)).toBe("755224");
  });
});

describe("verifyTotp", () => {
  it("accepts the current code and rejects a wrong one", () => {
    const code = totp(RFC_SECRET, 59_000);
    expect(verifyTotp(RFC_SECRET, code, 59_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "000000", 59_000, 0)).toBe(false);
  });

  it("accepts the previous step within the window", () => {
    const previous = totp(RFC_SECRET, 29_000); // counter 0, vs counter 1 at 59s
    expect(verifyTotp(RFC_SECRET, previous, 59_000, 1)).toBe(true);
    expect(verifyTotp(RFC_SECRET, previous, 59_000, 0)).toBe(false);
  });

  it("refuses anything that is not a TOTP code", () => {
    // The code space is digits only, so a recovery code could never be
    // entered: there is no recovery path in the sign-in.
    expect(verifyTotp(RFC_SECRET, "1234-5678", 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "ABCD-EFGH", 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", 59_000)).toBe(false);
  });
});

describe("otpauth url", () => {
  it("encodes the issuer, account and secret", () => {
    const url = otpauthUrl("ABCDEF", "a@b.com");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain("secret=ABCDEF");
    expect(url).toContain("issuer=Noema");
  });
});
