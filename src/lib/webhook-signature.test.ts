import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  constantTimeEqualHex,
  parseSignatureHeader,
  secureCompare,
  signPayload,
  verifySignature,
} from "@/lib/webhook-signature";

// Every test pins the clock via an explicit `timestamp` / `now` — nothing here
// depends on the wall clock, so the suite is fully deterministic.
const NOW = 1_700_000_000_000;
const SECRET = "whsec_test_1234567890";
const TOLERANCE = 300; // seconds

describe("signPayload", () => {
  it("emits a Stripe-style `t=<ts>,v1=<hex>` header", () => {
    const header = signPayload("hello", SECRET, { timestamp: NOW });
    expect(header).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${NOW},v1=`)).toBe(true);
  });

  it("binds the timestamp into the MAC", () => {
    const a = signPayload("hello", SECRET, { timestamp: NOW });
    const b = signPayload("hello", SECRET, { timestamp: NOW + 1 });
    expect(a).not.toBe(b);
  });

  it("supports a custom scheme label", () => {
    const header = signPayload("hello", SECRET, { timestamp: NOW, scheme: "v2" });
    expect(header).toContain(",v2=");
  });

  it("canonicalises object payloads regardless of key order", () => {
    const a = signPayload({ b: 1, a: 2 }, SECRET, { timestamp: NOW });
    const b = signPayload({ a: 2, b: 1 }, SECRET, { timestamp: NOW });
    expect(a).toBe(b);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("parseSignatureHeader", () => {
  it("parses the timestamp and signature list", () => {
    const parsed = parseSignatureHeader(`t=${NOW},v1=abc`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.timestamp).toBe(NOW);
      expect(parsed.signatures.v1).toEqual(["abc"]);
    }
  });

  it("tolerates whitespace and collects multiple signatures", () => {
    const parsed = parseSignatureHeader(` t=${NOW} , v1=a , v1=b , v2=c `);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.signatures.v1).toEqual(["a", "b"]);
      expect(parsed.signatures.v2).toEqual(["c"]);
    }
  });

  it.each([undefined, "", "garbage", "t=abc,v1=x", "t=123", "t=123,v1="])(
    "rejects the malformed header %p without throwing",
    (bad) => {
      const parsed = parseSignatureHeader(bad as string | undefined);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("bad_format");
    },
  );
});

describe("verifySignature", () => {
  it("round-trips a string payload", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW });
    expect(verifySignature("body", header, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("round-trips an object payload (canonical key order)", () => {
    const header = signPayload({ b: 1, a: 2 }, SECRET, { timestamp: NOW });
    expect(verifySignature({ a: 2, b: 1 }, header, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW });
    expect(verifySignature("body!", header, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "no_match",
    });
    expect(verifySignature({ tampered: true }, header, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "no_match",
    });
  });

  it("rejects the wrong secret", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW });
    expect(verifySignature("body", header, "other-secret", { now: NOW })).toEqual({
      ok: false,
      reason: "no_match",
    });
  });

  it("rejects an expired timestamp", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW - (TOLERANCE * 1000 + 1) });
    expect(verifySignature("body", header, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a future-dated timestamp", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW + (TOLERANCE * 1000 + 1) });
    expect(verifySignature("body", header, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "future",
    });
  });

  it("accepts timestamps exactly at the tolerance boundary", () => {
    const past = signPayload("body", SECRET, { timestamp: NOW - TOLERANCE * 1000 });
    const future = signPayload("body", SECRET, { timestamp: NOW + TOLERANCE * 1000 });
    expect(verifySignature("body", past, SECRET, { now: NOW })).toEqual({ ok: true });
    expect(verifySignature("body", future, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("accepts when one of several v1 signatures matches", () => {
    const good = signPayload("body", SECRET, { timestamp: NOW });
    const sig = good.split("v1=")[1];
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${sig}`;
    expect(verifySignature("body", header, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("fails malformed headers without throwing", () => {
    expect(verifySignature("body", "nope", SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_format",
    });
    expect(verifySignature("body", "", SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_format",
    });
  });

  it("binds the signature to the header timestamp", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW });
    const tampered = header.replace(`t=${NOW}`, `t=${NOW + 1}`);
    expect(verifySignature("body", tampered, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "no_match",
    });
  });

  it("honours a custom tolerance window", () => {
    const header = signPayload("body", SECRET, { timestamp: NOW - 5_000 });
    expect(verifySignature("body", header, SECRET, { now: NOW, toleranceSeconds: 4 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifySignature("body", header, SECRET, { now: NOW, toleranceSeconds: 5 })).toEqual({
      ok: true,
    });
  });
});

describe("constant-time comparisons", () => {
  it("constantTimeEqualHex compares case-insensitively and safely", () => {
    expect(constantTimeEqualHex("ABCD", "abcd")).toBe(true);
    expect(constantTimeEqualHex("abcd", "abce")).toBe(false);
    expect(constantTimeEqualHex("abcd", "ab")).toBe(false);
  });

  it("secureCompare guards length mismatches", () => {
    expect(secureCompare("token", "token")).toBe(true);
    expect(secureCompare("token", "tokens")).toBe(false);
    expect(secureCompare("", "x")).toBe(false);
  });
});
