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

const ok = (payload: unknown) => () => Promise.resolve(NextResponse.json(payload, { status: 201 }));

afterEach(() => {
  resetIdempotencyStore();
  vi.useRealTimers();
});

describe("withIdempotency", () => {
  it("runs the handler every time when the caller sends no key", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    const first = await withIdempotency(post({ workspaceId: "w1" }), { userId: "u1" }, handler);
    const second = await withIdempotency(post({ workspaceId: "w1" }), { userId: "u1" }, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(first.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
  });

  it("performs the mutation once and replays the stored outcome", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    const first = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    const replay = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
    expect(await replay.json()).toEqual({ page: { id: "p1" } });
  });

  it("replays a stored *failure* too, so a rejected retry stays rejected", async () => {
    const handler = vi.fn(() => Promise.resolve(NextResponse.json({ error: "Forbidden" }, { status: 403 })));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    const replay = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replay.status).toBe(403);
  });

  it("refuses to reuse a key for a different body", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1", title: "One" }, "k1"), { userId: "u1" }, handler);
    const clash = await withIdempotency(post({ workspaceId: "w1", title: "Two" }, "k1"), { userId: "u1" }, handler);

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

    const inFlight = withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    const concurrent = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);

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

    const failed = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not cache a 429, because rate limiting belongs to the attempt", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce(NextResponse.json({ error: "slow down" }, { status: 429 }))
      .mockResolvedValueOnce(NextResponse.json({ page: { id: "p1" } }, { status: 201 }));

    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    expect(retried.status).toBe(201);
  });

  it("does not stand in the way after the handler throws", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(NextResponse.json({ page: { id: "p1" } }, { status: 201 }));

    await expect(withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler)).rejects.toThrow(
      "db down",
    );
    const retried = await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    expect(retried.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("scopes keys per user and per endpoint", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1" }, "shared"), { userId: "u1" }, handler);
    await withIdempotency(post({ workspaceId: "w1" }, "shared"), { userId: "u2" }, handler);

    // Two principals picking the same key must not replay each other's result.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("ignores safe methods entirely", async () => {
    const handler = vi.fn(() => Promise.resolve(NextResponse.json({ ok: true })));
    const request = new Request("https://app.local/api/v1/pages?workspaceId=w1", {
      method: "GET",
      headers: { "Idempotency-Key": "k1" },
    });
    await withIdempotency(request, { userId: "u1" }, handler);
    await withIdempotency(request, { userId: "u1" }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(idempotencyStoreSize()).toBe(0);
  });

  it("stops replaying after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + IDEMPOTENCY_TTL_MS + 1000));
    await withIdempotency(post({ workspaceId: "w1" }, "k1"), { userId: "u1" }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: the oldest entry is dropped past the cap", async () => {
    const handler = vi.fn(ok({ page: { id: "p1" } }));
    for (let index = 0; index < IDEMPOTENCY_MAX_ENTRIES + 5; index += 1) {
      await withIdempotency(post({ workspaceId: "w1" }, `k${index}`), { userId: "u1" }, handler);
    }
    expect(idempotencyStoreSize()).toBe(IDEMPOTENCY_MAX_ENTRIES);

    // The very first key has been evicted, so it runs again rather than replaying.
    await withIdempotency(post({ workspaceId: "w1" }, "k0"), { userId: "u1" }, handler);
    expect(handler).toHaveBeenCalledTimes(IDEMPOTENCY_MAX_ENTRIES + 6);
  });
});
