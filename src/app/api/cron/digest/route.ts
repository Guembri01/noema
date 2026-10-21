import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";
import {
  MAIL_NOT_CONFIGURED,
  emailTemplate,
  escapeHtml,
  sendMail,
} from "@/lib/mailer";
import { buildDigest, plainTextDigest } from "@/lib/email-digest";
import type { DigestNotification } from "@/lib/email-digest";
import {
  NOTIFICATION_TYPES,
  nextDigestAt,
  parsePrefs,
  shouldDeliver,
} from "@/lib/notification-prefs-engine";
import type {
  DigestCadence as EngineDigestCadence,
  NotificationType,
} from "@/lib/notification-prefs-engine";
import type { DigestCadence } from "@/lib/notification-prefs";

/**
 * Email-digest cron (docs/specs/notifications.md R82.27/R82.28): point a
 * scheduler (cron, Vercel Cron, GitHub Actions, Task Scheduler) at this endpoint
 * to fan each opted-in user's pending notifications into a single digest email.
 * It is the production wire for `src/lib/email-digest.ts`, whose `buildDigest` /
 * `plainTextDigest` render the message, and for the scheduling half of
 * `src/lib/notification-prefs-engine.ts` (`parsePrefs`, `nextDigestAt`,
 * `shouldDeliver`).
 *
 * Guard: the same fail-closed `CRON_SECRET` + `x-cron-secret` handshake and
 * `rateLimit(…, "cron", 12, 60_000)` the other cron routes use
 * (`api/cron/templates/route.ts`, `api/cron/versions/route.ts`); 503 when the
 * secret is unset, 429 over the limit (the limit runs *before* the comparison),
 * 401 on a mismatch.
 *
 * "One email per digest window": each user's digest window is derived from
 * `nextDigestAt` (08:00 local, daily or on the coming Monday), and a "sent"
 * `EmailDelivery` row for the same recipient inside that window suppresses a
 * second send, so a frequent scheduler cannot flood a mailbox even though it
 * runs many times per window.
 */

export const runtime = "nodejs";

/** `kind` recorded on the digest delivery so the window dedupe can find it. */
const DIGEST_KIND = "notification-digest";
const MS_PER_DAY = 86_400_000;

/** A pending notification row, reduced to the fields the digest needs. */
type PendingRow = {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
};

/** One due digest window: when the boundary that opened it fell. */
type DigestWindow = {
  readonly scheduledAt: Date;
};

/** Non-null, non-array object — the only `payload` shape trusted as a record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Window length for a cadence, or `null` when cadence `off` never sends. */
function windowMs(cadence: EngineDigestCadence): number | null {
  if (cadence === "daily") return MS_PER_DAY;
  if (cadence === "weekly") return 7 * MS_PER_DAY;
  return null;
}

/** Engine cadence (lowercase) → the formatting module's subject vocabulary. */
function formatCadence(cadence: EngineDigestCadence): DigestCadence | undefined {
  if (cadence === "daily") return "DAILY";
  if (cadence === "weekly") return "WEEKLY";
  return undefined;
}

/**
 * The digest window that is due at `now`, if any.
 *
 * `nextDigestAt` is always strictly after its input, so its inverse is read by
 * measuring from `now - lookback`: the result is the first boundary after that
 * instant, i.e. the boundary inside `(now - lookback, now]` when one exists. The
 * lookback is half a period, which makes the boundary due only inside a catch-up
 * window after it (daily 08:00–20:00, weekly Monday–Thursday); a boundary older
 * than that is left for the next period's digest instead of arriving arbitrarily
 * late, and `off` (or a schedule still ahead of `now`) answers `null`.
 */
function dueWindow(
  cadence: EngineDigestCadence,
  prefs: unknown,
  now: Date,
): DigestWindow | null {
  const periodMs = windowMs(cadence);
  if (periodMs === null) return null;
  const scheduledAt = nextDigestAt(
    prefs,
    new Date(now.getTime() - periodMs / 2),
  );
  if (!scheduledAt || scheduledAt.getTime() > now.getTime()) return null;
  return { scheduledAt };
}

/** Fold a stored row into the wire shape `buildDigest` reads (payload is JSON). */
function toDigestNotification(row: PendingRow): DigestNotification {
  const payload = isPlainRecord(row.payload) ? row.payload : {};
  const pageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
  const actorId =
    typeof payload.actorId === "string" ? payload.actorId : undefined;
  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    pageId,
    actorId,
  };
}

/** The workspace a row belongs to (snapshotted into the payload by the writer). */
function workspaceIdOf(row: PendingRow): string | null {
  const payload = isPlainRecord(row.payload) ? row.payload : {};
  return typeof payload.workspaceId === "string" ? payload.workspaceId : null;
}

