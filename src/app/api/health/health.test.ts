import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B62 — GET /api/health (spec R28.24): liveness + readiness probe.
 *
 * The whole public contract:
 *   200 { ok: true,  db: "up"   }  when a trivial prisma query succeeds
 *   503 { ok: false, db: "down" }  when it fails, hangs, or the DB is gone
 *
 * Hard requirements under test:
 * - no auth — the compose healthcheck has no session (mock factory below
 *   throws if the route even imports the auth stack);
 * - no info disclosure — the 503 body is the exact same shape as the 200;
 *   error text, versions and env values must never reach the client;
 * - cheap and cache-safe — one bounded ping, `cache-control: no-store` so
 *   load-balancer probes never get a cached answer.
 *
 * Integration-style, same pattern as export-routes.test.ts: the real handler
 * runs, only the transport edge (`@/lib/db`) is mocked.
 */

const db = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: db.queryRaw } }));

// If the health route ever pulls in the auth stack, this factory throws at
// import time: a probe must be able to answer with no cookies at all.
vi.mock("@/lib/auth", () => {
  throw new Error("/api/health must not import the auth stack");
});

import { GET as health } from "./route";

const CANARY = "canary-do-not-echo-b62";
const prevSecret = process.env.AUTH_SECRET;

// The handler takes no arguments at all: a probe must not need headers,
// cookies or even the URL to answer.
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  db.queryRaw.mockReset();
  db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  process.env.AUTH_SECRET = CANARY;
});

afterEach(() => {
  vi.useRealTimers();
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});

describe("GET /api/health (R28.24)", () => {
  it("200 {ok:true,db:'up'} when the trivial prisma query succeeds", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ ok: true, db: "up" });
  });

  it("no auth: answers with no WWW-Authenticate and no Set-Cookie", async () => {
    const up = await health();
    expect(up.headers.get("www-authenticate")).toBeNull();
    expect(up.headers.get("set-cookie")).toBeNull();

    db.queryRaw.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const down = await health();
    expect(down.status).toBe(503);
    expect(down.headers.get("www-authenticate")).toBeNull();
    expect(down.headers.get("set-cookie")).toBeNull();
  });

  it("503 {ok:false,db:'down'} when the query fails — no error detail leaks", async () => {
    db.queryRaw.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5433 user=noema password=noema"),
    );
    const res = await health();
    expect(res.status).toBe(503);
    // Exact body: any extra field (message, stack, host, user) fails this.
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
  });

  it("body keys are exactly [db, ok] — no version/env/secret disclosure", async () => {
    const up = await health();
    const upBody = await bodyOf(up);
    expect(Object.keys(upBody).sort()).toEqual(["db", "ok"]);

    db.queryRaw.mockRejectedValue(new Error("boom"));
    const down = await health();
    const downBody = await bodyOf(down);
    expect(Object.keys(downBody).sort()).toEqual(["db", "ok"]);

    const serialized = JSON.stringify([upBody, downBody]);
    expect(serialized).not.toContain(CANARY); // AUTH_SECRET never echoes
    expect(serialized).not.toMatch(/version|node|next|prisma|ECONNREFUSED/i);
  });

  it("bounded: a hung DB ping answers 503 instead of hanging the probe", async () => {
    vi.useFakeTimers();
    db.queryRaw.mockReturnValue(new Promise(() => {})); // never settles
    const pending = health();
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
  });

  it("no-store: probes are never answered from a cache", async () => {
    const res = await health();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
