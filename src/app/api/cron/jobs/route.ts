import { NextResponse } from "next/server";
import {
  JobQueue,
  type Job,
  type JobHandler,
  type JobPayload,
} from "@/lib/job-queue";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/**
 * Background-job cron (docs/FEATURE_MATRIX.md §17 "Background jobs": an async
 * task runner/queue for imports and AI work). Point a scheduler (cron, Vercel
 * Cron, GitHub Actions, Task Scheduler) at this endpoint; protect it by setting
 * CRON_SECRET and sending `x-cron-secret: <value>` — the same fail-closed guard
 * as `api/cron/versions` / `api/cron/templates`.
 *
 * `JobQueue` (`src/lib/job-queue.ts`) is the deterministic state machine this
 * route drives; the store sitting under it is the module's in-memory adapter.
 * There is no `Job`/`JobRun` Prisma model yet, so this is deliberately a
 * **documented store adapter**: a durable deployment swaps in a Prisma-backed
 * queue that implements the same enqueue/claim/complete/fail seam (the model +
 * adapter are the reported schema follow-up, not part of this change).
 *
 * The route exposes the whole lifecycle:
 *
 *   POST  enqueue a job (`{ kind, payload?, maxAttempts?, delayMs? }`) → 202
 *   GET   claim up to `limit` due jobs, run each handler, then complete the
 *         ones that resolve and fail the ones that throw — so a thrown handler
 *         feeds the queue's normal exponential backoff, and a job whose
 *         `maxAttempts` are spent is dead-lettered. The tally is returned with
 *         the current queue stats.
 *
 * Handlers are keyed by `kind`; an unregistered kind fails by design so a typo
 * cannot silently "succeed" and drop work. Domain handlers (imports, AI work)
 * register in {@link handlers} as they are built.
 */

/** The single process-wide queue. Durable multi-instance use needs the adapter swap above. */
const queue = new JobQueue({ now: () => Date.now(), idPrefix: "job", claimLimit: 25 });

/** Registered `kind` → work. Add real import/AI handlers here. */
const handlers = new Map<string, JobHandler>();
handlers.set("noop", () => undefined);
handlers.set("echo", (job) => {
  console.info(`[cron/jobs] echo ${job.id}`);
});

/** The handler for `kind`, or a failing runner so backoff/dead-letter applies. */
function handlerFor(kind: string): JobHandler {
  return (
    handlers.get(kind) ??
    (() => {
      throw new Error(`No handler registered for job kind "${kind}"`);
    })
  );
}

/** Accept only a JSON object payload; anything else is ignored. */
function asPayload(value: unknown): JobPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JobPayload;
}

/**
 * Drain the queue: claim the due jobs at `now`, run their handlers and settle
 * each one through `drainOnce` (complete on resolve, fail on throw). The
 * optional `?limit=` caps this tick.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "CRON_SECRET is not configured. Set CRON_SECRET in the environment and send it as the x-cron-secret header.",
      },
      { status: 503 },
    );
  }
  if (request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = rateLimit(request, "cron", 12, 60_000);
  if (limited) return limited;

  const rawLimit = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;

  const result = await queue.drainOnce(
    async (job) => {
      await handlerFor(job.kind)(job);
    },
    { now: Date.now(), limit },
  );

  if (result.claimed > 0) {
    console.info(
      `[cron/jobs] claimed ${result.claimed}: completed ${result.completed}, retried ${result.retried}, dead ${result.dead}`,
    );
  }

  return NextResponse.json({ ...result, stats: queue.stats() });
}

/** Enqueue a job for a later drain. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "CRON_SECRET is not configured. Set CRON_SECRET in the environment and send it as the x-cron-secret header.",
      },
      { status: 503 },
    );
  }
  if (request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = rateLimit(request, "cron", 12, 60_000);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const record = body as Record<string, unknown>;

  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (kind === "") {
    return NextResponse.json({ error: '"kind" is required.' }, { status: 400 });
  }

  const maxAttempts = typeof record.maxAttempts === "number" ? record.maxAttempts : undefined;
  const delayMs =
    typeof record.delayMs === "number" && Number.isFinite(record.delayMs) && record.delayMs > 0
      ? record.delayMs
      : undefined;

  let job: Job;
  try {
    job = queue.enqueue({
      kind,
      payload: asPayload(record.payload),
      maxAttempts,
      runAt: delayMs === undefined ? Date.now() : Date.now() + delayMs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  return NextResponse.json({ job, stats: queue.stats() }, { status: 202 });
}
