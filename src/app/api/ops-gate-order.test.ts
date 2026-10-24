import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * B30 — the ops gate: **the rate limit runs before the secret comparison**.
 *
 * RED-first against the routes as shipped. In seven of the nine gate files the
 * secret was compared *first* and throttled *afterwards* — and the server
 * actions had no limit at all — so a wrong secret was never bounded: the
 * guessing was unbounded, and the limit that was supposed to bound it never
 * saw the attempt. The comparison itself was
 * a plain `===` on two strings, which returns at the first differing byte.
 *
 * The shared gate (`@/lib/ops-guard`) now owns the order — 503 (no secret
 * configured) → rate limit → constant-time comparison — so a wrong secret is
 * throttled instead of probing the comparison.
 *
 * **Every** gate is pinned here, not a sample of them: the `GATES` list
 * below drives all eight ops routes (eleven handlers) through the same five
 * cases, so "the limit runs first" is a *test* and not a code shape:
 *
 *   1. no secret configured ⇒ **503** `{"error":"…is not configured…"}` (fail
 *      closed) — **401** at `/api/metrics`, whose session-admin path would be
 *      locked out by a 503;
 *   2. a wrong secret + a spent budget ⇒ **429** (not 401) — the regression
 *      guard. A route that compared first would answer 401 here and the
 *      guessing would be unbounded;
 *   3. the correct secret + a spent budget ⇒ 429 (the limit covers
 *      legitimate calls too);
 *   4. the correct secret + a free budget ⇒ the request runs (the gate does
 *      not reject it);
 *   5. a wrong secret + a free budget ⇒ 401 `{"error":"Unauthorized"}`.
 *
 * `/api/metrics` is the one exception in the *not configured* case: it has a
 * second, session-based admin path, so without a configured secret it
 * answers **401**, not 503 — a 503 would lock those admins out. Its order
 * (limit before comparison) is the same as everywhere else.
 *
 * The routes are exercised end to end; only the transport edges are mocked.
 * The limiter is mocked to answer 429 on demand: that is the point of the
 * test — *what the route answers when the limit is already spent*.
 *
 * A timing test is deliberately absent (it would be unreliable). The proof
 * that the comparison is constant time is structural: the gate compares with
 * `safeSecretEqual` (`@/lib/ops-guard`), which delegates to the repo's
 * `constantTimeEqual` (`@/lib/secrets`), and the last describe block greps
 * the nine gate files for a surviving `===`/`!==` on a secret *and* the
 * helper's own body for a hand-rolled comparison.
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
    workspace: {
      findUnique: vi.fn(async () => ({ name: "Demo" })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ ticketCounter: 1 })),
    },
    workspaceMember: { findFirst: vi.fn(async () => null) },
    ticket: { create: vi.fn(async () => ({ id: "t1" })) },
    template: { findMany: vi.fn(async () => []) },
    pageVersion: { findMany: vi.fn(async () => []) },
    notification: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/server/actions/automations", () => ({
  listDueAutomationsForCronAction: vi.fn(async () => ({
    ok: true,
    scheduled: [],
    recurring: [],
  })),
  materializeRecurringTicketRunAction: vi.fn(async () => ({
    ok: true,
    created: 0,
    skipped: true,
    keys: [],
    nextRunAt: null,
  })),
}));

// `/api/metrics` has a second, session-based admin path. No session here ⇒
// the route is denied, but it must never answer 503 (that would close the
// admin path as well).
vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => null),
}));

const mailer = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return { ...actual, sendMail: mailer.sendMail };
});

import { GET as readyGet, POST as readyPost } from "./ready/route";
import { GET as metricsGet } from "./metrics/route";
import { POST as templatesPost } from "./cron/templates/route";
import { GET as versionsGet } from "./cron/versions/route";
import { GET as jobsGet, POST as jobsPost } from "./cron/jobs/route";
import { POST as ticketsPost } from "./cron/tickets/route";
import { GET as digestGet, POST as digestPost } from "./cron/digest/route";
import { GET as backupsGet } from "./cron/backups/route";

