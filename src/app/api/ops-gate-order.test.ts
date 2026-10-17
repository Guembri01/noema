import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * B30 — the ops gate: **the rate limit runs before the secret comparison**.
 *
 * RED-first against the routes as shipped. In eight of the nine ops gates the
 * secret was compared *first* and throttled *afterwards*, so a wrong secret
 * was answered 401 forever: the guessing was unbounded, and the limit that
 * was supposed to bound it never saw the attempt. The comparison itself was
 * a plain `===` on two strings, which returns at the first differing byte.
 *
 * The shared gate (`@/lib/ops-guard`) now owns the order — 503 (no secret
 * configured) → rate limit → constant-time comparison — so a wrong secret is
 * throttled instead of probing the comparison.
 *
 * The routes are exercised end to end; only the transport edges are mocked.
 * The limiter is mocked to answer 429 on demand: that is the point of the
 * test — *what the route answers when the limit is already spent*.
 *
 * A timing test is deliberately absent (it would be unreliable). The proof
 * that the comparison is constant time is structural: the gate compares with
 * `safeSecretEqual` (`@/lib/ops-guard`), which delegates to the repo's
 * `constantTimeEqual` (`@/lib/secrets`), and the last describe block greps
 * the nine gate files for a surviving `===`/`!==` on a secret.
 */

const limit = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/lib/api-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-guard")>();
  const { NextResponse } = await import("next/server");
  return {
    ...actual,
    rateLimit: vi.fn(() =>
      limit.blocked
        ? NextResponse.json(
            { error: "Rate limit exceeded" },
            { status: 429, headers: { "retry-after": "60" } },
          )
        : null,
    ),
  };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  class BlockableTokenBucket {
    hit(): { allowed: boolean; remaining: number; retryAfterMs: number; limit: number; resetAt: number } {
      return limit.blocked
        ? { allowed: false, remaining: 0, retryAfterMs: 60_000, limit: 1, resetAt: Date.now() + 60_000 }
        : { allowed: true, remaining: 1, retryAfterMs: 0, limit: 1, resetAt: Date.now() };
    }
  }
  return { ...actual, TokenBucketLimiter: BlockableTokenBucket };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ "1": 1 }]),
    $transaction: vi.fn(),
    workspace: { findUnique: vi.fn(async () => ({ name: "Demo" })), update: vi.fn(async () => ({ ticketCounter: 1 })) },
    ticket: { create: vi.fn(async () => ({ id: "t1" })) },
  },
}));

vi.mock("@/server/actions/automations", () => ({
  listDueAutomationsForCronAction: vi.fn(async () => ({
    ok: true,
    scheduled: [],
    recurring: [],
  })),
  commitRecurringRunAction: vi.fn(async () => ({ ok: true })),
}));

import { GET as readyGet } from "./ready/route";
import { GET as jobsGet } from "./cron/jobs/route";
import { POST as ticketsPost } from "./cron/tickets/route";

const SECRET = "cron-test-secret";

type Gate = {
  /** The gate's name — also the id of the `describe` block. */
  name: string;
  /** Call the route with the given headers. */
  call: (headers: Record<string, string>) => Promise<Response>;
};

function gate(name: string, url: string, handler: (request: Request) => Promise<Response>): Gate {
  return {
    name,
    call: (headers) =>
      handler(
        new Request(url, {
          method: "GET",
          headers: { "x-forwarded-for": "10.60.0.1", ...headers },
        }),
      ),
  };
}

const GATES: Gate[] = [
  gate("GET /api/ready", "http://localhost/api/ready", readyGet),
  gate("GET /api/cron/jobs", "http://localhost/api/cron/jobs", jobsGet),
  {
    name: "POST /api/cron/tickets",
    call: (headers) =>
      ticketsPost(
        new Request("http://localhost/api/cron/tickets", {
          method: "POST",
          headers: { "x-forwarded-for": "10.60.0.2", ...headers },
        }),
      ),
  },
];

beforeEach(() => {
  limit.blocked = false;
  process.env.CRON_SECRET = SECRET;
  delete process.env.READY_SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.READY_SECRET;
});

describe.each(GATES)("$name — the ops gate", ({ call }) => {
  it("503 when CRON_SECRET is unset (fail closed, unchanged)", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ "x-cron-secret": SECRET });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("CRON_SECRET"),
    });
  });

  it("401 on a wrong secret (unchanged)", async () => {
    const res = await call({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("429 on a wrong secret once the limit is spent — the limit runs FIRST", async () => {
    limit.blocked = true;
    const res = await call({ "x-cron-secret": "wrong" });
    // Before the fix the route answered 401 here: the comparison ran before
    // the limit, so the guessing was unbounded.
    expect(res.status).toBe(429);
  });

  it("429 on a correct secret once the limit is spent (the limit covers legitimate calls too)", async () => {
    limit.blocked = true;
    const res = await call({ "x-cron-secret": SECRET });
    expect(res.status).toBe(429);
  });

  it("lets a correct secret through when the limit is not spent", async () => {
    const res = await call({ "x-cron-secret": SECRET });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    // The gate answered with its own `{ error }` body in every rejection
    // case; a payload without an `error` key means the gate let the request
    // through (the readiness probe answers 503 with a readiness payload when
    // the deployment is not ready — that is not a gate rejection).
    expect(body.error).toBeUndefined();
  });
});

describe("the ops gate — no `===` on a secret survives", () => {
  const repoFile = (relative: string): string =>
    fileURLToPath(new URL(relative, import.meta.url));

  /** The nine ops gates: the shared comparison has to be the one they use. */
  const GATE_FILES = [
    "../../app/api/ready/route.ts",
    "../../app/api/metrics/route.ts",
    "../../app/api/cron/templates/route.ts",
    "../../app/api/cron/versions/route.ts",
    "../../app/api/cron/jobs/route.ts",
    "../../app/api/cron/tickets/route.ts",
    "../../app/api/cron/digest/route.ts",
    "../../app/api/cron/backups/route.ts",
    "../../server/actions/automations.ts",
  ];

  const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
    {
      name: "a header value compared with ===/!==",
      pattern: /headers\.get\([^)]*\)\s*(===|!==)/,
    },
    { name: "a presented secret compared with ===/!==", pattern: /\bprovided\s*(===|!==)/ },
    {
      name: "the configured secret compared with ===/!==",
      pattern: /\bsecret\s*(===|!==)\s*[A-Za-z_$]/,
    },
    {
      name: "the expected secret compared with ===/!==",
      pattern: /\bexpected\s*(===|!==)\s*[A-Za-z_$]/,
    },
  ];

  it.each(GATE_FILES)("%s uses the shared ops gate", (relative) => {
    const source = readFileSync(repoFile(relative), "utf8");
    expect(source).toContain("@/lib/ops-guard");
  });

  it.each(GATE_FILES)("%s compares the secret in constant time", (relative) => {
    const source = readFileSync(repoFile(relative), "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      expect(source, `${relative}: ${name}`).not.toMatch(pattern);
    }
  });
});
