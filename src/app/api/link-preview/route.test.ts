import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B87 - `GET /api/link-preview` URL validation (audit H4/M1 adjacency).
 *
 * This route is the OTHER caller of `isPrivateHost` (B59 hardened the calendar
 * feed path in feed-guard.ts; this suite pins the link-preview gate in
 * embeds.ts + route.ts). The contract under test:
 *
 *  - 401 first when there is no session, before any URL handling;
 *  - 400 "Invalid url" unless `normalizeUrl()` produced an http(s) URL;
 *  - 400 "Blocked host" for every private/loopback/metadata host - and `fetch`
 *    must never be touched for those: the SSRF gate runs entirely pre-fetch;
 *  - scheme-less input is normalised to `https://` before fetching;
 *  - untrusted OpenGraph metadata is re-validated (`safeImageUrl`) before it
 *    reaches the client - no `javascript:`/`data:` images or icons.
 *
 * Only the transport edge (`@/lib/auth`) is mocked; the rate limiter, the
 * validation chain and the response shaping run for real. `fetch` is stubbed
 * so no test can leave the machine.
 */

const edge = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));

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

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
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
