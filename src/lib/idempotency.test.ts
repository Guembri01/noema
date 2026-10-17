import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENCY_TTL_MS,
  idempotencyStoreSize,
  resetIdempotencyStore,
  withIdempotency,
} from "./idempotency";

/**
 * Idempotency keys exist so a retried `POST` cannot create the same page twice.
 * These tests pin the contract a client depends on: replay, refusal to reuse a
 * key for different content, "wait" while the first attempt is running, and the
 * guarantee that a failure is never cached.
 */

const post = (body: unknown, key?: string) =>
  new Request("https://app.local/api/v1/pages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    body: JSON.stringify(body),
  });

/**
 * The `RequestInit` for a request whose body is a stream.
 *
 * Node/undici wants `duplex: "half"` for a streamed request body; the DOM
 * typings of this TypeScript version do not know the property, so it is added
 * here instead of being cast away at the call site.
 */
type StreamRequestInit = RequestInit & { duplex: "half" };

/**
 * A request whose body is `body`, delivered in chunks of `chunkSize` bytes —
 * the framing a chunked transfer-encoding produces (no `Content-Length`).
 */
function chunkedRequest(
  body: Uint8Array<ArrayBuffer>,
  chunkSize: number,
  headers: Record<string, string>,
): Request {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(body.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  const init: StreamRequestInit = {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  };
  return new Request("https://app.local/api/v1/pages", init);
}

/**
 * A request whose body is `body` and that declares its length.
 *
 * `declared` overrides the header, so a test can lie about the size — which
 * is what a client can do, and what the fingerprint must not depend on.
 */
function requestWithLength(
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  declared: number = body.byteLength,
): Request {
  return new Request("https://app.local/api/v1/pages", {
    method: "POST",
    headers: { ...headers, "content-length": String(declared) },
    body,
  });
}

const ok = (payload: unknown) => () => Promise.resolve(NextResponse.json(payload, { status: 201 }));

/**
 * The byte budget the tests read their bodies under — the fingerprint is
 * measured over exactly this budget.
 */
const BODY_BUDGET = 1024 * 1024;

afterEach(() => {
  resetIdempotencyStore();
  vi.useRealTimers();
});

describe("withIdempotency", () => {
  it("runs the handler every time when the caller sends no key", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    const first = await withIdempotency(post({ workspaceId: "w1" }), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const second = await withIdempotency(post({ workspaceId: "w1" }), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(first.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
  });

  it("performs the mutation once and replays the stored outcome", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    const first = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const replay = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
    expect(await replay.json()).toEqual({ page: { id: "p1" } });
  });

  it("replays a stored *failure* too, so a rejected retry stays rejected", async () => {
    const handler = vi.fn(() => Promise.resolve(NextResponse.json({ error: "Forbidden" }, { status: 403 })));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const replay = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replay.status).toBe(403);
  });

  it("refuses to reuse a key for a different body", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1", title: "One" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const clash = await withIdempotency(post({ workspaceId: "w1", title: "Two" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(clash.status).toBe(422);
    expect((await clash.json()).error).toBe("idempotency_key_reuse");
    // The second request must not have mutated anything.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("tells a concurrent retry to wait instead of running the work twice", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await gate;
      return NextResponse.json({ page: { id: "p1" } }, { status: 201 });
    });

    const inFlight = withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const concurrent = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(concurrent.status).toBe(409);
    expect((await concurrent.json()).error).toBe("idempotency_in_progress");
    expect(concurrent.headers.get("Retry-After")).toBe("1");
    expect(handler).toHaveBeenCalledTimes(1);

    release?.();
    expect((await inFlight).status).toBe(201);
  });

  it("does not cache a 5xx, so a retry is allowed to run", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce(NextResponse.json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(NextResponse.json({ page: { id: "p1" } }, { status: 201 }));

    const failed = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not cache a 429, because rate limiting belongs to the attempt", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce(NextResponse.json({ error: "slow down" }, { status: 429 }))
      .mockResolvedValueOnce(NextResponse.json({ page: { id: "p1" } }, { status: 201 }));

    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(retried.status).toBe(201);
  });

  it("does not stand in the way after the handler throws", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(NextResponse.json({ page: { id: "p1" } }, { status: 201 }));

    await expect(withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler)).rejects.toThrow(
      "db down",
    );
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(retried.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("scopes keys per user and per endpoint", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1" }, "shared"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    await withIdempotency(post({ workspaceId: "w1" }, "shared"), { userId: "u2", bodyBudget: BODY_BUDGET }, handler);

    // Two principals picking the same key must not replay each other's result.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("ignores safe methods entirely", async () => {
    const handler = vi.fn(() => Promise.resolve(NextResponse.json({ ok: true })));
    const request = new Request("https://app.local/api/v1/pages?workspaceId=w1", {
      method: "GET",
      headers: { "Idempotency-Key": "k1" },
    });
    await withIdempotency(request, { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    await withIdempotency(request, { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(idempotencyStoreSize()).toBe(0);
  });

  it("stops replaying after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + IDEMPOTENCY_TTL_MS + 1000));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: the oldest entry is dropped past the cap", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    for (let index = 0; index < IDEMPOTENCY_MAX_ENTRIES + 5; index += 1) {
      await withIdempotency(post({ workspaceId: "w1" }, `k${index}`), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    }
    expect(idempotencyStoreSize()).toBe(IDEMPOTENCY_MAX_ENTRIES);

    // The very first key has been evicted, so it runs again rather than replaying.
    await withIdempotency(post({ workspaceId: "w1" }, "k0"), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    expect(handler).toHaveBeenCalledTimes(IDEMPOTENCY_MAX_ENTRIES + 6);
  });

  it("does not read a body past the fingerprint budget (B22)", async () => {
    // A body far larger than the budget: the helper must not read all of
    // it — that would defeat the route's own body budget.
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunk.byteLength;
        if (produced > 8 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const init: StreamRequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "big" },
      body: stream,
      duplex: "half",
    };
    const request = new Request("https://app.local/api/v1/pages", init);

    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(request, { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    // The scan stopped at the budget; the rest of the body (8 MiB) was never
    // pulled. The producer runs a few chunks ahead of the reader, hence the
    // slack.
    expect(produced).toBeLessThanOrEqual(BODY_BUDGET + 8 * chunk.byteLength);
    expect(produced).toBeLessThan(8 * 1024 * 1024);
  });

  it("replays a retry of the same body, however it was framed (B22)", async () => {
    // The same bytes, once chunked (no `Content-Length`) and once with one.
    // The fingerprint must not depend on the framing — otherwise a legitimate
    // retry of a body over the scan limit is refused with 422.
    const body = Buffer.alloc(100 * 1024, 0x61);
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "retry" };

    const chunked = chunkedRequest(body, 4096, headers);
    expect(chunked.headers.get("content-length")).toBeNull();
    const declared = requestWithLength(body, headers);
    expect(declared.headers.get("content-length")).toBe(String(body.length));

    const handler = vi.fn(ok({ page: { id: "p1" } }));
    const first = await withIdempotency(chunked, { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const retry = await withIdempotency(declared, { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(first.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
  });

  it("refuses a key that is reused for a different body of the same declared length (B22)", async () => {
    // Two bodies that share their beginning and declare the *same* length:
    // the fingerprint has to tell them apart, or the second mutation would be
    // silently answered with the first one's response.
    const shared = Buffer.alloc(4096, 0x62);
    const first = Buffer.concat([shared, Buffer.alloc(100 * 1024 - 4096, 0x63)]);
    const second = Buffer.concat([shared, Buffer.alloc(100 * 1024 - 4096, 0x64)]);
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "clash" };

    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(requestWithLength(first, headers), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const clash = await withIdempotency(requestWithLength(second, headers), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(clash.status).toBe(422);
    expect((await clash.json()).error).toBe("idempotency_key_reuse");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("tells two bodies apart by their measured length (B22)", async () => {
    // The same beginning and a different length — and both declare the *same*
    // length, so only the measured one can tell them apart. The declared
    // length is the client's to choose; the measured one is not.
    const shared = Buffer.alloc(64 * 1024, 0x66);
    const first = Buffer.concat([shared, Buffer.alloc(100 * 1024, 0x67)]);
    const second = Buffer.concat([shared, Buffer.alloc(900 * 1024, 0x67)]);
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "length" };
    const declared = 100 * 1024;

    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(requestWithLength(first, headers, declared), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const clash = await withIdempotency(requestWithLength(second, headers, declared), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(clash.status).toBe(422);
    expect((await clash.json()).error).toBe("idempotency_key_reuse");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("pins the limit of the fingerprint window: bodies that share it and their length are one request (B22)", async () => {
    // The fingerprint compares the first 64 KiB of the body and its *measured*
    // length. Two bodies that share both cannot be told apart — the
    // documented limit of the window, and a strictly smaller set of
    // collisions than the old fingerprint (which compared 4 KB of content).
    const shared = Buffer.alloc(64 * 1024, 0x65);
    const first = Buffer.concat([shared, Buffer.from("first")]);
    const second = Buffer.concat([shared, Buffer.from("other")]);
    expect(first.byteLength).toBe(second.byteLength);
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "window" };

    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(requestWithLength(first, headers), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);
    const retry = await withIdempotency(requestWithLength(second, headers), { userId: "u1", bodyBudget: BODY_BUDGET }, handler);

    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