const SECRET = "cron-test-secret";

type Gate = {
  /** The gate's name — also the id of the `describe` block. */
  name: string;
  /**
   * The status the gate answers when no secret is configured: 503 for the
   * fail-closed routes, 401 for `/api/metrics` (a second, session-based
   * admin path — a 503 would lock the admins out).
   */
  notConfigured: 401 | 503;
  /** Call the route with the given headers. */
  call: (headers: Record<string, string>) => Promise<Response>;
};

type RouteHandler = (request: Request) => Promise<Response>;

/** How a gate is built. */
type GateOptions = {
  /** The JSON body a POST handler receives (omitted ⇒ no body). */
  readonly body?: unknown;
  /** The status when no secret is configured (default: 503). */
  readonly notConfigured?: 401 | 503;
  /** The client address the route sees — keeps the buckets apart. */
  readonly ip: string;
};

function gate(
  name: string,
  method: "GET" | "POST",
  url: string,
  handler: RouteHandler,
  options: GateOptions,
): Gate {
  return {
    name,
    notConfigured: options.notConfigured ?? 503,
    call: (headers) =>
      handler(
        new Request(url, {
          method,
          headers: {
            "x-forwarded-for": options.ip,
            ...(options.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      ),
  };
}

/**
 * The nine ops gates: all eight HTTP routes (eleven handlers) behind the
 * shared ops secret. The order (throttle → compare) is the property under
 * test; `/api/metrics` owns its order in the route body instead of the
 * shared helper, which is why it is listed here as well.
 */
const GATES: Gate[] = [
  gate("GET /api/ready", "GET", "http://localhost/api/ready", readyGet, { ip: "10.60.0.1" }),
  gate("POST /api/ready", "POST", "http://localhost/api/ready", readyPost, {
    ip: "10.60.0.2",
    body: { envFile: "DATABASE_URL=postgres://user:pass@localhost:5432/noema\n" },
  }),
  // No 503 here: without a configured secret the route answers 401, because
  // the session-based workspace-admin path has to stay open.
  gate("GET /api/metrics", "GET", "http://localhost/api/metrics", metricsGet, {
    ip: "10.60.0.3",
    notConfigured: 401,
  }),
  gate("POST /api/cron/templates", "POST", "http://localhost/api/cron/templates", templatesPost, {
    ip: "10.60.0.4",
  }),
  gate("GET /api/cron/versions", "GET", "http://localhost/api/cron/versions", versionsGet, {
    ip: "10.60.0.5",
  }),
  gate("GET /api/cron/jobs", "GET", "http://localhost/api/cron/jobs", jobsGet, { ip: "10.60.0.6" }),
  gate("POST /api/cron/jobs", "POST", "http://localhost/api/cron/jobs", jobsPost, {
    ip: "10.60.0.7",
    body: { kind: "noop" },
  }),
  gate("POST /api/cron/tickets", "POST", "http://localhost/api/cron/tickets", ticketsPost, {
    ip: "10.60.0.8",
  }),
  gate("GET /api/cron/digest", "GET", "http://localhost/api/cron/digest", digestGet, {
    ip: "10.60.0.9",
  }),
  gate("POST /api/cron/digest", "POST", "http://localhost/api/cron/digest", digestPost, {
    ip: "10.60.0.10",
  }),
  gate("GET /api/cron/backups", "GET", "http://localhost/api/cron/backups", backupsGet, {
    ip: "10.60.0.11",
  }),
];

beforeEach(() => {
  limit.blocked = false;
  process.env.CRON_SECRET = SECRET;
  delete process.env.READY_SECRET;
  // A directory that does not exist: the backup sweep answers with an empty
  // pass instead of touching a real dump directory.
  process.env.BACKUP_DIR = "/tmp/opencode/b30-no-such-backup-dir";
  mailer.sendMail.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.READY_SECRET;
  delete process.env.BACKUP_DIR;
});

describe.each(GATES)("$name — the ops gate", ({ call, notConfigured }) => {
  it(
    notConfigured === 503
      ? "503 when CRON_SECRET is unset (fail closed, unchanged)"
      : "401 when CRON_SECRET is unset — no 503: the session-admin path would be locked out",
    async () => {
      delete process.env.CRON_SECRET;
      delete process.env.READY_SECRET;
      const res = await call({ "x-cron-secret": SECRET });
      if (notConfigured === 401) {
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
        return;
      }
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        error: expect.stringContaining("CRON_SECRET"),
      });
    },
  );

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

  it("401 on a wrong secret when the limit is not spent (unchanged)", async () => {
    const res = await call({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});

describe("GET /api/metrics — the exception to the 503 rule", () => {
  it("401 (not 503) without a configured secret: no 503, because the session-admin path would be locked out", async () => {
    delete process.env.CRON_SECRET;
    const res = await metricsGet(
      new Request("http://localhost/api/metrics", {
        headers: { "x-forwarded-for": "10.60.0.3" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("still throttles before it compares — a wrong secret is answered 429 once the budget is spent", async () => {
    limit.blocked = true;
    const res = await metricsGet(
      new Request("http://localhost/api/metrics", {
        headers: { "x-cron-secret": "wrong", "x-forwarded-for": "10.60.0.3" },
      }),
    );
    expect(res.status).toBe(429);
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

  /** The shared helper: the body the gates actually call. */
  const HELPER_FILE = "../../lib/ops-guard.ts";

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

  /**
   * The body of one function in a source file (brace-matched), so the scan
   * below can look at the helper's *implementation* and not only at its call
   * sites.
   */
  function functionBody(source: string, name: string): string {
    const signature = source.indexOf(`function ${name}(`);
    if (signature < 0) throw new Error(`${name} is not in the source`);
    const open = source.indexOf("{", signature);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, index + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  /**
   * The comparison scope of the helper: the body of `safeSecretEqual` plus
   * the bodies of the same-file functions it calls — a hand-rolled byte loop
   * could be delegated one level down.
   *
   * The scope is deliberately **not** the whole file: an unrelated
   * `Buffer.from(` — e.g. in `opsSecretLimitKey`, which hashes the
   * configured secret — is not a copy of the byte loop and must not turn the
   * scan red.
   */
  function comparisonScope(source: string): string {
    const scope = [functionBody(source, "safeSecretEqual")];
    for (const call of scope[0].matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const name = call[1];
      // Only the functions of *this* file — `constantTimeEqual` is imported.
      if (!source.includes(`function ${name}(`)) continue;
      scope.push(functionBody(source, name));
    }
    return scope.join("\n");
  }

  it("the helper delegates the comparison to constantTimeEqual (no own copy of the byte loop)", () => {
    const source = readFileSync(repoFile(HELPER_FILE), "utf8");
    expect(source).toContain("constantTimeEqual(");
    const body = functionBody(source, "safeSecretEqual");
    expect(body).toContain("constantTimeEqual(");
    // A hand-rolled byte loop would need buffers or char codes of its own —
    // inside the comparison, not anywhere in the helper.
    const scope = comparisonScope(source);
    expect(scope, "the helper must not copy the byte loop").not.toMatch(/Buffer\.from\(/);
    expect(scope, "the helper must not copy the byte loop").not.toMatch(/charCodeAt/);
  });

  it("the helper never compares the two secrets with ===/!==", () => {
    const source = readFileSync(repoFile(HELPER_FILE), "utf8");
    // `left === ""` (the empty check) is fine — a comparison of the two
    // secrets against each other is not.
    const equal = functionBody(source, "safeSecretEqual");
    expect(equal).not.toMatch(/\b(left|right)\s*(===|!==)\s*\b(left|right)\b/);
    // The presented secret is compared through the shared helper, not with
    // `===` against the configured one.
    const has = functionBody(source, "requestHasOpsSecret");
    expect(has).toContain("safeSecretEqual(");
    expect(has).not.toMatch(/\bprovided\s*(===|!==)\s*\bsecret\b/);
    expect(has).not.toMatch(/\bsecret\s*(===|!==)\s*\bprovided\b/);
  });
});
