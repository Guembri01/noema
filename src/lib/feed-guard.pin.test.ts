import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchPinned } from "./feed-guard";

/**
 * The production transport, not the offline double: a request to a hostname
 * that the system resolver cannot resolve must still reach the address the
 * guard validated. That is the DNS pinning property — checking one answer and
 * then fetching a second one would leave the rebinding window open.
 */
describe("fetchPinned", () => {
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

  it("refuses a target the guard blocks before opening a socket", async () => {
    await expect(
      fetchPinned(`http://127.0.0.1:${port}/hello`),
    ).rejects.toThrow("Blocked target.");
  });
});
