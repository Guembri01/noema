import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B87 - `GET /api/link-preview` URL validation (audit H4/M1 adjacency).
 * B10 - the same route's SSRF gate: DNS + redirect re-validation.
 *
 * The contract under test:
 *
 *  - 401 first when there is no session, before any URL handling;
 *  - 400 "Invalid url" unless `normalizeUrl()` produced an http(s) URL;
 *  - 400 "Blocked host" for every private/loopback/metadata host - and `fetch`
 *    must never be touched for those: the SSRF gate runs entirely pre-fetch;
 *  - 400 "Blocked host" for a host whose DNS answers point into private space
 *    (`169.254.169.254.nip.io`) - a literal-host check cannot see that;
 *  - 400 "Blocked host" when a redirect hop leads into private space, and the
 *    internal target is never requested;
 *  - 400 "Blocked host" when the fetch reports a `response.url` that points
 *    into private space (a fetch that followed the redirect on its own);
 *  - scheme-less input is normalised to `https://` before fetching;
 *  - untrusted OpenGraph metadata is re-validated (`safeImageUrl`) before it
 *    reaches the client - no `javascript:`/`data:` images or icons and no
 *    private hosts the victim's browser would fetch.
 *
 * Only the transport edge (`@/lib/auth`) and the resolver are mocked; the
 * rate limiter, the validation chain and the response shaping run for real.
 * `fetch` is stubbed so no test can leave the machine.
 */

const edge = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { GET as linkPreview } from "./route";

const fetchMock = vi.fn();

const call = (query: string, ip = "203.0.113.10") =>
  linkPreview(
    new Request(`http://localhost/api/link-preview${query}`, {
      headers: { "x-forwarded-for": ip },
    }),
  );

const query = (value: string) => `?url=${encodeURIComponent(value)}`;

const OG_HTML = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="OG title" />
  <meta name="description" content="OG description" />
  <meta property="og:image" content="/cover.png" />
  <link rel="icon" href="/favicon.ico" />
