import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getProjectDetail, getProjectTickets, getWorkspaceBySlug } from "@/server/queries";
import { ProjectDetail } from "@/components/project-detail";
import { ProjectActions } from "@/components/project-actions";
import { ProjectGantt } from "@/components/project-gantt";
import { formatEstimate, isClosed, statusMeta, sumEstimates } from "@/lib/tickets";
import { t } from "@/lib/i18n";

export const metadata = { title: "Project" };

/** One project: status, milestones and its attached notes. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  const locale = user.locale ?? "en";

  const project = await getProjectDetail(workspace.id, projectId);
  if (!project) notFound();

  const tickets = await getProjectTickets(workspace.id, project.id);
  const open = tickets.filter((ticket) => !isClosed(ticket.status));
  const totalEstimate = sumEstimates(tickets);
  const remainingEstimate = sumEstimates(open);

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      <Link
        href={`/w/${workspace.slug}/projects`}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> {t(locale, "allProjects")}
      </Link>
      <h1 className="mt-2 mb-8 text-3xl font-bold tracking-tight">
        {project.icon ? `${project.icon} ` : ""}
        {project.name}
      </h1>

      <ProjectActions
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        projectId={project.id}
        projectName={project.name}
        locale={user.locale ?? "en"}
      />

      <div className="mt-6">
        <ProjectGantt
          name={project.name}
          startDate={project.startDate?.toISOString() ?? null}
          dueDate={project.dueDate?.toISOString() ?? null}
          locale={user.locale ?? "en"}
          milestones={project.milestones.map((milestone) => ({
            id: milestone.id,
            name: milestone.name,
            status: milestone.status,
            dueDate: milestone.dueDate?.toISOString() ?? null,
          }))}
        />
      </div>

      {project.members.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          {t(locale, "clientsWithAccess")}{" "}
          {project.members.map((member) => `${member.user.name} (${member.role.toLowerCase()})`).join(", ")}
        </p>
      )}

      {tickets.length > 0 && (
        <section className="mt-8 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
              {t(locale, "tickets")}
            </h2>
            <span className="text-xs text-muted">
              {tickets.length} {t(locale, "totalWord")} · {open.length}{" "}
              {t(locale, "openWord")} · {t(locale, "estimateLower")}{" "}
              <strong className="text-fg">
                {formatEstimate(totalEstimate.total, totalEstimate.unit)}
              </strong>{" "}
              (
              {formatEstimate(remainingEstimate.total, remainingEstimate.unit)}{" "}
              {t(locale, "remainingWord")})
            </span>
            <Link
              href={`/w/${workspace.slug}/tickets?project=${project.id}`}
              className="ml-auto text-xs text-accent hover:underline"
            >
              {t(locale, "openInTracker")}
            </Link>
          </div>
          <ul className="mt-3 divide-y divide-border">
            {tickets.slice(0, 8).map((ticket) => (
              <li key={ticket.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="w-16 shrink-0 font-mono text-[11px] text-muted">{ticket.key}</span>
                <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                {ticket.labels.map((entry) => (
                  <span
                    key={entry.label.id}
                    className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
                  >
                    {entry.label.name}
                  </span>
                ))}
                <span className="text-xs text-muted">
                  {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
                </span>
                <span className="w-20 text-right text-[10px] uppercase text-muted">
                  {statusMeta(ticket.status).label}
                </span>
              </li>
            ))}
          </ul>
          {tickets.length > 8 && (
            <Link
              href={`/w/${workspace.slug}/tickets?project=${project.id}`}
              className="mt-2 inline-block text-xs text-muted hover:text-fg"
            >
              + {tickets.length - 8} {t(locale, "moreWord")}
            </Link>
          )}
        </section>
      )}

      <div className="mt-8">
      <ProjectDetail
        slug={workspace.slug}
        locale={user.locale ?? "en"}
        project={{
          id: project.id,
          name: project.name,
          summary: project.summary,
          description: project.description,
          status: project.status,
          icon: project.icon,
          startDate: project.startDate?.toISOString() ?? null,
          dueDate: project.dueDate?.toISOString() ?? null,
          milestones: project.milestones.map((milestone) => ({
            id: milestone.id,
            name: milestone.name,
            description: milestone.description,
            status: milestone.status,
            dueDate: milestone.dueDate?.toISOString() ?? null,
            completedAt: milestone.completedAt?.toISOString() ?? null,
          })),
          pages: project.pages.map((page) => ({
            id: page.id,
            title: page.title,
            icon: page.icon,
            type: page.type,
          })),
        }}
      />
      </div>
    </div>
  );
}
