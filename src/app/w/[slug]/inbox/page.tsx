import Link from "next/link";
import { notFound } from "next/navigation";
import { Bell } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getNotifications, getWorkspaceBySlug } from "@/server/queries";
import { markAllNotificationsRead, markNotificationRead } from "@/server/actions/notifications";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const LABELS: Record<string, string> = {
  "comment.reply": "Someone replied to your comment",
  "page.mention": "You were mentioned on a page",
  "page.shared": "A page was shared with you",
};

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

  const notifications = await getNotifications(user.id);

  return (
    <div className="mx-auto max-w-2xl px-10 py-12">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bell className="h-5 w-5" />
          {t(locale, "inbox")}
        </h1>
        {notifications.some((n) => !n.read) && (
          <form action={markAllNotificationsRead}>
            <button type="submit" className="text-sm text-muted hover:text-fg">
              {t(locale, "markAllRead")}
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          {t(locale, "youAreAllCaughtUp")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {notifications.map((notification) => {
            const payload = (notification.payload ?? {}) as { pageId?: string };
            const href = payload.pageId
              ? `/w/${workspace.slug}/${payload.pageId}`
              : null;
            return (
              <li
                key={notification.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    notification.read ? "bg-transparent" : "bg-accent",
                  )}
                  aria-hidden
                />
                <span className={cn("flex-1", notification.read && "text-muted")}>
                  {LABELS[notification.type] ?? notification.type}
                </span>
                {href && (
                  <Link href={href} className="text-accent hover:underline">
                    {t(locale, "open")}
                  </Link>
                )}
                {!notification.read && (
                  <form action={markNotificationRead.bind(null, notification.id)}>
                    <button
                      type="submit"
                      className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      {t(locale, "markRead")}
                    </button>
                  </form>
                )}
                <span className="text-xs text-muted">
                  {new Date(notification.createdAt).toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
