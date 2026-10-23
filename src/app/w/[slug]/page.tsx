import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { getTrash, getWorkspaceBySlug } from "@/server/queries";
import { HomeGallery } from "@/components/home-gallery";
import { formatDate } from "@/lib/slug";
import { t } from "@/lib/i18n";

/**
 * The workspace home: greeting, the template/quick-start gallery and, when the
 * workspace has archived anything, the recently-deleted list. It uses the shared
 * full-bleed page container (`max-w-[1600px]`, `px-8 py-12`) and the
 * design-system section rhythm (`gap-6`) so it reads as one page with the rest
 * of the workspace (docs/DESIGN_SYSTEM.md §4), with every heading carrying a
 * muted description.
 */
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
  // The "recently deleted" list names pages, so a guest only sees the trashed
  // pages in their scope — the same scope the trash page uses.
  const visiblePageIds = await pageScopeFor(user.id, workspace.id, access.role);

  const trash = await getTrash(workspace.id, visiblePageIds);
  const locale = user.locale ?? "en";
  const hour = new Date().getHours();
  const greeting =
    hour < 12
      ? t(locale, "goodMorning")
      : hour < 18
        ? t(locale, "goodAfternoon")
        : t(locale, "goodEvening");

  return (
    <div className="mx-auto w-full max-w-[1600px] px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-title font-semibold tracking-title text-fg">
            {greeting}, {user.name.split(" ")[0]}
          </h1>
          <p className="text-sm text-muted">
            {workspace.icon ? `${workspace.icon} ` : ""}
            {workspace.name} · {access.role.toLowerCase()}
          </p>
        </header>

        <HomeGallery
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          locale={locale}
        />

        {trash.length > 0 && (
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
                {t(locale, "recentlyDeleted")}
              </h2>
              <p className="text-sm text-muted">{t(locale, "trashIntro")}</p>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {trash.slice(0, 6).map((page) => (
                <li
                  key={page.id}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <span aria-hidden>{page.icon ?? "🗑️"}</span>
                  <span className="flex-1 truncate">
                    {page.title || t(locale, "untitled")}
                  </span>
                  <span className="text-xs text-muted">
                    {page.deletedAt ? formatDate(page.deletedAt) : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
