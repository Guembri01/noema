import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getProjects, getWorkspaceBySlug } from "@/server/queries";
import { ProjectsBoard } from "@/components/projects-board";
import { t } from "@/lib/i18n";

export const metadata = { title: "Projects" };

/** Projects area: every project with its milestone progress. */
export default async function ProjectsPage({
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

  const projects = await getProjects(workspace.id);

  return (
    <div className="mx-auto max-w-5xl px-8 py-12">
      <p className="text-sm text-muted">Workspace</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">{t(locale, "projectsHeading")}</h1>
      <p className="mt-2 mb-8 text-sm text-muted">
        {t(locale, "projectsIntro")}
      </p>

      <ProjectsBoard
        locale={locale}
        workspaceId={workspace.id}
        slug={workspace.slug}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
          summary: project.summary,
          description: project.description,
          status: project.status,
          color: project.color,
          icon: project.icon,
          dueDate: project.dueDate?.toISOString() ?? null,
          pageCount: project._count.pages,
          milestones: project.milestones.map((milestone) => ({
            id: milestone.id,
            name: milestone.name,
            status: milestone.status,
            dueDate: milestone.dueDate?.toISOString() ?? null,
          })),
        }))}
      />
    </div>
  );
}