/** Is `type` one of the known notification event ids? */
function isKnownType(type: string): type is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/** Absolute app origin for the digest CTA, or `null` when it is not configured. */
function appOrigin(): string | null {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** SMTP-configured mail config is resolved per workspace by `sendMail`; the row
 * snapshots a `workspaceId`, but older rows may not, so fall back to the user's
 * first membership. */
async function firstWorkspaceId(userId: string): Promise<string | null> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    select: { workspaceId: true },
  });
  return membership?.workspaceId ?? null;
}

async function runCron(request: Request) {
  // Fail closed: a digest fans sensitive notification text out over SMTP, so an
  // unconfigured secret is a deployment error rather than an open endpoint.
  // The shared gate throttles BEFORE the comparison and compares the secret
  // in constant time.
  const gate = guardOpsSecret(request, {
    secret: process.env.CRON_SECRET,
    limit: () => rateLimit(request, "cron", 12, 60_000),
  });
  if (!gate.ok) return gate.response;

  const now = new Date();

  // Pending = unread. The digest is a secondary channel; the in-app rows stay.
  const pending: PendingRow[] = await prisma.notification.findMany({
    where: { read: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      type: true,
      payload: true,
      createdAt: true,
    },
  });

  const byUser = new Map<string, PendingRow[]>();
  for (const row of pending) {
    const rows = byUser.get(row.userId);
    if (rows) rows.push(row);
    else byUser.set(row.userId, [row]);
  }

  if (byUser.size === 0) {
    return NextResponse.json({ users: 0, sent: 0, skipped: 0, failed: [] });
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...byUser.keys()] } },
    select: { id: true, email: true, notificationPrefs: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  let sent = 0;
  let skipped = 0;
  const failed: { userId: string; error: string }[] = [];

  for (const [userId, rows] of byUser) {
    // D3-style isolation: one user's failure is reported, not thrown.
    try {
      const user = userById.get(userId);
      if (!user) {
        skipped += 1;
        continue;
      }
      const prefs = parsePrefs(user.notificationPrefs ?? {});
      const window = dueWindow(prefs.digest, prefs, now);
      if (!window) {
        skipped += 1;
        continue;
      }

      // One email per window: a prior successful send inside this window wins.
      const alreadySent = await prisma.emailDelivery.findFirst({
        where: {
          to: user.email,
          kind: DIGEST_KIND,
          status: "sent",
          createdAt: { gte: window.scheduledAt },
        },
        select: { id: true },
      });
      if (alreadySent) {
        skipped += 1;
        continue;
      }

      // Only events the user's email channel accepts enter the batch; the
      // engine owns that decision (per-type email switch + known type).
      const accepted = rows.filter(
        (row) =>
          isKnownType(row.type) &&
          shouldDeliver(prefs, {
            type: row.type,
            at: row.createdAt,
            channel: "email",
          }),
      );
      const digest = buildDigest(accepted.map(toDigestNotification), {
        now,
        cadence: formatCadence(prefs.digest),
      });
      if (digest.count === 0) {
        skipped += 1;
        continue;
      }

      const workspaceId =
        rows.map(workspaceIdOf).find((id): id is string => id !== null) ??
        (await firstWorkspaceId(userId));
      if (!workspaceId) {
        skipped += 1;
        continue;
      }

      const origin = appOrigin();
      const template = emailTemplate({
        heading: digest.subject,
        body: escapeHtml(digest.preview),
        ...(origin
          ? { ctaLabel: "Open Noema", ctaUrl: origin }
          : {}),
        footer: "You receive this because email digests are on for your account.",
      });
      const result = await sendMail(workspaceId, {
        to: user.email,
        subject: digest.subject,
        kind: DIGEST_KIND,
        text: plainTextDigest(digest),
        html: template.html,
      });
      if ("error" in result) {
        // Unconfigured SMTP is expected (`MAIL_NOT_CONFIGURED`) and retried next
        // tick; it must not abort the other users' digests.
        failed.push({
          userId,
          error: result.error === MAIL_NOT_CONFIGURED ? "smtp-unconfigured" : result.error,
        });
        continue;
      }
      sent += 1;
    } catch (error) {
      failed.push({
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.info(
    `[cron/digest] users ${byUser.size}: sent ${sent}, skipped ${skipped}, failed ${failed.length}`,
  );
  return NextResponse.json({ users: byUser.size, sent, skipped, failed });
}

/** Schedulers may POST (templates route) or GET (versions route); same handler. */
export async function POST(request: Request) {
  return runCron(request);
}

export async function GET(request: Request) {
  return runCron(request);
}
