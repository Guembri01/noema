import Link from "next/link";
import { notFound } from "next/navigation";
import { Bell, Inbox } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getNotifications, getWorkspaceBySlug } from "@/server/queries";
import { markAllNotificationsRead, markNotificationRead } from "@/server/actions/notifications";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { EmptyState } from "@/components/ui/empty-state";
import {
  buildInbox,
  groupByPage,
  isInDigest,
  markAllRead,
  markRead,
  unreadCount,
} from "@/lib/notification-inbox";
import type { InboxBucket, InboxNotification } from "@/lib/notification-inbox";
import {
  isWithinQuietHours,
  nextDeliveryTime,
  validateSchedule,
} from "@/lib/notification-schedule";
import type { QuietSchedule } from "@/lib/notification-schedule";

const LABELS: Record<string, string> = {
  "comment.reply": "Someone replied to your comment",
  "page.mention": "You were mentioned on a page",
  "page.shared": "A page was shared with you",
  "ticket.assigned": "You were assigned a ticket",
  "page.updated": "A page you follow was updated",
};

/**
 * One inbox row carries more than its type: an assignment knows *which* ticket.
 * These are the extra payload fields this page reads, kept beside the pure
 * `InboxNotification` so the row can be specific without the pure engine having
 * to learn about tickets (`buildInbox` and friends are generic over this).
 */
type InboxItem = InboxNotification & {
  readonly ticketId?: string;
  readonly ticketTitle?: string;
  readonly ticketCount?: number;
};

/**
 * The sentence for one row. Assignment rows are the one type whose payload makes
 * the row more useful than its category ("You were assigned a ticket" tells a
 * person nothing they did not already assume from the unread dot), so they name
 * the ticket - or count the batch - and fall back to the plain label.
 */
function labelFor(notification: InboxItem): string {
  if (notification.type === "ticket.assigned") {
    const count = notification.ticketCount ?? 1;
    if (count > 1) return `You were assigned ${count} tickets`;
    const title = notification.ticketTitle?.trim();
    return title ? `You were assigned “${title}”` : LABELS["ticket.assigned"];
  }
  return LABELS[notification.type] ?? notification.type;
}

/**
 * Day-section headings. The i18n catalogue has no keys for these yet (only
 * `todayWord`), so, like `LABELS` above, they fall back to English; adding the
 * keys to `src/lib/i18n.ts` is a follow-up.
 */
const BUCKET_LABELS: Record<InboxBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

type RawNotification = Awaited<ReturnType<typeof getNotifications>>[number];

/**
 * Fold a Prisma notification row into the pure engine's `InboxNotification`
 * shape. `payload` is untyped JSON, so it is read defensively here; the shared
 * server query is left untouched.
 */
function toInboxNotification(row: RawNotification): InboxItem {
  const payload =
    typeof row.payload === "object" &&
    row.payload !== null &&
    !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const pageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
  const actorId =
    typeof payload.actorId === "string" ? payload.actorId : undefined;
  const ticketId =
    typeof payload.ticketId === "string" ? payload.ticketId : undefined;
  const ticketTitle =
    typeof payload.title === "string" ? payload.title : undefined;
  const ticketCount =
    typeof payload.count === "number" && Number.isFinite(payload.count)
      ? payload.count
      : undefined;
  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    read: row.read,
    pageId,
    actorId,
    ticketId,
    ticketTitle,
    ticketCount,
  };
}

/**
 * Read the user's quiet-hours schedule out of the persisted `notificationPrefs`
 * JSON (`User.notificationPrefs`). The field is optional and, like every input
 * to `notification-schedule`, is validated rather than trusted: an absent,
 * malformed or day-less value yields `null`, so the inbox behaves exactly as it
 * did before the prefs existed (no banner, default delivery).
 */
function readQuietSchedule(prefs: unknown): QuietSchedule | null {
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
    return null;
  }
  const candidate = (prefs as Record<string, unknown>).quietHours;
  const result = validateSchedule(candidate);
  return result.ok && result.value.days.length > 0 ? result.value : null;
}

