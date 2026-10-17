import { describe, expect, it } from "vitest";
import {
  ipInCidr,
  ipVersion,
  matchAny,
  normalizeIp,
  parseCidr,
  validateCidr,
  type CidrParseResult,
} from "@/lib/ip-allowlist";

/**
 * IP allowlist / CIDR matching (M7 — the
 * `X-Forwarded-For` client key is spoofable, so an allowlist gate needs its
 * own arithmetic rather than string prefix checks).
 *
 * Pure helpers only: a CIDR/prefix parser, a validator, an IP-version probe,
 * per-address containment and a deny-by-default "any of these blocks" gate.
 * True IPv4 + basic IPv6 (no embedded IPv4); no network and no `node:net`.
 */

function expectOk(result: CidrParseResult) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("normalizeIp", () => {
  it("trims and canonicalises IPv4 (drops leading zeros)", () => {
    expect([normalizeIp("  10.0.0.1 "), normalizeIp("192.168.001.001")]).toEqual([
      "10.0.0.1",
      "192.168.1.1",
    ]);
  });

  it("lower-cases and RFC 5952-compresses IPv6", () => {
    expect([
      normalizeIp("2001:0DB8:0000:0000:0000:0000:0000:0001"),
      normalizeIp("0:0:0:0:0:0:0:0"),
      normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0000"),
    ]).toEqual(["2001:db8::1", "::", "2001:db8::"]);
  });

  it("returns null for anything that is not an IP literal", () => {
    for (const bad of ["", "999.1.1.1", "10.0.0", "10.0.0.1.2", "1::2::3", "example.com", "12345"]) {
      expect(normalizeIp(bad), bad).toBeNull();
    }
  });
});

describe("ipVersion", () => {
  it("detects IPv4 and IPv6 (whitespace tolerated)", () => {
    expect([ipVersion("10.0.0.1"), ipVersion(" 2001:db8::1 "), ipVersion("::")]).toEqual([4, 6, 6]);
  });

  it("returns null for invalid input", () => {
    for (const bad of ["256.0.0.1", "not-an-ip", ""]) {
      expect(ipVersion(bad), bad).toBeNull();
    }
  });
});

describe("parseCidr", () => {
  it("parses an IPv4 block, masking host bits off the network address", () => {
    expect(parseCidr("192.168.1.0/24")).toEqual({
      ok: true,
      value: {
        address: "192.168.1.0",
        version: 4,
        prefix: 24,
        first: "192.168.1.0",
        last: "192.168.1.255",
      },
    });
    const masked = expectOk(parseCidr("10.20.30.130/26"));
    expect([masked.first, masked.last]).toEqual(["10.20.30.128", "10.20.30.191"]);
  });

  it("treats a bare address as a single host (/32, /128)", () => {
    expect(parseCidr("10.1.2.3")).toEqual({
      ok: true,
      value: { address: "10.1.2.3", version: 4, prefix: 32, first: "10.1.2.3", last: "10.1.2.3" },
    });
    expect(expectOk(parseCidr("2001:db8::1"))).toEqual({
      address: "2001:db8::1",
      version: 6,
      prefix: 128,
      first: "2001:db8::1",
      last: "2001:db8::1",
    });
  });

  it("parses IPv6 blocks and handles the /0 edges", () => {
    const v6 = expectOk(parseCidr("2001:db8::/64"));
    expect([v6.first, v6.last]).toEqual(["2001:db8::", "2001:db8::ffff:ffff:ffff:ffff"]);
    const v4any = expectOk(parseCidr("0.0.0.0/0"));
    expect([v4any.first, v4any.last]).toEqual(["0.0.0.0", "255.255.255.255"]);
    const v6any = expectOk(parseCidr("::/0"));
    expect([v6any.first, v6any.last]).toEqual(["::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]);
  });

  it("trims surrounding whitespace", () => {
    expect(expectOk(parseCidr("  172.16.0.0/12  ")).first).toBe("172.16.0.0");
  });

  it("rejects malformed blocks with a non-empty error", () => {
    const malformed = [
      "",
      "10.0.0.0/33",
      "::/129",
      "10.0.0.0/x",
      "10.0.0.0/",
      "/24",
      "10.0.0.0/8/8",
      "nope/8",
      "10.0.0.999/8",
    ];
    expect(malformed.map((bad) => parseCidr(bad).ok)).toEqual(malformed.map(() => false));
    expect(parseCidr("10.0.0.0/33")).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe("validateCidr", () => {
  it("accepts valid blocks and rejects everything else", () => {
    expect(["10.0.0.0/8", "2001:db8::/32"].map(validateCidr)).toEqual([true, true]);
    expect(["10.0.0.0/33", "garbage", 24, null].map(validateCidr)).toEqual([false, false, false, false]);
  });
});

describe("ipInCidr", () => {
  it("matches inclusive boundaries and rejects the neighbouring blocks", () => {
    const ips = ["192.168.1.1", "192.168.1.0", "192.168.1.255", "192.168.0.255", "192.168.2.0"];
    expect(ips.map((ip) => ipInCidr(ip, "192.168.1.0/24"))).toEqual([true, true, true, false, false]);
  });

  it("matches IPv6 blocks and is version-strict", () => {
    expect([
      ipInCidr("2001:db8::5", "2001:db8::/64"),
      ipInCidr("2001:db9::1", "2001:db8::/64"),
      ipInCidr("::1", "10.0.0.0/8"),
    ]).toEqual([true, false, false]);
  });

  it("accepts a pre-parsed block and fails closed on bad input", () => {
    const block = expectOk(parseCidr("10.0.0.0/8"));
    expect(ipInCidr("10.255.255.255", block)).toBe(true);
    expect([
      ipInCidr("11.0.0.1", block),
      ipInCidr("not-an-ip", "0.0.0.0/0"),
      ipInCidr("10.0.0.1", "not-a-cidr"),
    ]).toEqual([false, false, false]);
  });
});

describe("matchAny", () => {
  it("allows when any block matches, denies otherwise", () => {
    const rules = ["192.168.0.0/16", "10.0.0.0/8"];
    expect(["10.1.2.3", "192.168.5.9", "172.16.0.1"].map((ip) => matchAny(ip, rules))).toEqual([
      true,
      true,
      false,
    ]);
    expect(matchAny("10.1.2.3", [])).toBe(false);
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(matchAny("10.0.0.1", ["garbage", "10.0.0.0/8"])).toBe(true);
    expect([
      matchAny("10.0.0.1", ["garbage"]),
      matchAny("10.9.9.9", [expectOk(parseCidr("10.0.0.0/8"))]),
    ]).toEqual([false, true]);
  });
});
