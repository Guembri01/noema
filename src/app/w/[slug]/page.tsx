import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { getTrash, getWorkspaceBySlug } from "@/server/queries";
import { HomeGallery } from "@/components/home-gallery";
import { formatDate } from "@/lib/slug";
import { t } from "@/lib/i18n";
import { buildOnboardingChecklist } from "@/lib/onboarding";
import { dismissOnboardingAction } from "@/server/actions/onboarding";

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

  const [trash, onboardingAccount, pages, databases, members, assets] = await Promise.all([
    getTrash(workspace.id, visiblePageIds),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { onboardingDismissedAt: true },
    }),
    prisma.page.count({ where: { workspaceId: workspace.id, deletedAt: null } }),
    prisma.page.count({
      where: { workspaceId: workspace.id, deletedAt: null, type: "DATABASE" },
    }),
    prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    prisma.asset.count({ where: { page: { workspaceId: workspace.id } } }),
  ]);
  const checklist = buildOnboardingChecklist(workspace.slug, {
    pages,
    databases,
    members,
    assets,
  });
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

        {!onboardingAccount?.onboardingDismissedAt && !checklist.complete && (
          <section className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Get started with Noema</h2>
                <p className="mt-1 text-sm text-muted">
                  {checklist.done} of {checklist.total} done — the fastest path to a
                  useful workspace.
                </p>
              </div>
              <form action={dismissOnboardingAction}>
                <button
                  type="submit"
                  className="focus-ring rounded-control px-2 py-1 text-xs text-muted hover:bg-surface-2"
                >
                  Dismiss
                </button>
              </form>
            </div>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {checklist.steps.map((step) => (
                <li key={step.id}>
                  <a
                    href={step.href}
                    className="flex items-start gap-2 rounded-control border border-border px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    <span aria-hidden className={step.done ? "text-success" : "text-muted"}>
                      {step.done ? "✓" : "○"}
                    </span>
                    <span>
                      <span className={step.done ? "line-through text-muted" : "font-medium"}>
                        {step.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{step.description}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

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
