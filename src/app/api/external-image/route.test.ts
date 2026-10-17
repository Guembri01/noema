import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B69 - `GET /api/external-image`: the server-side proxy for external
 * pictures.
 *
 * The contract under test:
 *
 *  - 400 "Invalid url" for a target that is not an `http(s)` URL (`data:`,
 *    `file:`, `javascript:`, a missing parameter) - and `fetch` is never
 *    touched;
 *  - 403 "Host not allowed" for a host that is not on the allowlist - the
 *    target is neither resolved nor fetched;
 *  - 403 "Blocked host" for a loopback/private/metadata host and for a host
 *    whose DNS answers point into private space - even when the host itself is
 *    allowlisted;
 *  - 502 "Redirect refused" for a redirect: the `Location` target is never
 *    requested;
 *  - 415 "Not an image" for a response that is not a known image type, and
 *    415 "Unsafe image" for an SVG that fails the safety check;
 *  - 413 "Image too large" for a body over the cap;
 *  - 200 with the bytes, the image content type, `nosniff` and a sandboxing
 *    CSP for an allowed host.
 *
 * Only the transport edge (DNS) and `fetch` are mocked; the allowlist, the
 * SSRF gate, the rate limiter and the response shaping run for real.
 */

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { GET as externalImage } from "./route";

const fetchMock = vi.fn();

const call = (target: string) =>
  externalImage(
    new Request(`http://localhost/api/external-image?url=${encodeURIComponent(target)}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }),
  );

/** A public address for every host, unless a test says otherwise. */
const publicAnswer = [{ address: "93.184.216.34", family: 4 }];

/** A one-pixel PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const imageResponse = (body: Uint8Array<ArrayBuffer> = new Uint8Array(PNG), type = "image/png") =>
  new Response(body, { status: 200, headers: { "content-type": type } });

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  dns.lookup.mockImplementation(async () => publicAnswer);
  fetchMock.mockImplementation(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/external-image - the URL gate", () => {
  it("400s every target that is not an http(s) URL and never fetches it", async () => {
    const invalid = [
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://images.unsplash.com/a.png",
      "not a url",
    ];
    for (const target of invalid) {
      const res = await call(target);
      expect(res.status, target).toBe(400);
      await expect(res.json(), target).resolves.toEqual({ error: "Invalid url" });
    }
    const missing = await call("");
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Invalid url" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a host that is not on the allowlist and never resolves or fetches it", async () => {
    const res = await call("https://images.example.com/a.png");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Host not allowed" });
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/external-image - the SSRF gate", () => {
  it("403s a loopback, private or metadata host and never fetches it", async () => {
    const saved = process.env.EXTERNAL_IMAGE_ALLOWLIST;
    process.env.EXTERNAL_IMAGE_ALLOWLIST = "127.0.0.1,localhost,169.254.169.254,10.0.0.5";
    try {
      for (const target of [
        "http://127.0.0.1/a.png",
        "http://localhost/a.png",
        "http://10.0.0.5/a.png",
        "http://169.254.169.254/latest/meta-data/",
      ]) {
        const res = await call(target);
        expect(res.status, target).toBe(403);
        await expect(res.json(), target).resolves.toEqual({ error: "Blocked host" });
      }
    } finally {
      if (saved === undefined) delete process.env.EXTERNAL_IMAGE_ALLOWLIST;
      else process.env.EXTERNAL_IMAGE_ALLOWLIST = saved;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s an allowlisted host whose DNS answer points into private space", async () => {
    const saved = process.env.EXTERNAL_IMAGE_ALLOWLIST;
    process.env.EXTERNAL_IMAGE_ALLOWLIST = "169.254.169.254.nip.io";
    dns.lookup.mockImplementation(async () => [{ address: "169.254.169.254", family: 4 }]);
    try {
      const res = await call("http://169.254.169.254.nip.io/a.png");
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Blocked host" });
    } finally {
      if (saved === undefined) delete process.env.EXTERNAL_IMAGE_ALLOWLIST;
      else process.env.EXTERNAL_IMAGE_ALLOWLIST = saved;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/external-image - the response", () => {
  it("serves the bytes of an allowed host", async () => {
    const res = await call("https://images.unsplash.com/photo-1.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=86400");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from(PNG))).toBe(true);
    // The upstream request carries no cookie and no Referer of this app.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("NoemaBot");
    expect(JSON.stringify(init.headers)).not.toContain("cookie");
  });

  it("never follows a redirect", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    const res = await call("https://images.unsplash.com/r");
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Redirect refused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = fetchMock.mock.calls.map(([target]) => String(target));
    expect(requested.some((target) => target.includes("169.254.169.254"))).toBe(false);
  });

  it("415s a response that is not an image", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await call("https://images.unsplash.com/a.png");
    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({ error: "Not an image" });
  });

  it("415s an SVG that is not safe to render", async () => {
    fetchMock.mockResolvedValue(
      imageResponse(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        "image/svg+xml",
      ),
    );
    const res = await call("https://images.unsplash.com/a.svg");
    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({ error: "Unsafe image" });
  });

  it("413s a body over the cap", async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array(5 * 1024 * 1024 + 1)));
    const res = await call("https://images.unsplash.com/big.png");
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "Image too large" });
  });

  it("429s once the budget for a host is spent", async () => {
    for (let i = 0; i < 120; i += 1) {
      const res = await call("https://images.unsplash.com/a.png");
      expect(res.status, `request ${i}`).toBe(200);
    }
    const limited = await call("https://images.unsplash.com/a.png");
    expect(limited.status).toBe(429);
  });
});
