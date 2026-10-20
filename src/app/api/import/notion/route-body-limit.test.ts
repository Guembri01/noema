import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B22 — the import route bounds the body it reads.
 *
 * The property under test is that the budget holds when the client lies about
 * the body size: `Content-Length` is a request header, so a missing one must
 * not read as "small" and a wrong one must not buy an unbounded body.
 */

const action = vi.hoisted(() => ({
  importNotionPageAction: vi.fn(async () => ({
    ok: true,
    id: "page-1",
    slug: "demo",
    pages: 1,
  })),
  importHtmlAction: vi.fn(async () => ({ error: "unused" })),
  importPdfAction: vi.fn(async () => ({ error: "unused" })),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/server/actions/notion-import", () => ({
  importNotionPageAction: action.importNotionPageAction,
}));
vi.mock("@/server/actions/import-formats", () => ({
  importHtmlAction: action.importHtmlAction,
  importPdfAction: action.importPdfAction,
}));

import { POST } from "./route";

/** The route's own budget (16 MiB) — one byte more is already too much. */
const OVER_BUDGET = 16 * 1024 * 1024 + 1;

/**
 * The `RequestInit` for a request whose body is a stream.
 *
 * Node/undici wants `duplex: "half"` for a streamed request body; the DOM
 * typings of this TypeScript version do not know the property, so it is added
 * here instead of being cast away at the call site.
 */
type StreamRequestInit = RequestInit & { duplex: "half" };

/** A request whose body is `size` bytes, sent in 1 MiB chunks. */
function bigRequest(size: number, headers: Record<string, string> = {}): Request {
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let sent = 0;
      while (sent < size) {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
        await Promise.resolve();
      }
      controller.close();
    },
  });
  const init: StreamRequestInit = {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json", ...headers },
  };
  return new Request("http://localhost/api/import/notion", init);
}

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("POST /api/import/notion — the body budget (B22)", () => {
  it("refuses a body over the budget when the request carries no Content-Length", async () => {
    const request = bigRequest(OVER_BUDGET);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large." });
    expect(action.importNotionPageAction).not.toHaveBeenCalled();
  });

  it("refuses a body over the budget when the request lies about its length", async () => {
    const request = bigRequest(OVER_BUDGET, { "content-length": "10" });
    expect(request.headers.get("content-length")).toBe("10");

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large." });
    expect(action.importNotionPageAction).not.toHaveBeenCalled();
  });

  it("refuses on the declared length alone", async () => {
    const request = bigRequest(1024, { "content-length": String(OVER_BUDGET) });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(action.importNotionPageAction).not.toHaveBeenCalled();
  });

  it("passes a body that fits into the budget to the importer", async () => {
    const request = new Request("http://localhost/api/import/notion", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-1", token: "secret_test_token", pageId: "p-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(action.importNotionPageAction).toHaveBeenCalledTimes(1);
  });

  it("still answers 400 for a malformed body", async () => {
    const request = new Request("http://localhost/api/import/notion", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body." });
  });
});
