import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  checkReadiness,
  deploymentManifest,
  healthPayload,
  validateEnvFile,
  type EnvFileReport,
  type HealthPayload,
  type ReadinessReport,
} from "@/lib/self-hosting";
import { clientKey, TokenBucketLimiter } from "@/lib/rate-limit";
import { summarizeUserAgent } from "@/lib/user-agent";

export const runtime = "nodejs";
// A probe must always run — never a build-time snapshot, never cached.
export const dynamic = "force-dynamic";

/**
 * Self-hosting readiness endpoint (§17 Self-hosting: "Local dev works;
 * packaging pending").
 *
 * This is the production caller for the pure `@/lib/self-hosting` engine:
 *
 *  - `checkReadiness`    grades the process env + the live Postgres probe;
 *  - `healthPayload`     aggregates the dependency probes into a status;
 *  - `deploymentManifest` emits the machine-readable deployment summary a
 *    compose/build entrypoint can consume;
 *  - `validateEnvFile`   (POST) grades an operator-supplied `.env` file text.
 *
 * Gated like the other ops routes (see `api/cron/*`): the shared ops secret is
 * required and the endpoint fails CLOSED when it is unset, so a deployment that
 * forgot the secret gets a 503 rather than an open inventory of env names. A
 * burst-smoothing token bucket (backed by the pure `token-bucket.ts`) is the
 * only rate limit; the probe identity is reported via `user-agent.ts` so an
 * operator can see which monitor is asking.
 *
 * GET  → readiness (env + Postgres) + health + manifest.
 * POST → `{ envFile: string }` graded by `validateEnvFile`.
 */

const DB_PING_TIMEOUT_MS = 2000;

/** Burst of 30 probes, sustained at 1/s, capped at 10k distinct sources. */
const READY_LIMITER = new TokenBucketLimiter({
  capacity: 30,
  refillPerSecond: 1,
  maxKeys: 10_000,
});

/** The shared ops secret; either name is accepted. */
function opsSecret(): string | undefined {
  const secret = process.env.CRON_SECRET ?? process.env.READY_SECRET;
  return secret && secret.trim() !== "" ? secret : undefined;
}

/** Constant-time-ish header match; both sides are ops secrets, never user data. */
function isAuthorized(request: Request, secret: string): boolean {
  return (
    request.headers.get("x-cron-secret") === secret ||
    request.headers.get("x-ready-secret") === secret
  );
}

/** Trivial DB ping; reports up/down, never throws, never leaks the reason. */
async function probeDb(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Gate + rate limit; a NextResponse to return early, or `null` to continue. */
function guard(request: Request): NextResponse | null {
  const secret = opsSecret();
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "Ops secret is not configured. Set CRON_SECRET (or READY_SECRET) in the environment and send it as the x-cron-secret header.",
      },
      { status: 503 },
    );
  }
  if (!isAuthorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = READY_LIMITER.hit(clientKey(request, "ready"), Date.now());
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))),
        },
      },
    );
  }
  return null;
}

/** How many findings the env-file report carries, by kind. */
function issueCounts(report: EnvFileReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of report.issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return counts;
}

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = guard(request);
  if (blocked) return blocked;

  const dbUp = await probeDb();
  const readiness: ReadinessReport = checkReadiness({
    env: process.env,
    services: { postgres: dbUp },
  });
  const health: HealthPayload = healthPayload({ db: dbUp });
  const manifest = deploymentManifest({ env: process.env });
  const probe = summarizeUserAgent(request.headers.get("user-agent") ?? "");

  return NextResponse.json(
    {
      ok: readiness.ok,
      score: readiness.score,
      missing: readiness.missing,
      warnings: readiness.warnings,
      health,
      manifest,
      probe,
    },
    {
      status: readiness.ok ? 200 : 503,
      headers: {
        "cache-control": "no-store",
        "x-ready-status": readiness.ok ? "ready" : "not-ready",
        "x-ready-probe": probe,
      },
    },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const blocked = guard(request);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const envFile =
    typeof body === "object" && body !== null
      ? (body as { envFile?: unknown }).envFile
      : undefined;
  if (typeof envFile !== "string") {
    return NextResponse.json(
      { error: 'Expected a JSON body of the form { "envFile": "DATABASE_URL=..." }.' },
      { status: 400 },
    );
  }

  const report = validateEnvFile(envFile);
  return NextResponse.json(
    {
      ok: report.ok,
      unknown: report.unknown,
      missing: report.missing,
      placeholders: report.placeholders,
      issues: report.issues,
      counts: issueCounts(report),
    },
    { status: report.ok ? 200 : 422, headers: { "cache-control": "no-store" } },
  );
}
