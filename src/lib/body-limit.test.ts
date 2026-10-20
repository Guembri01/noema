import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  bodyReadError,
  declaredBodyLength,
  readBodyBytes,
  readFormDataBody,
  readJsonBody,
  readTextBody,
} from "@/lib/body-limit";

/**
 * B22 — the body budget of the route handlers.
 *
 * The important property is not "a header is checked" but "the budget holds
 * when the header lies or is missing": `Content-Length` is chosen by the
 * client, so it can only ever be a fast path.
 */

const LIMIT = 1024;

/**
 * The `RequestInit` for a request whose body is a stream.
 *
 * Node/undici wants `duplex: "half"` for a streamed request body; the DOM
 * typings of this TypeScript version do not know the property, so it is added
 * here — once — instead of being cast away at every call site.
 */
type StreamRequestInit = RequestInit & { duplex: "half" };

/** A request whose body is a stream. */
function streamedRequest(
  url: string,
  body: ReadableStream<Uint8Array>,
  init: RequestInit = {},
): Request {
  const streamInit: StreamRequestInit = { ...init, body, duplex: "half" };
  return new Request(url, streamInit);
}

/** A request whose body is `size` bytes and that carries no Content-Length. */
function requestWithoutLength(size: number, contentType = "application/json"): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(0x61));
      controller.close();
    },
  });
  return streamedRequest("http://localhost/api/x", stream, {
    method: "POST",
    headers: { "content-type": contentType },
  });
}

/** A request whose body is `size` bytes but that declares a smaller length. */
function requestWithLyingLength(size: number, declared: number): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(0x61));
      controller.close();
    },
  });
  return streamedRequest("http://localhost/api/x", stream, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(declared) },
  });
}

describe("declaredBodyLength()", () => {
  it("reads the header when it is a plain decimal number", () => {
    const request = new Request("http://localhost/api/x", {
      headers: { "content-length": "1234" },
    });
    expect(declaredBodyLength(request)).toBe(1234);
  });

  it("returns null when the header is missing — a missing header is not a small body", () => {
    const request = new Request("http://localhost/api/x");
    expect(declaredBodyLength(request)).toBeNull();
  });

  it("returns null for a header that is not a plain number", () => {
    const request = new Request("http://localhost/api/x", {
      headers: { "content-length": "12abc" },
    });
    expect(declaredBodyLength(request)).toBeNull();
  });
});

describe("readBodyBytes()", () => {
  it("reads a body that fits into the budget", async () => {
    const bytes = await readBodyBytes(requestWithoutLength(100), LIMIT);
    expect(bytes.byteLength).toBe(100);
  });

  it("refuses a body over the budget when the header is missing", async () => {
    const request = requestWithoutLength(LIMIT + 1);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readBodyBytes(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("refuses a body over the budget when the header lies and claims it is small", async () => {
    const request = requestWithLyingLength(LIMIT + 1, 10);
    expect(request.headers.get("content-length")).toBe("10");
    await expect(readBodyBytes(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("cancels the source when the body exceeds the budget", async () => {
    // The budget must stop the read *and* release the stream: leaving it open
    // keeps a connection (and a server-side producer) alive for a request that
    // can never succeed.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(LIMIT + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = streamedRequest("http://localhost/api/x", stream, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    await expect(readBodyBytes(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("refuses on the declared length alone, without waiting for the body", async () => {
    // The stream stays open: if the implementation read the body instead of
    // refusing on the header, this test would hang instead of failing.
    let sent = false;
    let open: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        open = controller;
      },
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new Uint8Array(8));
      },
    });
    const request = streamedRequest("http://localhost/api/x", stream, {
      method: "POST",
      headers: { "content-length": String(LIMIT + 1) },
    });
    // The controller is captured by the stream's `start`, which the compiler
    // cannot see from here: it is handed out through a function with an
    // explicit return type instead of being cast away.
    const takeController = (): ReadableStreamDefaultController<Uint8Array> | null => open;
    try {
      await expect(readBodyBytes(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    } finally {
      // Close the abandoned stream so nothing is left dangling.
      try {
        takeController()?.close();
      } catch {
        /* already closed */
      }
    }
  });
});

describe("readJsonBody()", () => {
  it("parses a JSON body under the budget", async () => {
    const request = new Request("http://localhost/api/x", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonBody(request, LIMIT)).resolves.toEqual({ hello: "world" });
  });

  it("throws a SyntaxError for a body that is not JSON", async () => {
    const request = new Request("http://localhost/api/x", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("throws BodyTooLargeError for an oversized body without a Content-Length", async () => {
    const request = requestWithoutLength(LIMIT + 1);
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("throws BodyTooLargeError for an oversized body with a lying Content-Length", async () => {
    const request = requestWithLyingLength(LIMIT + 1, 5);
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("readFormDataBody()", () => {
  it("parses a multipart body under the budget", async () => {
    const form = new FormData();
    form.append("workspaceId", "ws-1");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.bin"));
    const request = new Request("http://localhost/api/x", { method: "POST", body: form });
    const parsed = await readFormDataBody(request, LIMIT);
    expect(parsed.get("workspaceId")).toBe("ws-1");
    expect(parsed.get("file")).toBeInstanceOf(File);
  });

  it("refuses an oversized multipart body", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(LIMIT + 1)], "a.bin"));
    const request = new Request("http://localhost/api/x", { method: "POST", body: form });
    await expect(readFormDataBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("readTextBody()", () => {
  it("reads a text body under the budget", async () => {
    const request = new Request("http://localhost/api/x", { method: "POST", body: "hello" });
    await expect(readTextBody(request, LIMIT)).resolves.toBe("hello");
  });

  it("refuses an oversized text body with a lying Content-Length", async () => {
    const request = requestWithLyingLength(LIMIT + 1, 1);
    await expect(readTextBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("bodyReadError()", () => {
  it("answers 413 when the body was over its budget", async () => {
    const response = bodyReadError(new BodyTooLargeError(LIMIT));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large." });
  });

  it("answers 400 with the route's own message for a malformed body", async () => {
    const response = bodyReadError(new SyntaxError("nope"), "Invalid JSON body.");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body." });
  });
});
