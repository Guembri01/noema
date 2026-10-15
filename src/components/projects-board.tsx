"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleDot, FolderKanban, Pause, Plus, Target } from "lucide-react";
import { toast } from "sonner";
import { createProjectAction } from "@/server/actions/projects";
import { safeAction } from "@/lib/actions-client";
import { EMPTY_GROUP_KEY, type BoardGroup, type BoardRow } from "@/lib/board-groups";
import { t } from "@/lib/i18n";
import {
  canMoveRow,
  checkWip,
  wipSummary,
  type WipLimits,
  type WipStatus,
} from "@/lib/kanban-wip";

export type ProjectCard = {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  status: string;
  color: string;
  icon: string | null;
  dueDate: string | null;
  pageCount: number;
  milestones: { id: string; name: string; status: string; dueDate: string | null }[];
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600",
  paused: "bg-amber-500/10 text-amber-600",
  done: "bg-accent/10 text-accent",
  archived: "bg-surface-2 text-muted",
};

/** The board's columns: one per project status, in declaration order. */
const STATUS_ORDER = ["active", "paused", "done", "archived"] as const;

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  archived: "Archived",
};

/** WIP badge colours keyed by `checkWip`'s grade. */
const WIP_STYLES: Record<WipStatus, string> = {
  ok: "border-border text-muted",
  at: "border-amber-500/50 text-amber-600",
  over: "border-red-500/50 text-red-600",
};

/**
 * Adapt the project cards into the column shape `@/lib/kanban-wip` grades:
 * one bucket per status (plus a trailing "Other" bucket for unknown values,
 * mirroring `@/lib/board-groups`). Rows only need an id — WIP counting never
 * reads cell values.
 */
function projectStatusGroups(projects: readonly ProjectCard[]): BoardGroup<BoardRow>[] {
  const groups: BoardGroup<BoardRow>[] = STATUS_ORDER.map((status) => ({
    key: status,
    label: STATUS_LABELS[status] ?? status,
    optionId: status,
    rows: [],
  }));
  const byStatus = new Map<string, BoardGroup<BoardRow>>();
  for (const group of groups) byStatus.set(group.key, group);
  const other: BoardGroup<BoardRow> = {
    key: EMPTY_GROUP_KEY,
    label: "Other",
    optionId: null,
    rows: [],
  };
  for (const project of projects) {
    const row: BoardRow = { id: project.id, propertyValues: [] };
    (byStatus.get(project.status) ?? other).rows.push(row);
  }
  return [...groups, other];
}

