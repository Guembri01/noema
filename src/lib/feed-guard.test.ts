import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedFeedHost,
  isBlockedFeedTarget,
  isBlockedIpLiteral,
  isBlockedOutboundTarget,
  safeFetchFeed,
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
  // The operator opt-in for loopback targets must never leak into the suite
  // from the developer's environment; the tests that need it set it
  // explicitly.
  vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

/**
 * B11 follow-up — the operator opt-in for the loopback range.
 *
 * The shipped payload runs with `NODE_ENV=production`, and the hermetic
 * webhook receiver of `scripts/check-webhooks.mjs` lives on `127.0.0.1:4280`.
 * A `NODE_ENV` rule cannot serve both — the production guard must not exempt
 * loopback on its own — so the exemption became an explicit operator opt-in:
 * `NOEMA_ALLOW_LOOPBACK_TARGETS=1`.
 *
 * The opt-in opens the loopback range ONLY. RFC1918, link-local, the cloud
 * metadata addresses and every `.internal`/`.local` name stay refused, and
 * the calendar feed path never asks for the opt-in at all.
 */
describe("isBlockedOutboundTarget - operator opt-in for loopback targets (B11)", () => {
  const OPT_IN = "NOEMA_ALLOW_LOOPBACK_TARGETS";

  it("permits a loopback target when the operator opted in (also in production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(OPT_IN, "1");

    await expect(
      isBlockedOutboundTarget("http://127.0.0.1:4280/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(false);
    await expect(
      isBlockedOutboundTarget("http://localhost:4280/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(false);
    await expect(
      isBlockedOutboundTarget("http://[::1]:4280/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(false);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("permits a name whose every answer is a loopback address", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(OPT_IN, "1");
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      isBlockedOutboundTarget("http://receiver.test/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(false);
  });

  it("does not permit the other private ranges with the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(OPT_IN, "1");

    const targets = [
      "http://10.0.0.5:8080/admin",
      "http://172.16.0.9/hook",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/hook",
      "http://metadata.google.internal/latest/meta-data/",
      "http://foo.internal/hook",
      "http://printer.local/hook",
    ];
    for (const target of targets) {
      await expect(
        isBlockedOutboundTarget(target, { allowLoopbackWithOptIn: true }),
        target,
      ).resolves.toBe(true);
    }
    // A name that resolves into private space stays refused as well.
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      isBlockedOutboundTarget("http://receiver.test/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(true);
    // …and so does a mixed answer (loopback + something else).
    dns.lookup.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(
      isBlockedOutboundTarget("http://mixed.test/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(true);
  });

  it("refuses a loopback target in production without the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(OPT_IN, undefined);

    await expect(
      isBlockedOutboundTarget("http://127.0.0.1:4280/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(true);
    await expect(
      isBlockedOutboundTarget("http://localhost:4280/hook", { allowLoopbackWithOptIn: true }),
    ).resolves.toBe(true);
    // A caller that does not ask for the opt-in gets nothing either.
    await expect(isBlockedOutboundTarget("http://127.0.0.1:4280/hook")).resolves.toBe(true);
  });

  it("does not open the loopback range for the calendar feed path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(OPT_IN, "1");

    await expect(isBlockedFeedTarget("http://localhost:4323/cal.ics")).resolves.toBe(true);
    await expect(isBlockedFeedTarget("http://127.0.0.1:4323/cal.ics")).resolves.toBe(true);
  });
});
