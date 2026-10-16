import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for `api/cron/jobs`: the CRON_SECRET guard + rate-limit edge
 * (characterization) and the enqueue → claim → complete / fail → backoff →
 * dead-letter lifecycle driven end-to-end through the route, so the
 * `src/lib/job-queue.ts` state machine has a real production caller.
 *
 * The route's queue is module-level, so each test gets a fresh module (and a
 * fresh rate-limit store) via `vi.resetModules()`.
 */

const SECRET = "cron-test-secret";

type RouteModule = typeof import("./route");

let route: RouteModule;

async function loadFreshRoute(): Promise<void> {
  vi.resetModules();
  const rateLimit = await import("@/lib/rate-limit");
  rateLimit.resetRateLimits();
  route = await import("./route");
}

const URL = "http://localhost/api/cron/jobs";

function get(headers: Record<string, string> = {}): Promise<Response> {
  return route.GET(
    new Request(URL, {
      headers: { "x-cron-secret": SECRET, "x-forwarded-for": "10.9.0.1", ...headers },
    }),
  );
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return route.POST(
    new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": SECRET,
        "x-forwarded-for": "10.9.0.2",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  process.env.CRON_SECRET = SECRET;
  await loadFreshRoute();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
});

describe("guards (characterization — must not weaken)", () => {
  it("503 when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = await get();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("CRON_SECRET"),
    });
  });

  it("401 on a wrong x-cron-secret", async () => {
    const res = await get({ "x-cron-secret": "nope" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("400 on a body with no kind", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: '"kind" is required.' });
  });
});

describe("lifecycle — enqueue, claim, complete", () => {
  it("POST enqueues a queued job and GET drains it to done", async () => {
    const enqueued = await post({ kind: "noop", payload: { note: "hello" } });
    expect(enqueued.status).toBe(202);
    const { job } = await enqueued.json();
    expect(job).toMatchObject({
      kind: "noop",
      payload: { note: "hello" },
      status: "queued",
      attempts: 0,
    });

    const drained = await get();
    expect(drained.status).toBe(200);
    await expect(drained.json()).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      retried: 0,
      dead: 0,
      stats: { total: 1, done: 1 },
    });
  });

  it("a not-yet-due job (delayMs) is not claimed", async () => {
    await post({ kind: "noop", delayMs: 60_000 });
    await expect((await get()).json()).resolves.toMatchObject({ claimed: 0, stats: { queued: 1 } });
  });
});

describe("lifecycle — fail, backoff, dead-letter", () => {
  it("an unregistered kind retries on backoff, then dead-letters when attempts are spent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await post({ kind: "mystery", maxAttempts: 2 });

    // Attempt 1 fails → requeued 1_000 ms later (default backoff base).
    const first = await (await get()).json();
    expect(first).toMatchObject({ claimed: 1, completed: 0, retried: 1, dead: 0 });
    expect(first.stats.queued).toBe(1);

    // Not due yet at the same instant.
    await expect((await get()).json()).resolves.toMatchObject({ claimed: 0 });

    // Once the backoff elapses, attempt 2 is the last → dead-lettered.
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const second = await (await get()).json();
    expect(second).toMatchObject({ claimed: 1, completed: 0, retried: 0, dead: 1 });
    expect(second.stats.dead).toBe(1);
  });
});
