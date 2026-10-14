import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getTrash, getWorkspaceBySlug } from "@/server/queries";
import { HomeGallery } from "@/components/home-gallery";
import { formatDate } from "@/lib/slug";
import { t } from "@/lib/i18n";

export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const trash = await getTrash(workspace.id);
  const locale = user.locale ?? "en";
  const hour = new Date().getHours();
  const greeting =
    hour < 12
      ? t(locale, "goodMorning")
      : hour < 18
        ? t(locale, "goodAfternoon")
        : t(locale, "goodEvening");

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center px-8 py-14">
      <div className="mb-8 w-full max-w-2xl">
        <p className="text-3xl font-bold tracking-tight">
          {greeting}, {user.name.split(" ")[0]}
        </p>
        <p className="mt-1 text-sm text-muted">
          {workspace.icon ? `${workspace.icon} ` : ""}
          {workspace.name} · {access.role.toLowerCase()}
        </p>
      </div>

      <HomeGallery workspaceId={workspace.id} workspaceName={workspace.name} locale={locale} />

      {trash.length > 0 && (
        <section className="mt-14 w-full max-w-2xl">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            {t(locale, "recentlyDeleted")}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {trash.slice(0, 6).map((page) => (
              <li key={page.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span aria-hidden>{page.icon ?? "🗑️"}</span>
                <span className="flex-1 truncate">{page.title || t(locale, "untitled")}</span>
                <span className="text-xs text-muted">
                  {page.deletedAt ? formatDate(page.deletedAt) : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
