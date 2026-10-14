import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
// A probe must always run — never a build-time static snapshot, never cached.
export const dynamic = "force-dynamic";

/**
 * B62 — GET /api/health (spec R28.24): liveness + readiness in one cheap call.
 *
 * The response is deliberately two fixed fields — `{ ok, db }` — and nothing
 * else: no version, no env names, no error detail (the compose healthcheck
 * only needs the status code; anything beyond that would be information
 * disclosure on an unauthenticated endpoint).
 *
 * Work per probe: one `SELECT 1`, raced against a short timeout so a hung
 * database answers 503 instead of hanging the orchestrator's probe. No auth,
 * no rate-limit bucket, no `Set-Cookie` — safe to hit every few seconds.
 */

const DB_PING_TIMEOUT_MS = 2000;

type HealthPayload = { ok: boolean; db: "up" | "down" };

/** Pure status mapping — the only shape this route ever emits. */
function composeHealth(dbUp: boolean): HealthPayload {
  return dbUp ? { ok: true, db: "up" } : { ok: false, db: "down" };
}

/** Trivial DB ping; resolves false on error OR timeout, never throws. */
async function pingDb(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    // Swallow the reason on purpose: connection strings, hosts and driver
    // errors must not leak on an unauthenticated endpoint.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<NextResponse<HealthPayload>> {
  const payload = composeHealth(await pingDb());
  return NextResponse.json(payload, {
    status: payload.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
