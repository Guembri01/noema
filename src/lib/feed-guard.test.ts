import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedFeedHost,
  isBlockedFeedTarget,
  isBlockedIpLiteral,
  safeFetchFeed,
  safeFetchGuarded,
} from "./feed-guard";

/**
 * B59 / audit H4 - SSRF guard behind every calendar feed fetch.
 *
 * The pattern is the link-preview route's host gate
 * (`src/app/api/link-preview/route.ts:44-46` -> `isPrivateHost`,
 * `src/lib/embeds.ts:45-59`), extended with the gaps the audit lists in M1:
 * literal IPv4/IPv6 range checks, DNS resolution of hostnames, and
 * re-validation of every redirect hop (`redirect: "manual"`).
 * DNS is mocked so the suite stays hermetic - "example.com-style" public
 * hosts are exercised through the real default resolver.
 * Red-first: `src/lib/feed-guard.ts` does not exist until the guard lands.
 */

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

beforeEach(() => {
  dns.lookup.mockReset();
});

const resolvePublic = () =>
  dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

describe("isBlockedIpLiteral - IP range checks", () => {
  it("blocks loopback, private, link-local, CGNAT, reserved and IPv6 local ranges", () => {
    const blocked = [
      "127.0.0.1",
      "127.8.8.8",
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:7f00:1", // hex-encoded 127.0.0.1 (audit M1: decimal/hex IPv4)
    ];
    for (const ip of blocked) expect(isBlockedIpLiteral(ip), ip).toBe(true);
  });

  it("allows public addresses", () => {
    const allowed = [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "::ffff:93.184.216.34",
    ];
    for (const ip of allowed) expect(isBlockedIpLiteral(ip), ip).toBe(false);
  });
});

describe("isBlockedFeedHost - hostname rules", () => {
  it("blocks localhost, internal TLDs and metadata hosts", () => {
    const blocked = [
      "localhost",
      "LOCALHOST",
      "foo.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "0.0.0.0",
    ];
    for (const host of blocked) expect(isBlockedFeedHost(host), host).toBe(true);
  });

  it("defers literal IPs to the range checks and passes public hostnames", () => {
    expect(isBlockedFeedHost("169.254.169.254")).toBe(true);
    expect(isBlockedFeedHost("[::1]")).toBe(true); // WHATWG keeps IPv6 brackets (audit M1)
    expect(isBlockedFeedHost("example.com")).toBe(false);
    expect(isBlockedFeedHost("93.184.216.34")).toBe(false);
  });
});

