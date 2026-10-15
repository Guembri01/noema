import { describe, expect, it } from "vitest";
import {
  isDisposableDomain,
  isRoleAddress,
  isValidEmail,
  normalizeEmail,
  parseEmail,
  suggestDomainFixes,
} from "./email-validation";

/**
 * Pure email-address helpers (signup/invite/notification entry points all take
 * an email today and each rolls its own regex - see `server/actions/email.ts`
 * and `server/actions/teamspace-invites.ts`). This module centralises the
 * practical subset of RFC 5321/5322 the app cares about: exactly one `@`, an
 * ASCII local part and dot-separated domain labels with a real TLD.
 *
 * Red-first: `src/lib/email-validation.ts` does not exist until this lands - the
 * first run fails to resolve the import, then the suite goes green. Pure only:
 * no DB, no React, no network; every input is untrusted, so nothing ever throws.
 */

describe("isValidEmail", () => {
  it("accepts ordinary, plus-tagged and dotted addresses", () => {
    expect(isValidEmail("alice@example.com")).toBe(true);
    expect(isValidEmail("alice+notion@example.com")).toBe(true);
    expect(isValidEmail("first.last@example.co.uk")).toBe(true);
    expect(isValidEmail("user_name-1@sub.example.com")).toBe(true);
  });

  it("accepts mixed case and surrounding whitespace", () => {
    expect(isValidEmail("Alice@Example.COM")).toBe(true);
    expect(isValidEmail("  alice@example.com  ")).toBe(true);
  });

  it("requires exactly one @ with content on both sides", () => {
    expect(isValidEmail("alice.example.com")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("alice@")).toBe(false);
    expect(isValidEmail("a@b@example.com")).toBe(false);
  });

  it("rejects whitespace inside the address", () => {
    expect(isValidEmail("al ice@example.com")).toBe(false);
    expect(isValidEmail("alice@exa mple.com")).toBe(false);
  });

  it("requires a dotted domain with a real TLD", () => {
    expect(isValidEmail("alice@localhost")).toBe(false);
    expect(isValidEmail("alice@example.c")).toBe(false);
    expect(isValidEmail("alice@example.123")).toBe(false);
    expect(isValidEmail("alice@.example.com")).toBe(false);
    expect(isValidEmail("alice@example..com")).toBe(false);
    expect(isValidEmail("alice@-example.com")).toBe(false);
    expect(isValidEmail("alice@example-.com")).toBe(false);
  });

  it("rejects malformed local parts", () => {
    expect(isValidEmail(".alice@example.com")).toBe(false);
    expect(isValidEmail("alice.@example.com")).toBe(false);
    expect(isValidEmail("al..ice@example.com")).toBe(false);
    expect(isValidEmail("al(ice)@example.com")).toBe(false);
  });

  it("never throws on non-strings and empty input", () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
    expect(isValidEmail({})).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("parseEmail", () => {
  it("splits a valid address and lowercases only the domain", () => {
    expect(parseEmail("Alice+Tag@Example.COM")).toEqual({
      local: "Alice+Tag",
      domain: "example.com",
    });
  });

  it("trims before splitting", () => {
    expect(parseEmail("  bob@Example.com ")).toEqual({
      local: "bob",
      domain: "example.com",
    });
  });

  it("returns null for anything invalid", () => {
    expect(parseEmail("nope")).toBeNull();
    expect(parseEmail("a@@b.com")).toBeNull();
    expect(parseEmail(null)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases the domain while keeping local case", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("Alice@example.com");
  });

  it("keeps a plus tag by default", () => {
    expect(normalizeEmail("alice+notion@example.com")).toBe(
      "alice+notion@example.com",
    );
  });

  it("drops the plus tag when stripPlus is set", () => {
    expect(normalizeEmail("alice+notion@Example.com", { stripPlus: true })).toBe(
      "alice@example.com",
    );
  });

  it("returns null when the address is invalid", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe("isDisposableDomain", () => {
  it("flags curated throwaway domains", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("YOPMAIL.COM")).toBe(true);
    expect(isDisposableDomain("guerrillamail.com")).toBe(true);
  });

  it("matches subdomains and tolerates a leading @ or full address", () => {
    expect(isDisposableDomain("inbox.mailinator.com")).toBe(true);
    expect(isDisposableDomain("@mailinator.com")).toBe(true);
    expect(isDisposableDomain("someone@mailinator.com")).toBe(true);
  });

  it("does not flag ordinary providers or non-strings", () => {
    expect(isDisposableDomain("gmail.com")).toBe(false);
    expect(isDisposableDomain("example.com")).toBe(false);
    expect(isDisposableDomain(null)).toBe(false);
  });
});

describe("isRoleAddress", () => {
  it("flags common role mailboxes", () => {
    expect(isRoleAddress("admin")).toBe(true);
    expect(isRoleAddress("support")).toBe(true);
    expect(isRoleAddress("noreply")).toBe(true);
    expect(isRoleAddress("postmaster")).toBe(true);
  });

  it("ignores case, separators and plus tags", () => {
    expect(isRoleAddress("No-Reply")).toBe(true);
    expect(isRoleAddress("billing+invoices")).toBe(true);
    expect(isRoleAddress("SALES")).toBe(true);
  });

  it("uses the local part of a full address", () => {
    expect(isRoleAddress("support@example.com")).toBe(true);
    expect(isRoleAddress("alice@support.com")).toBe(false);
  });

  it("does not flag a personal mailbox", () => {
    expect(isRoleAddress("alice")).toBe(false);
    expect(isRoleAddress("")).toBe(false);
    expect(isRoleAddress(undefined)).toBe(false);
  });
});

describe("suggestDomainFixes", () => {
  it("maps common provider typos to the canonical domain", () => {
    expect(suggestDomainFixes("gmial.com")).toEqual(["gmail.com"]);
    expect(suggestDomainFixes("hotmai.com")).toEqual(["hotmail.com"]);
    expect(suggestDomainFixes("outlok.com")).toEqual(["outlook.com"]);
  });

  it("is case-insensitive and tolerates an @ prefix", () => {
    expect(suggestDomainFixes("@GMial.com")).toEqual(["gmail.com"]);
  });

  it("returns a fresh empty array for known-good or unknown domains", () => {
    expect(suggestDomainFixes("gmail.com")).toEqual([]);
    expect(suggestDomainFixes("example.com")).toEqual([]);
    expect(suggestDomainFixes(null)).toEqual([]);
    const first = suggestDomainFixes("gmial.com");
    expect(first).not.toBe(suggestDomainFixes("gmial.com"));
  });
});
