import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { getNotificationPrefs } from "@/server/actions/notifications";
import { NotificationPreferencesForm } from "@/components/notification-preferences-form";
import { t } from "@/lib/i18n";

export const metadata = { title: "Notifications" };

/**
 * Notification preferences (settings → Notifications).
 *
 * Preferences are per-user, so the only gate is membership of the workspace
 * this settings shell lives under. The server component reads the caller's
 * normalized prefs through `getNotificationPrefs` (the orphan action) and hands
 * them to the client form, which writes them back through
 * `updateNotificationPrefs`.
 */
export default async function NotificationSettingsPage({
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

  const prefs = await getNotificationPrefs();

  return (
    <div className="mx-auto max-w-2xl px-10 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">
        {t(locale, "notifications")}
      </h1>
      <p className="mb-6 text-sm text-muted">
        Choose which events reach you and how they are batched. These preferences
        apply to your account.
      </p>

      <NotificationPreferencesForm initialPrefs={prefs} locale={locale} />
    </div>
  );
}