describe("isBlockedFeedTarget - URL + DNS gate", () => {
  it("lets a public hostname through after DNS resolution", async () => {
    resolvePublic();
    await expect(isBlockedFeedTarget("https://example.com/cal.ics")).resolves.toBe(false);
    expect(dns.lookup).toHaveBeenCalledWith("example.com", expect.objectContaining({ all: true }));
  });

  it("rejects literal private targets without touching DNS", async () => {
    const targets = [
      "http://127.0.0.1:5432/cal.ics",
      "http://10.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/",
      "http://2130706433/cal.ics", // decimal IPv4 - WHATWG canonicalises to 127.0.0.1
      "http://[::1]/feed.ics",
      "http://localhost:5432/feed.ics",
      "http://metadata.google.internal/latest/meta-data/",
    ];
    for (const target of targets) {
      await expect(isBlockedFeedTarget(target), target).resolves.toBe(true);
    }
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("rejects hostnames that resolve into private space (DNS rebinding)", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(isBlockedFeedTarget("http://evil.test/feed.ics")).resolves.toBe(true);
    dns.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(isBlockedFeedTarget("http://mixed.test/feed.ics")).resolves.toBe(true);
  });

  it("fails closed when DNS fails or returns nothing", async () => {
    dns.lookup.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(isBlockedFeedTarget("https://gone.test/feed")).resolves.toBe(true);
    dns.lookup.mockResolvedValue([]);
    await expect(isBlockedFeedTarget("https://empty.test/feed")).resolves.toBe(true);
  });

  it("rejects non-http(s) and malformed URLs without DNS", async () => {
    await expect(isBlockedFeedTarget("ftp://example.com/feed")).resolves.toBe(true);
    await expect(isBlockedFeedTarget("file:///etc/passwd")).resolves.toBe(true);
    await expect(isBlockedFeedTarget("not a url")).resolves.toBe(true);
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

describe("safeFetchFeed - guarded fetch with redirect re-validation", () => {
  it("never calls fetch for a blocked target", async () => {
    const fetchFn = vi.fn();
    const response = await safeFetchFeed(
      "http://169.254.169.254/latest/meta-data/",
      undefined,
      { fetchFn },
    );
    expect(response).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("fetches a public target with redirect:manual", async () => {
    resolvePublic();
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValue(new Response("ok", { status: 200 }));
    const response = await safeFetchFeed("https://example.com/cal.ics", undefined, { fetchFn });
    expect(response?.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/cal.ics",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("refuses to follow a redirect into private space", async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    );
    const response = await safeFetchFeed("http://93.184.216.34/feed", undefined, { fetchFn });
    expect(response).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public target", async () => {
    const fetchFn = vi.fn();
    fetchFn
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://93.184.216.34/next" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const response = await safeFetchFeed("http://93.184.216.34/start", undefined, { fetchFn });
    expect(response?.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://93.184.216.34/next",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("stops after the redirect budget and on non-http locations", async () => {
    const loop = vi.fn();
    loop.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://93.184.216.34/again" } }),
    );
    await expect(
      safeFetchFeed("http://93.184.216.34/a", undefined, { fetchFn: loop, maxRedirects: 1 }),
    ).resolves.toBeNull();
    expect(loop).toHaveBeenCalledTimes(2);

    const data = vi.fn();
    data.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "data:text/html,x" } }),
    );
    await expect(safeFetchFeed("http://93.184.216.34/b", undefined, { fetchFn: data })).resolves.toBeNull();
    expect(data).toHaveBeenCalledTimes(1);
  });

  it("returns null when the network call itself fails", async () => {
    const fetchFn = vi.fn();
    fetchFn.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9200"));
    await expect(safeFetchFeed("http://93.184.216.34/c", undefined, { fetchFn })).resolves.toBeNull();
  });
});

/**
 * `safeFetchGuarded` is the shared entry point (B10): the calendar path uses
 * `safeFetchFeed`, the link-preview route uses the guarded result directly so
 * it can tell a refused target from a broken one.
 */
describe("safeFetchGuarded - result shape and re-validation", () => {
  it("reports a refused target as blocked, before any fetch", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const fetchFn = vi.fn();
    const result = await safeFetchGuarded("http://evil.test/feed", undefined, { fetchFn });
    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a network failure as failed, not as blocked", async () => {
    resolvePublic();
    const fetchFn = vi.fn();
    fetchFn.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const result = await safeFetchGuarded("https://example.com/feed", undefined, { fetchFn });
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("returns the final URL of a followed redirect", async () => {
    resolvePublic();
    const fetchFn = vi.fn();
    fetchFn
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://www.example.org/x" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await safeFetchGuarded("https://example.com/feed", undefined, { fetchFn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalUrl).toBe("https://www.example.org/x");
    expect(result.response.status).toBe(200);
  });

  it("re-checks a response.url that points somewhere else", async () => {
    resolvePublic();
    const fetchFn = vi.fn();
    fetchFn.mockImplementation(async () => {
      const response = new Response("ok", { status: 200 });
      // A `fetch` that followed the redirect on its own reports the final URL.
      Object.defineProperty(response, "url", { value: "http://169.254.169.254/secret" });
      return response;
    });
    const result = await safeFetchGuarded("https://example.com/feed", undefined, { fetchFn });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  });
});

/**
 * The end-to-end check (`scripts/check-workspace-ui.mjs`) subscribes to a mock
 * ICS feed on loopback while the app runs under `next dev`. That is the only
 * place the guard relaxes, and only for loopback hosts; every deployment
 * (production) and every unit run (`test`) keeps failing closed.
 */
describe("isBlockedFeedTarget - development-only loopback exemption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a loopback mock feed in development without touching DNS", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(isBlockedFeedTarget("http://localhost:4323/cal.ics")).resolves.toBe(false);
    await expect(isBlockedFeedTarget("http://127.0.0.1:4323/cal.ics")).resolves.toBe(false);
    await expect(isBlockedFeedTarget("http://[::1]:4323/cal.ics")).resolves.toBe(false);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("still blocks non-loopback private targets in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(isBlockedFeedTarget("http://169.254.169.254/latest/meta-data/")).resolves.toBe(true);
    await expect(isBlockedFeedTarget("http://10.0.0.1/admin")).resolves.toBe(true);
    await expect(isBlockedFeedTarget("http://metadata.google.internal/latest/meta-data/")).resolves.toBe(true);
  });

  it("blocks loopback outside development (test/production)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await expect(isBlockedFeedTarget("http://localhost:4323/cal.ics")).resolves.toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    await expect(isBlockedFeedTarget("http://127.0.0.1:4323/cal.ics")).resolves.toBe(true);
  });
});
