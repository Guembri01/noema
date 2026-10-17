import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getProjects, getTickets, getWorkspaceBySlug } from "@/server/queries";
import {
  buildRoadmap,
  describeRoadmap,
  milestones,
  projectRollup,
  roadmapAxis,
  type RoadmapItem,
  type RoadmapZoom,
} from "@/lib/roadmap";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata = { title: "Roadmap" };

const ZOOMS: readonly RoadmapZoom[] = ["week", "month", "quarter"];
const ZOOM_LABELS: Record<RoadmapZoom, string> = {
  week: "Week",
  month: "Month",
  quarter: "Quarter",
};
const MS_PER_DAY = 86_400_000;
const UNASSIGNED = "unassigned";

function isZoom(value: unknown): value is RoadmapZoom {
  return typeof value === "string" && (ZOOMS as readonly string[]).includes(value);
}

/**
 * Cross-project roadmap (MISSING_FEATURES §20 "Roadmap view").
 *
 * Every dated item — project milestones (zero-duration) and tickets — is folded
 * into one `RoadmapItem` list, then laid out by `@/lib/roadmap`: `buildRoadmap`
 * packs each project's items onto non-overlapping rows and positions them on a
 * shared axis; `roadmapAxis` produces the aligned tick boundaries; `milestones`
 * extracts the zero-duration markers and `projectRollup` aggregates progress
 * per project. All layout is pure and UTC-deterministic.
 */
