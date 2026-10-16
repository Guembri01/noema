import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
// A probe must always run — never a build-time static snapshot, never cached.
export const dynamic = "force-dynamic";

/**
 * B62/s18 — GET /api/health (spec R28.24): liveness + readiness in one cheap call.
 *
 * The JSON BODY contract stays frozen at exactly the two B62 fields — `{ ok, db }`
 * — so the compose healthcheck, load-balancer probes and any existing client keep
 * parsing unchanged (no version, env names or error detail in the payload).
 *
 * The richer observability report — overall `status`, `version`, `uptimeSeconds`
 * and per-check detail — is additive and travels in response HEADERS, so the JSON
 * contract above is untouched while operators still get the detail. Move it into
 * the body only if the frozen contract is ever intentionally relaxed (that also
 * requires updating the B62 guard test, out of scope here).
 *
 * Work per probe: one `SELECT 1`, raced against a short timeout so a hung
 * database answers 503 instead of hanging the orchestrator's probe. No auth,
 * no rate-limit bucket, no `Set-Cookie` — safe to hit every few seconds.
 */

const DB_PING_TIMEOUT_MS = 2000;
/** A ping slower than this still counts as "up" but downgrades overall health. */
const DB_SLOW_MS = 500;

/**
 * App version exposed on the probe. `npm run dev/start` exports the package
 * version as `npm_package_version`; container images that run without npm set
 * `APP_VERSION` explicitly. The literal fallback keeps the header well-formed
 * when neither is present.
 */
const APP_VERSION =
  process.env.APP_VERSION ?? process.env.npm_package_version ?? "0.1.0";

/** Per-check outcome. */
type CheckStatus = "up" | "down";
/** Overall health: fine, up-but-impaired, or a required check failed. */
type HealthStatus = "ok" | "degraded" | "down";

/** Frozen body contract — the only shape the JSON payload ever emits. */
type HealthPayload = { ok: boolean; db: CheckStatus };

/** Detail for a single check, aggregated into the `x-health-checks` header. */
type CheckDetail = { status: CheckStatus; latencyMs: number | null };
type HealthReport = {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
  checks: { db: CheckDetail };
};

/** Pure body mapping — unchanged since B62 so existing consumers keep parsing. */
function composeHealth(dbUp: boolean): HealthPayload {
  return dbUp ? { ok: true, db: "up" } : { ok: false, db: "down" };
}

/**
 * Overall status from the DB check:
 *  - error / timeout      -> "down"     (HTTP 503)
 *  - reachable but slow   -> "degraded" (HTTP 200)
 *  - reachable and fast   -> "ok"       (HTTP 200)
 */
function overallStatus(db: CheckDetail): HealthStatus {
  if (db.status === "down") return "down";
  if (db.latencyMs !== null && db.latencyMs >= DB_SLOW_MS) return "degraded";
  return "ok";
}

/** Trivial DB ping; reports outcome + latency, never throws. */
async function checkDb(): Promise<CheckDetail> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch {
    // Swallow the reason on purpose: connection strings, hosts and driver
    // errors must not leak on an unauthenticated endpoint.
    return { status: "down", latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Additive observability, emitted as headers so the JSON body stays frozen. */
function reportHeaders(report: HealthReport): Record<string, string> {
  return {
    "x-health-status": report.status,
    "x-health-version": report.version,
    "x-health-uptime": String(report.uptimeSeconds),
    "x-health-checks": JSON.stringify(report.checks),
  };
}

export async function GET(): Promise<NextResponse<HealthPayload>> {
  const db = await checkDb();
  const payload = composeHealth(db.status === "up");
  const report: HealthReport = {
    status: overallStatus(db),
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    checks: { db },
  };
  return NextResponse.json(payload, {
    status: report.status === "down" ? 503 : 200,
    headers: { "cache-control": "no-store", ...reportHeaders(report) },
  });
}
