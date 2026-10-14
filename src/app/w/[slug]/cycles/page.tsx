import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getCycles, getWorkspaceBySlug } from "@/server/queries";
import { CyclesBoard, type CycleRow } from "@/components/cycles-board";

export const metadata = { title: "Cycles" };

/** Sprints: committed vs completed effort, burndown and velocity. */
export default async function CyclesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const cycles = await getCycles(workspace.id);
  const rows: CycleRow[] = cycles.map((cycle) => ({
    id: cycle.id,
    name: cycle.name,
    goal: cycle.goal,
    startDate: cycle.startDate.toISOString(),
    endDate: cycle.endDate.toISOString(),
    tickets: cycle.tickets.map((ticket) => ({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      type: ticket.type,
      estimate: ticket.estimate,
      estimateUnit: ticket.estimateUnit,
      startDate: ticket.startDate?.toISOString() ?? null,
      dueDate: ticket.dueDate?.toISOString() ?? null,
      completedAt: ticket.completedAt?.toISOString() ?? null,
      updatedAt: ticket.updatedAt.toISOString(),
      assigneeName: ticket.assignee?.name ?? null,
    })),
  }));

  return (
    <div className="mx-auto max-w-4xl px-12 py-12">
      <Link
        href={`/w/${workspace.slug}`}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to {workspace.name}
      </Link>
      <h1 className="mt-2 text-[32px] font-bold tracking-[-0.02em]">Cycles</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        Time-box the work, commit to an estimate, and see what actually shipped. Schedule tickets from
        the ticket drawer — pick a cycle under “Scheduled in”.
      </p>

      <CyclesBoard workspaceId={workspace.id} cycles={rows} locale={user.locale ?? "en"} />
    </div>
  );
}
