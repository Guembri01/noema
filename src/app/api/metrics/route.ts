import { NextResponse } from "next/server";
import { WorkspaceRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";
import { safeSecretEqual } from "@/lib/ops-guard";
import type { LogRecord, MetricsSnapshot as ObservabilitySnapshot } from "@/lib/observability";
import {
  effectiveFlags,
  log,
  newTraceId,
  percentileReport,
  prometheusText,
  recentLogs,
  recordCounter,
  recordHistogram,
  snapshot,
  startSpan,
  withTrace,
  type LatencyPercentiles,
} from "@/lib/telemetry";
import type { FlagResolution } from "@/lib/feature-flag-store";

export const runtime = "nodejs";
// A scrape must always reflect the live process, never a build-time snapshot.
export const dynamic = "force-dynamic";

/** How many recent structured log records the payload carries. */
const RECENT_LOG_LIMIT = 20;

/**
 * GET /api/metrics — the read side of the observability trio.
 *
 * Gated fail-closed by either:
 * - a valid `x-cron-secret` header matching `CRON_SECRET` (compared in
 *   constant time), or
 * - an authenticated workspace OWNER/ADMIN (a platform-scoped "admin": any
 *   workspace they own or administer).
 *
 * The rate limit runs before the secret comparison, so a wrong secret is
 * throttled instead of being an unbounded guessing oracle.
 *
 * The payload is machine-readable and additive: the canonical `observability`
 * snapshot (`snapshot()`), per-series `percentiles()` over recorded
 * observations, the `metrics.ts` Prometheus exposition, the effective feature
 * flags, and a bounded tail of structured logs. Nothing here mutates state
 * except its own process-level counters.
 */
type MetricsPayload = {
  status: "ok";
  via: "cron" | "admin";
  generatedAt: number;
  traceId: string;
  durationMs: number;
  snapshot: ObservabilitySnapshot;
  percentiles: readonly LatencyPercentiles[];
  prometheus: string;
  flags: readonly FlagResolution[];
  recentLogs: readonly LogRecord[];
};

/**
 * Whether the caller is a workspace OWNER/ADMIN. Metrics are process-wide, so
 * "admin" is platform-scoped: a member who can administer *any* workspace
 * qualifies, as does a workspace they own.
 */
async function isWorkspaceAdmin(userId: string): Promise<boolean> {
  const membership = await prisma.workspaceMember.findFirst({
    where: {
      userId,
      role: { in: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN] },
    },
    select: { id: true },
  });
  if (membership !== null) return true;

  const owned = await prisma.workspace.findFirst({
    where: { ownerId: userId },
    select: { id: true },
  });
  return owned !== null;
}

/**
 * The caller's authorization path: how they got in, and — for the admin path
 * — the user id the per-user rate-limit budget is keyed on. The cron path
 * has no user id: it is a shared secret, not an identity.
 */
type Authorized = { via: "cron" | "admin"; userId: string | null };

/**
 * Resolve the caller's authorization path, or `null` when denied.
 *
 * The **secret comparison** belongs after the rate limit (the limit has to
 * run first, so a wrong secret is throttled instead of being an unbounded
 * guessing oracle — see the GET below), the **identity** does not: the
 * per-user budget is keyed on it, so it is resolved before the limit and
 * handed in here.
 */
async function authorize(
  request: Request,
  user: Awaited<ReturnType<typeof getCurrentUser>>,
): Promise<Authorized | null> {
  const secret = process.env.CRON_SECRET;
  // The rate limit already runs before this check (see GET). The comparison is
  // constant time: a `===` on the shared secret would leak where a guess
  // differs, so the shared helper owns it.
  if (
    typeof secret === "string" &&
    secret !== "" &&
    safeSecretEqual(request.headers.get("x-cron-secret"), secret)
  ) {
    return { via: "cron", userId: null };
  }
  if (user && (await isWorkspaceAdmin(user.id))) {
    return { via: "admin", userId: user.id };
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  // The **identity** is resolved before the limit, so the per-user budget (the
  // one a caller cannot dodge by rotating their client IP) can be applied. The
  // **secret comparison** is not part of that: it runs after the limit, so a
  // wrong secret is throttled instead of being an unbounded guessing oracle.
  const user = await getCurrentUser();
  const limited = rateLimit(request, "metrics", 120, 60_000, {
    userId: user?.id ?? null,
  });
  if (limited) return limited;

  const auth = await authorize(request, user);

  if (auth === null) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const via = auth.via;

  const traceId = newTraceId();
  const span = startSpan("metrics.collect", { traceId });
  const collected = withTrace({ traceId, spanId: span.spanId }, () => ({
    snapshot: snapshot(),
    percentiles: percentileReport(),
    prometheus: prometheusText(),
    flags: effectiveFlags(),
  }));
  const finished = span.end({
    counters: collected.snapshot.counters.length,
    histograms: collected.snapshot.histograms.length,
  });

  recordHistogram("metrics_collect_duration_ms", finished.duration);
  recordCounter("metrics_scrapes_total", { labels: { via } });
  log("info", "metrics.scraped", {
    traceId,
    via,
    counters: collected.snapshot.counters.length,
    histograms: collected.snapshot.histograms.length,
  });

  const payload: MetricsPayload = {
    status: "ok",
    via,
    generatedAt: Date.now(),
    traceId,
    durationMs: finished.duration,
    snapshot: collected.snapshot,
    percentiles: collected.percentiles,
    prometheus: collected.prometheus,
    flags: collected.flags,
    recentLogs: recentLogs(RECENT_LOG_LIMIT),
  };

  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
