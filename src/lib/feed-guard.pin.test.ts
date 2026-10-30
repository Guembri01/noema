import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchPinned, fetchPinnedTarget, LOOPBACK_TARGET_OPT_IN_ENV } from "./feed-guard";

/**
 * The production transport, not the offline double: a request to a hostname
 * that the system resolver cannot resolve must still reach the address the
 * guard validated. That is the DNS pinning property — checking one answer and
 * then fetching a second one would leave the rebinding window open.
 */
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end(`host=${request.headers.host ?? ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no port");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("fetchPinned", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("connects to the validated address while keeping the URL host", async () => {
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");
    const response = await fetchPinned(
      `http://pin.test:${port}/hello`,
      { headers: { accept: "text/plain" } },
      {
        allowLoopbackWithOptIn: true,
        // `pin.test` is not in DNS; only the pinned answer can make this work.
        resolve: async () => ["127.0.0.1"],
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`host=pin.test:${port}`);
  });

  it("maps an exempt localhost name to the IPv4 loopback address", async () => {
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");
    const response = await fetchPinned(
      `http://localhost:${port}/hello`,
      {},
      { allowLoopbackWithOptIn: true },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`host=localhost:${port}`);
  });

  it("refuses a target the guard blocks before opening a socket", async () => {
    await expect(
      fetchPinned(`http://127.0.0.1:${port}/hello`),
    ).rejects.toThrow("Blocked target.");
  });
});

/**
 * The transport `fetchPinnedTarget` uses (P3-T08). A replaced `globalThis.fetch`
 * is an offline test double or an operator's instrumentation — legitimate in a
 * development or test run, where the double keeps the suite hermetic — but it
 * would bypass the DNS pinning in the shipped process, where nothing has a
 * reason to replace the transport. So production refuses the replacement
 * (fail closed) and every other mode honours it with a warning.
 */
describe("fetchPinnedTarget - the transport itself", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("refuses a replaced transport in production instead of sending unpinned", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const double = vi.fn();
    globalThis.fetch = double as unknown as typeof globalThis.fetch;
    await expect(
      fetchPinnedTarget(`http://pin.test:${port}/hello`, {}, "127.0.0.1"),
    ).rejects.toThrow(/global fetch was replaced/);
    expect(double).not.toHaveBeenCalled();
  });

  it("the B11 operator opt-in convoy honours a replaced transport in production", async () => {
    // The hermetic receiver scenario: `scripts/check-webhooks.mjs` runs the
    // shipped payload (`NODE_ENV=production`) against a loopback receiver, the
    // guard allows the target under `NOEMA_ALLOW_LOOPBACK_TARGETS`, and the
    // delivery has to travel through the instrumentation. A `NODE_ENV` rule
    // cannot serve both that and the guard (`isBlockedOutboundTarget`'s own
    // doctrine), so the opt-in exempts the production refuse here too.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(LOOPBACK_TARGET_OPT_IN_ENV, "1");
    const double = vi.fn(async () => new Response("double", { status: 200 }));
    globalThis.fetch = double as unknown as typeof globalThis.fetch;
    const response = await fetchPinnedTarget(
      `http://127.0.0.1:${port}/hook`,
      {},
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("double");
    expect(double).toHaveBeenCalledTimes(1);
    // Production + opt-in is deliberate, not an accident to warn about.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(warn).toHaveBeenCalledTimes(0);
    warn.mockRestore();
  });

  it("honours a replaced transport with a warning in development and test", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const mode of ["development", "test"] as const) {
      vi.stubEnv("NODE_ENV", mode);
      const double = vi.fn(async () => new Response("double", { status: 200 }));
      globalThis.fetch = double as unknown as typeof globalThis.fetch;
      const response = await fetchPinnedTarget(
        `http://pin.test:${port}/hello`,
        {},
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("double");
      expect(double).toHaveBeenCalledTimes(1);
      // Exactly one warning per replaced-transport call, naming the bypass.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("the global fetch was replaced"),
      );
      warn.mockClear();
    }
    warn.mockRestore();
  });

  it("keeps the pinned connection on the native transport, production included", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Untouched transport: the production assert must NOT fire, and the
    // request goes out pinned — to the validated address, keeping the host.
    const response = await fetchPinnedTarget(
      `http://pin.test:${port}/hello`,
      { headers: { accept: "text/plain" } },
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`host=pin.test:${port}`);
  });
});