export default async function RoadmapPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ zoom?: string }>;
}) {
  const { slug } = await params;
  const { zoom: zoomParam } = await searchParams;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const zoom: RoadmapZoom = isZoom(zoomParam) ? zoomParam : "month";
  const [projects, tickets] = await Promise.all([
    getProjects(workspace.id),
    getTickets(workspace.id),
  ]);

  const now = Date.now();
  const projectNames = new Map<string, string>();
  const items: RoadmapItem[] = [];

  for (const project of projects) {
    projectNames.set(project.id, `${project.icon ? `${project.icon} ` : ""}${project.name}`);
    for (const milestone of project.milestones) {
      items.push({
        id: `milestone:${milestone.id}`,
        projectId: project.id,
        title: milestone.name,
        start: milestone.dueDate?.getTime(),
        status: milestone.status,
        progress: milestone.status === "done" ? 1 : 0,
      });
    }
  }

  for (const ticket of tickets) {
    items.push({
      id: `ticket:${ticket.id}`,
      projectId: ticket.project?.id ?? UNASSIGNED,
      title: `${ticket.key} ${ticket.title}`,
      start: (ticket.startDate ?? ticket.dueDate)?.getTime(),
      end: ticket.dueDate?.getTime(),
      status: ticket.status,
      progress: ticket.completedAt ? 1 : undefined,
    });
  }

  const starts = items
    .map((item) => item.start)
    .filter((value): value is number => typeof value === "number");
  const from = (starts.length > 0 ? Math.min(...starts) : now) - 7 * MS_PER_DAY;
  const to = Math.max(now, ...starts) + 14 * MS_PER_DAY;

  const roadmap = buildRoadmap(items, { from, to, zoom, now });
  const axis = roadmapAxis(from, to, zoom);
  const rollups = projectRollup(items);
  const milestoneItems = milestones(items);
  const summary = describeRoadmap(items, { now });

  const laneName = (projectId: string) => projectNames.get(projectId) ?? "No project";
  const pctOf = (value: number) =>
    Math.max(0, Math.min(100, ((value - from) / Math.max(1, to - from)) * 100));
  const nowLeft = pctOf(now);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <header className="mb-6">
        <p className="text-sm text-muted">Workspace</p>
        <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.02em]">Roadmap</h1>
        <p className="mt-2 text-sm text-muted">
          Every project&apos;s milestones and tickets on one shared timeline.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">Zoom</span>
        {ZOOMS.map((value) => (
          <Link
            key={value}
            href={`/w/${workspace.slug}/roadmap?zoom=${value}`}
            className={
              value === zoom
                ? "rounded border border-accent px-2 py-1 text-xs text-accent"
                : "rounded border border-border px-2 py-1 text-xs text-muted hover:text-fg"
            }
          >
            {ZOOM_LABELS[value]}
          </Link>
        ))}
        <span className="ml-auto text-xs text-muted">
          {summary.scheduled}/{summary.total} scheduled · {summary.milestones} milestones ·{" "}
          {summary.completed} complete · {summary.overdue} overdue
        </span>
      </div>

      {roadmap.lanes.length === 0 ? (
        <EmptyState
          className="mt-10"
          icon={<CalendarRange className="h-5 w-5" />}
          title="No dated work yet"
          description="Give milestones or tickets a date and they appear here."
          primaryAction={
            <Button asChild variant="secondary">
              <Link href={`/w/${workspace.slug}/projects`}>Go to projects</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-6 space-y-6">
          {roadmap.lanes.map((lane) => {
            const rollup = rollups.find((entry) => entry.projectId === lane.projectId);
            return (
              <section key={lane.projectId} className="rounded-xl border border-border p-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-3">
                  <h2 className="text-sm font-medium">{laneName(lane.projectId)}</h2>
                  <span className="text-xs text-muted">
                    {lane.rows.length} item{lane.rows.length === 1 ? "" : "s"}
                    {rollup ? ` · ${Math.round(rollup.progress * 100)}% complete` : ""}
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <div className="relative min-w-[640px]">
                    <div className="relative h-6 border-b border-border">
                      {axis.ticks.map((tick) => (
                        <div
                          key={tick.start}
                          className="absolute top-0 h-full border-l border-border/60 pl-1 text-3xs text-muted"
                          style={{ left: `${pctOf(tick.start)}%` }}
                        >
                          {tick.label}
                        </div>
                      ))}
                      <div
                        className="absolute top-0 h-full border-l border-danger/70"
                        style={{ left: `${nowLeft}%` }}
                        aria-hidden
                      />
                    </div>

                    <div className="space-y-1 pt-2">
                      {[...lane.rows]
                        .sort((a, b) => a.laneIndex - b.laneIndex || b.width - a.width)
                        .map((row) => (
                          <div key={row.item.id} className="relative h-6">
                            <div
                              className={
                                row.overdue
                                  ? "absolute top-1 h-4 rounded bg-danger/70 px-1.5 text-3xs leading-4 text-white"
                                  : row.width === 0
                                    ? "absolute top-1.5 h-3 w-3 -translate-x-1/2 rotate-45 rounded-sm bg-accent"
                                    : "absolute top-1 h-4 overflow-hidden rounded bg-accent px-1.5 text-3xs leading-4 text-accent-fg"
                              }
                              style={
                                row.width === 0
                                  ? { left: `${row.x * 100}%` }
                                  : { left: `${row.x * 100}%`, width: `${Math.max(row.width * 100, 0.6)}%` }
                              }
                              title={`${row.item.title} — ${row.item.status ?? "—"}`}
                            >
                              {row.width === 0 ? null : <span className="truncate">{row.item.title}</span>}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Rollup</h2>
          {rollups.length === 0 ? (
            <EmptyState variant="compact" title="Nothing tracked yet" />
          ) : (
            <ul className="space-y-2">
              {rollups.map((rollup) => (
                <li key={rollup.projectId} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">{laneName(rollup.projectId)}</span>
                  <span className="text-xs text-muted">
                    {rollup.trackedCount}/{rollup.itemCount} tracked
                  </span>
                  <span className="h-2 w-24 overflow-hidden rounded bg-surface-2">
                    <span
                      className="block h-full rounded bg-accent"
                      style={{ width: `${Math.round(rollup.progress * 100)}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            Milestones · {milestoneItems.length}
          </h2>
          {milestoneItems.length === 0 ? (
            <EmptyState variant="compact" title="No milestones yet" />
          ) : (
            <ul className="space-y-1">
              {milestoneItems.slice(0, 12).map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <span aria-hidden>◆</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="text-xs text-muted">{laneName(item.projectId)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
