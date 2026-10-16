import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import {
  getLabels,
  getTicketsPage,
  getWorkspaceBySlug,
  getWorkspaceMembers,
  getProjects,
  getTicketViews,
  getCycles,
} from "@/server/queries";
import { TicketsWorkspace, type TicketRow } from "@/components/tickets-workspace";
import { toTrackerTicket } from "@/lib/tickets";
import { t } from "@/lib/i18n";

export const metadata = { title: "Tickets" };

/** Tickets workspace: list, board and timeline over the same dataset. */
export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { slug } = await params;
  const { project: projectParam } = await searchParams;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const [ticketPage, labels, members, projects, views, cycles] = await Promise.all([
    getTicketsPage(workspace.id, { take: 100 }),
    getLabels(workspace.id),
    getWorkspaceMembers(workspace.id),
    getProjects(workspace.id),
    getTicketViews(workspace.id),
    getCycles(workspace.id),
  ]);

  const rows: TicketRow[] = ticketPage.tickets.map(toTrackerTicket);
  const locale = user.locale ?? "en";

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <p className="text-sm text-muted">{t(locale, "workspaceEyebrow")}</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">{t(locale, "tickets")}</h1>
      <p className="mt-2 mb-6 text-sm text-muted">{t(locale, "ticketsPageIntro")}</p>

      <TicketsWorkspace
        workspaceId={workspace.id}
        slug={workspace.slug}
        locale={user.locale ?? "en"}
        initialProjectFilter={projects.some((project) => project.id === projectParam) ? projectParam : ""}
        cycles={cycles.map((cycle) => ({ id: cycle.id, name: cycle.name }))}
        nextCursor={ticketPage.nextCursor}
        views={views.map((view) => ({
          id: view.id,
          name: view.name,
          config: (view.config ?? {}) as Record<string, unknown>,
        }))}
        tickets={rows}
        labels={labels.map((label) => ({
          id: label.id,
          name: label.name,
          color: label.color,
          count: label._count.tickets,
        }))}
        members={members.map((member) => ({ id: member.id, name: member.name }))}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
          icon: project.icon,
        }))}
      />
    </div>
  );
}