export default async function InboxPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const rows = await getNotifications(user.id);
  const notifications = rows.map(toInboxNotification);

  // The persisted preference blob (`User.notificationPrefs`, feat/r13) drives
  // both the delivery suppression and the quiet-hours banner below. When the
  // column is unset we pass `null`, and the engines fall back to their defaults.
  const prefsRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  const prefs = prefsRow?.notificationPrefs ?? null;

  const now = new Date();
  // The engine owns the view model: it drops what the delivery rules would
  // suppress, buckets the rest by UTC day (today / yesterday / earlier) and
  // sorts each bucket recency-first. The user's prefs are handed through so a
  // MENTIONS-only or OFF preference is honoured here too.
  const buckets = buildInbox(notifications, prefs, now);
  const visible = buckets.flatMap((bucket) => bucket.items);
  const unread = unreadCount(visible);
  // A scope changes a row iff the engine returns a new object for it. Ask the
  // engine whether "Mark all read" would do anything before offering it.
  const canMarkAllRead = markAllRead(visible).some(
    (notification, index) => notification !== visible[index],
  );

  // Quiet hours are part of the same prefs blob. When a valid schedule is
  // present and `now` sits inside it, the banner tells the user when delivery
  // resumes (`nextDeliveryTime` is the first instant outside the window).
  const quiet = readQuietSchedule(prefs);
  const isQuiet = quiet !== null && isWithinQuietHours(now, quiet);
  const resumeAt = isQuiet ? nextDeliveryTime(now, quiet) : null;

  const renderNotification = (notification: InboxItem) => {
    // Pages link to the page; an assignment links to the ticket it names, which
    // the tickets page opens as a drawer from `?ticket=` (there is no ticket
    // route of its own - the tracker is one page with an open row).
    const href = notification.pageId
      ? `/w/${workspace.slug}/${notification.pageId}`
      : notification.ticketId
        ? `/w/${workspace.slug}/tickets?ticket=${notification.ticketId}`
        : null;
    // Same contract as the bulk control: the engine decides what is markable.
    const markable =
      markRead([notification], [notification.id])[0] !== notification;
    return (
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            notification.read ? "bg-transparent" : "bg-action",
          )}
          aria-hidden
        />
        <span className={cn("flex-1", notification.read && "text-muted")}>
          {labelFor(notification)}
        </span>
        {isInDigest(notification, prefs) && (
          <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-3xs uppercase tracking-wide text-muted">
            digest
          </span>
        )}
        {href && (
          <Link href={href} className="focus-ring rounded-sm text-accent hover:underline">
            {t(locale, "open")}
          </Link>
        )}
        {markable && (
          <form action={markNotificationRead.bind(null, notification.id)}>
            <button
              type="submit"
              aria-label={t(locale, "markRead")}
              className="focus-ring u-interactive rounded-control px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              {t(locale, "markRead")}
            </button>
          </form>
        )}
        <span className="text-xs text-muted">
          {new Date(notification.createdAt).toLocaleString()}
        </span>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      {resumeAt && (
        <div className="mb-5 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          {`Quiet hours: notifications are paused (now ${now.toLocaleString()}) and resume at ${resumeAt.toLocaleString()}.`}
        </div>
      )}
      <header className="mb-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="flex items-center gap-2 text-title font-semibold tracking-title">
            <Bell className="h-5 w-5" />
            {t(locale, "inbox")}
            {unread > 0 && (
              <span className="rounded-full bg-action px-2 py-0.5 text-xs font-medium text-action-fg">
                {unread}
              </span>
            )}
          </h1>
          {canMarkAllRead && (
            <form action={markAllNotificationsRead}>
              <button
                type="submit"
                aria-label={t(locale, "markAllRead")}
                className="focus-ring u-interactive text-sm text-muted hover:text-fg"
              >
                {t(locale, "markAllRead")}
              </button>
            </form>
          )}
        </div>
        <p className="mt-2 text-sm text-muted">
          Mentions, replies and page activity, grouped by day.
        </p>
      </header>

      {buckets.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-5 w-5" />}
          title={t(locale, "youAreAllCaughtUp")}
          description="New mentions and replies land here as they happen."
        />
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => (
            <section key={bucket.bucket}>
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {BUCKET_LABELS[bucket.bucket]}
                {bucket.unread > 0 && (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-3xs text-muted">
                    {bucket.unread}
                  </span>
                )}
              </h2>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {groupByPage(bucket.items).map((group) =>
                  group.count === 1 ? (
                    <li key={group.key}>{renderNotification(group.latest)}</li>
                  ) : (
                    <li key={group.key}>
                      {/* Several events on one page collapse into one entry. */}
                      <details>
                        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm">
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              group.unread > 0 ? "bg-action" : "bg-transparent",
                            )}
                            aria-hidden
                          />
                          <span
                            className={cn(
                              "flex-1",
                              group.unread === 0 && "text-muted",
                            )}
                          >
                            {LABELS[group.latest.type] ?? group.latest.type}
                          </span>
                          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                            {group.count}
                          </span>
                          <span className="text-xs text-muted">
                            {new Date(group.latest.createdAt).toLocaleString()}
                          </span>
                        </summary>
                        <ul className="divide-y divide-border border-t border-border bg-surface-2">
                          {group.items.map((notification) => (
                            <li key={notification.id}>
                              {renderNotification(notification)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