</head><body></body></html>`;

const ogResponse = () => {
  const response = new Response(OG_HTML, { status: 200 });
  // `Response.url` is empty for constructed responses; the route resolves
  // relative og:image/og:icon values against it.
  Object.defineProperty(response, "url", { value: "https://example.com/page" });
  return response;
};

/** Public by default; the `nip.io` name answers with the metadata address. */
const resolveHost = (hostname: string) =>
  hostname === "169.254.169.254.nip.io"
    ? [{ address: "169.254.169.254", family: 4 }]
    : [{ address: "93.184.216.34", family: 4 }];

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  dns.lookup.mockImplementation(async (hostname: string) => resolveHost(hostname));
  fetchMock.mockImplementation(async () => ogResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/link-preview - auth and URL validation", () => {
  it("401s without a session, before any URL handling", async () => {
    edge.getCurrentUser.mockResolvedValue(null);
    const res = await call(query("javascript:alert(1)"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s non-http(s) schemes and a missing url", async () => {
    const invalid = [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://example.com/x",
      "file:///etc/passwd",
    ];
    for (const target of invalid) {
      const res = await call(query(target));
      expect(res.status, target).toBe(400);
      await expect(res.json(), target).resolves.toEqual({ error: "Invalid url" });
    }

    const missing = await call("");
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Invalid url" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s every private/loopback/metadata host and never fetches", async () => {
    const blocked = [
      "http://localhost/",
      "http://localhost:3000/api",
      "http://127.0.0.1:3000/",
      "http://10.0.0.5/admin",
      "http://192.168.1.1/",
      "http://172.31.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.64.0.1/", // CGNAT
      "http://[::1]/", // WHATWG keeps IPv6 bracketed (audit M1)
      "http://[::]/",
      "http://[::ffff:7f00:1]/", // IPv4-mapped 127.0.0.1 (canonical hex form)
      "http://[fe80::1]/",
      "http://[fd12:3456::1]/",
      "http://foo.localhost/",
      "http://localhost./",
    ];
    for (const target of blocked) {
      const res = await call(query(target));
      expect(res.status, target).toBe(400);
      await expect(res.json(), target).resolves.toEqual({ error: "Blocked host" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises scheme-less input to https and fetches it once", async () => {
    const res = await call(query("example.com/page"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({
        headers: expect.objectContaining({ "user-agent": "NoemaBot/1.0 (+link-preview)" }),
      }),
    );
    const body = await res.json();
    expect(body).toMatchObject({
      url: "https://example.com/page",
      host: "example.com",
      title: "OG title",
      description: "OG description",
    });
    // Relative OpenGraph URLs resolve against the fetched page ...
    expect(body.image).toBe("https://example.com/cover.png");
    expect(body.icon).toBe("https://example.com/favicon.ico");
  });

  it("re-validates untrusted OpenGraph URLs before echoing them", async () => {
    fetchMock.mockImplementation(async () => {
      const html = `<meta property="og:image" content="javascript:alert(1)" />
        <meta property="og:title" content="x" />`;
      const response = new Response(html, { status: 200 });
      Object.defineProperty(response, "url", { value: "https://example.com/page" });
      return response;
    });
    const res = await call(query("https://example.com/page"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("x");
    expect(body.image).toBeNull();
    expect(body.icon).toBeNull();
  });

  it("falls back to the bare card when the fetch fails or errors", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const failed = await call(query("https://example.com/missing"));
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toEqual({
      url: "https://example.com/missing",
      host: "example.com",
      title: null,
      description: null,
      image: null,
      icon: null,
    });

    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:80"));
    const rejected = await call(query("https://down.example/page"));
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({
      url: "https://down.example/page",
      host: "down.example",
      title: null,
    });
  });
});

/**
 * B10 - the gate the literal-host check could not provide: DNS answers and
 * redirect hops are validated too, so neither `169.254.169.254.nip.io` nor a
 * 302 into the metadata address reaches the network.
 */
describe("GET /api/link-preview - SSRF guard (B10)", () => {
  it("400s a host that resolves into private space and never fetches it", async () => {
    const res = await call(query("http://169.254.169.254.nip.io/"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Blocked host" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dns.lookup).toHaveBeenCalledWith(
      "169.254.169.254.nip.io",
      expect.objectContaining({ all: true }),
    );
  });

  it("refuses a redirect into private space and never requests the target", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    const res = await call(query("https://evil.tld/r"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Blocked host" });
    // Only the first hop was requested, with redirects handled manually.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://evil.tld/r",
      expect.objectContaining({ redirect: "manual" }),
    );
    const requested = fetchMock.mock.calls.map(([target]) => String(target));
    expect(requested.some((target) => target.includes("169.254.169.254"))).toBe(false);
  });

  it("follows a redirect to another public host and reads the final page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://www.example.org/page" } }),
      )
      .mockResolvedValueOnce(ogResponse());
    const res = await call(query("https://example.com/start"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.title).toBe("OG title");
    // Relative metadata resolves against the page that answered.
    expect(body.image).toBe("https://example.com/cover.png");
  });

  it("re-checks response.url when the fetch followed a redirect on its own", async () => {
    fetchMock.mockImplementation(async () => {
      const response = new Response(OG_HTML, { status: 200 });
      Object.defineProperty(response, "url", {
        value: "http://169.254.169.254/latest/meta-data/",
      });
      return response;
    });
    const res = await call(query("https://example.com/page"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Blocked host" });
  });

  it("fails closed when DNS cannot be resolved", async () => {
    dns.lookup.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    const res = await call(query("https://gone.example/page"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Blocked host" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an image or icon that points at a private host", async () => {
    fetchMock.mockImplementation(async () => {
      const html = `<meta property="og:image" content="http://169.254.169.254/token" />
        <link rel="icon" href="http://169.254.169.254.nip.io/favicon.ico" />
        <meta property="og:title" content="x" />`;
      const response = new Response(html, { status: 200 });
      Object.defineProperty(response, "url", { value: "https://example.com/page" });
      return response;
    });
    const res = await call(query("https://example.com/page"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("x");
    expect(body.image).toBeNull();
    expect(body.icon).toBeNull();
  });
});
