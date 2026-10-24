import { describe, expect, it } from "vitest";
import {
  emailDomain,
  hasVerificationToken,
  normalizeDomain,
  verificationRecordName,
} from "./domains";

describe("normalizeDomain", () => {
  it("normalises case, URLs, email addresses and trailing dots", () => {
    expect(normalizeDomain(" Acme.COM ")).toBe("acme.com");
    expect(normalizeDomain("https://Acme.com/path")).toBe("acme.com");
    expect(normalizeDomain("person@Acme.com")).toBe("acme.com");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
  });

  it("refuses malformed hosts", () => {
    for (const value of ["", "localhost", ".com", "a..b", "-a.com", "a-.com", 42]) {
      expect(normalizeDomain(value)).toBeNull();
    }
  });
});

describe("emailDomain / verificationRecordName", () => {
  it("extracts the domain from the last @", () => {
    expect(emailDomain("alice@sub.acme.com")).toBe("sub.acme.com");
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("alice@")).toBeNull();
  });

  it("builds the TXT owner name", () => {
    expect(verificationRecordName("acme.com")).toBe("_noema-verification.acme.com");
  });
});

describe("hasVerificationToken", () => {
  it("joins split TXT chunks and trims surrounding quotes", () => {
    expect(hasVerificationToken([['"noema-', 'token"']], "noema-token")).toBe(true);
    expect(hasVerificationToken([["other"]], "noema-token")).toBe(false);
    expect(hasVerificationToken([], "noema-token")).toBe(false);
    expect(hasVerificationToken([["anything"]], "")).toBe(false);
  });
});