/** Projects list: progress at a glance, with inline creation. */
export function ProjectsBoard({
  locale,
  workspaceId,
  slug,
  projects,
  wipLimits,
  wipOverride = false,
  onMoveProject,
}: {
  workspaceId: string;
  slug: string;
  projects: ProjectCard[];
  locale: string;
  /**
   * Optional per-status WIP limits (keyed by project status, e.g.
   * `{ active: 3 }`). Omit to leave the board unlimited — the WIP strip and
   * move controls only appear when at least one limit is configured.
   */
  wipLimits?: WipLimits;
  /** Allow a move into a column that is already at/over its limit. */
  wipOverride?: boolean;
  /** Called when a card is moved to another status column. */
  onMoveProject?: (projectId: string, status: string) => void | Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [dueDate, setDueDate] = useState("");

  const groups = useMemo(() => projectStatusGroups(projects), [projects]);
  const wipEnabled = wipLimits !== undefined && Object.keys(wipLimits).length > 0;
  const check = useMemo(() => checkWip(groups, wipLimits ?? {}), [groups, wipLimits]);
  const wip = useMemo(() => wipSummary(groups, wipLimits ?? {}), [groups, wipLimits]);
  const movable = wipEnabled && onMoveProject !== undefined;

  const moveTo = (projectId: string, status: string) => {
    if (!onMoveProject) return;
    if (!canMoveRow(groups, wipLimits ?? {}, projectId, status, { override: wipOverride })) {
      toast.error(`${STATUS_LABELS[status] ?? status} is at its WIP limit`);
      return;
    }
    startTransition(async () => {
      await onMoveProject(projectId, status);
    });
  };

  const create = () =>
    startTransition(async () => {
      const outcome = await safeAction(() =>
        createProjectAction({ workspaceId, name, summary, dueDate: dueDate || null }),
      );
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      setName("");
      setSummary("");
      setDueDate("");
      toast.success("Project created");
      router.push(`/w/${slug}/projects/${value.id}`);
      router.refresh();
    });

  return (
    <div>
      <div className="mb-6 rounded-xl border border-border p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FolderKanban className="h-4 w-4" /> {t(locale, "newProject")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            aria-label={t(locale, "projectName")}
            placeholder={t(locale, "projectName")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <input
            value={summary}
            aria-label={t(locale, "projectSummary")}
            placeholder={t(locale, "projectSummary")}
            onChange={(event) => setSummary(event.target.value)}
            className="h-9 w-72 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <input
            type="date"
            value={dueDate}
            aria-label={t(locale, "projectDue")}
            onChange={(event) => setDueDate(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={create}
            className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Create
          </button>
        </div>
      </div>

      {wipEnabled && (
        <div className="mb-6 rounded-xl border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">WIP limits</p>
            <p className="text-[11px] text-muted">
              {wip.limitedColumns}/{wip.columnCount} columns limited · {wip.remainingCapacity} slot
              {wip.remainingCapacity === 1 ? "" : "s"} left
              {wip.overCount > 0
                ? ` · ${wip.overCount} over by ${wip.excessRows}`
                : wip.atCount > 0
                  ? ` · ${wip.atCount} at limit`
                  : ""}
            </p>
          </div>
          <ul className="flex flex-wrap gap-1.5 text-[11px]">
            {check.columns.map((column) => {
              const label = STATUS_LABELS[column.key] ?? column.key;
              return (
                <li
                  key={column.key}
                  className={`rounded border px-1.5 py-0.5 ${WIP_STYLES[column.status]} ${
                    column.limit === undefined ? "opacity-60" : ""
                  }`}
                  title={
                    column.limit === undefined
                      ? `${label}: unlimited`
                      : `${label}: ${column.count}/${column.limit} (${column.status})`
                  }
                >
                  {label} {column.count}
                  {column.limit === undefined ? "" : `/${column.limit}`}
                  {column.status === "over" ? " over" : column.status === "at" ? " at limit" : ""}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {projects.length === 0 ? (
        <p className="text-sm text-muted">
          No projects yet — create one, then attach notes from the sidebar
          (right-click a page → Add to project).
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const total = project.milestones.length;
            const done = project.milestones.filter((m) => m.status === "done").length;
            const progress = total === 0 ? 0 : Math.round((done / total) * 100);
            const next = project.milestones.find((m) => m.status !== "done");
            return (
              <li key={project.id}>
                <div className="flex h-full flex-col">
                <Link
                  href={`/w/${slug}/projects/${project.id}`}
                  className="flex flex-1 flex-col gap-3 rounded-xl border border-border p-4 transition hover:bg-surface-2"
                >
                  <div className="flex items-center gap-2">
                    <span aria-hidden>{project.icon ?? "🚀"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                        STATUS_STYLES[project.status] ?? STATUS_STYLES.active
                      }`}
                    >
                      {project.status}
                    </span>
                  </div>
                  {project.description && (
                    <p className="line-clamp-1 text-xs text-muted">{project.description}</p>
                  )}
                  {project.summary && (
                    <p className="line-clamp-2 text-xs text-muted">{project.summary}</p>
                  )}
                  <div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2">
                      <div
                        className="h-full rounded bg-accent transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {done}/{total} milestones · {project.pageCount} note
                      {project.pageCount === 1 ? "" : "s"}
                      {project.dueDate
                        ? ` · due ${new Date(project.dueDate).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  {next && (
                    <p className="flex items-center gap-1.5 text-xs text-muted">
                      <Target className="h-3.5 w-3.5" />
                      Next: {next.name}
                    </p>
                  )}
                  <div className="mt-auto flex items-center gap-2 text-[11px] text-muted">
                    {project.status === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : project.status === "paused" ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <CircleDot className="h-3.5 w-3.5" />
                    )}
                    {total} milestone{total === 1 ? "" : "s"}
                  </div>
                </Link>
                {movable && (
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                    <span className="text-muted">Move to</span>
                    {STATUS_ORDER.filter((status) => status !== project.status).map((status) => {
                      const allowed = canMoveRow(groups, wipLimits ?? {}, project.id, status, {
                        override: wipOverride,
                      });
                      const label = STATUS_LABELS[status] ?? status;
                      return (
                        <button
                          key={status}
                          type="button"
                          disabled={!allowed || pending}
                          title={
                            allowed
                              ? `Move ${project.name} to ${label}`
                              : `${label} is at its WIP limit`
                          }
                          onClick={() => moveTo(project.id, status)}
                          className="rounded border border-border px-1.5 py-0.5 text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
