"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleDot,
  FolderKanban,
  Gauge,
  Pause,
  Plus,
  RefreshCw,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { createProjectAction } from "@/server/actions/projects";
import { safeAction } from "@/lib/actions-client";
import { EMPTY_GROUP_KEY, type BoardGroup, type BoardRow } from "@/lib/board-groups";
import { t } from "@/lib/i18n";
import type { AvatarUser } from "@/lib/avatars";
import {
  Badge,
  type BadgeTone,
} from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AvatarGroup } from "@/components/ui/avatar";
import { Progress, type ProgressTone } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  canMoveRow,
  checkWip,
  wipSummary,
  type WipColumn,
  type WipLimits,
  type WipStatus,
} from "@/lib/kanban-wip";
import {
  progressOf,
  rollupEstimate,
  type EstimateRollup,
  type RollupTicket,
  type TicketProgress,
} from "@/lib/sub-ticket-rollup";

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
  /** Members shown as an avatar stack on the card. */
  members?: readonly AvatarUser[];
};

/** The board's columns: one per project status, in declaration order. */
export const STATUS_ORDER = ["active", "paused", "done", "archived"] as const;

export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  archived: "Archived",
};

/**
 * Status → badge tone. Green reads "moving", amber "paused", accent "finished",
 * neutral "archived"; an unknown status falls back to neutral so a card can
 * never render an unstyled pill.
 */
export const PROJECT_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  paused: "warning",
  done: "accent",
  archived: "neutral",
};

export function projectStatusTone(status: string): BadgeTone {
  return PROJECT_STATUS_TONE[status] ?? "neutral";
}

/** Human label for a status, falling back to the raw value. */
export function projectStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Milestone-derived progress: how many are done, out of how many. */
export type MilestoneProgress = { total: number; done: number; percent: number };

/**
 * Milestone progress maths: `done / total` as a whole percent (0 for an empty
 * list, so a project without milestones shows an empty bar rather than NaN).
 */
export function milestoneProgress(
  milestones: readonly { status: string }[],
): MilestoneProgress {
  const total = milestones.length;
  const done = milestones.filter((milestone) => milestone.status === "done").length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** A finished project reads green; anything else stays on the accent. */
export function progressTone(percent: number): ProgressTone {
  return percent >= 100 ? "success" : "accent";
}

/** How many days before the due date the chip starts warning. */
export const DUE_SOON_DAYS = 3;

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/**
 * Whether a due date is already in the past (day granularity). A missing or
 * unparseable date is never overdue.
 */
export function isOverdue(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!dueDate) return false;
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return false;
  return startOfDay(date) < startOfDay(now);
}

/**
 * Tone for the due-date chip: `danger` once overdue, `warning` within
 * {@link DUE_SOON_DAYS} days, `neutral` otherwise. Missing dates read neutral.
 */
export function dueTone(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): BadgeTone {
  if (!dueDate) return "neutral";
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return "neutral";
  const due = startOfDay(date);
  const today = startOfDay(now);
  if (due < today) return "danger";
  if (due <= today + DUE_SOON_DAYS * 24 * 60 * 60 * 1000) return "warning";
  return "neutral";
}

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

/** WIP badge colours keyed by `checkWip`'s grade. */
const WIP_STYLES: Record<WipStatus, string> = {
  ok: "border-border text-muted",
  at: "border-warning/50 text-warning",
  over: "border-danger/50 text-danger",
};

/** Ticket-derived health grades for a project card. */
export type ProjectHealthGrade = "done" | "on-track" | "at-risk" | "off-track";

/** Badge tone keyed by `ProjectHealthGrade`. */
const HEALTH_TONE: Record<ProjectHealthGrade, BadgeTone> = {
  done: "success",
  "on-track": "accent",
  "at-risk": "warning",
  "off-track": "danger",
};

export function healthTone(grade: ProjectHealthGrade): BadgeTone {
  return HEALTH_TONE[grade];
}

const HEALTH_LABELS: Record<ProjectHealthGrade, string> = {
  done: "Done",
  "on-track": "On track",
  "at-risk": "At risk",
  "off-track": "Off track",
};

/** A project's ticket-derived health, or `null` when there is nothing to show. */
export type ProjectHealth = {
  grade: ProjectHealthGrade;
  progress: TicketProgress;
  rollup: EstimateRollup;
};

/**
 * Derive a health badge from a project's own tickets through
 * `@/lib/sub-ticket-rollup`: `progressOf` supplies the done/total percentage
 * and `rollupEstimate` the counts plus the remaining (open) estimate.
 * `null`/empty ticket data yields `null`, so the badge stays hidden and the
 * board is unchanged for callers that supply no tickets. Grades: every ticket
 * closed → `"done"`; otherwise the completion percentage buckets into
 * on-track (≥75%), at-risk (≥40%) and off-track.
 */
function projectHealth(tickets: readonly RollupTicket[] | undefined): ProjectHealth | null {
  if (!tickets || tickets.length === 0) return null;
  const progress = progressOf(tickets);
  const rollup = rollupEstimate(tickets);
  const grade: ProjectHealthGrade =
    progress.done === progress.total
      ? "done"
      : progress.percent >= 75
        ? "on-track"
        : progress.percent >= 40
          ? "at-risk"
          : "off-track";
  return { grade, progress, rollup };
}

/**
 * One project as a design-system card: a status `Badge`, a milestone `Progress`
 * bar, a due-date chip that turns `danger` when overdue, a member `AvatarGroup`
 * and hover lift via `Card`'s `interactive` variant (`.u-interactive`). Pure and
 * router-free, so it renders (and is asserted) on its own.
 */
export function ProjectCardTile({
  project,
  slug,
  locale,
  now = new Date(),
  health = null,
}: {
  project: ProjectCard;
  slug: string;
  locale: string;
  now?: Date;
  /** Ticket health, already derived by the board (kept out of the tile). */
  health?: ProjectHealth | null;
}) {
  const { total, done, percent } = milestoneProgress(project.milestones);
  const next = project.milestones.find((milestone) => milestone.status !== "done");
  const due = project.dueDate ? new Date(project.dueDate) : null;
  const members = project.members ?? [];

  return (
    <Card
      as="a"
      href={`/w/${slug}/projects/${project.id}`}
      variant="interactive"
      padding="md"
      data-testid="project-card"
      data-status={project.status}
      className="flex h-full flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>{project.icon ?? "🚀"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
        <Badge
          data-testid="project-status-badge"
          tone={projectStatusTone(project.status)}
          size="sm"
        >
          {projectStatusLabel(project.status)}
        </Badge>
        {health && (
          <Badge
            data-testid="project-health-badge"
            data-health={health.grade}
            tone={healthTone(health.grade)}
            size="sm"
            title={`${health.progress.done}/${health.progress.total} tickets done · ${health.progress.percent}%${
              health.rollup.total > 0 ? ` · ${health.rollup.remaining} left` : ""
            }`}
          >
            {HEALTH_LABELS[health.grade]}
          </Badge>
        )}
      </div>

      {project.description && (
        <p className="line-clamp-1 text-xs text-muted">{project.description}</p>
      )}
      {project.summary && <p className="line-clamp-2 text-xs text-muted">{project.summary}</p>}

      <Progress
        value={percent}
        max={100}
        size="sm"
        tone={progressTone(percent)}
        showValue
        label={`${done}/${total} ${t(locale, "milestonesComplete")}`}
      />

      <div className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-muted">
        {project.status === "done" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : project.status === "paused" ? (
          <Pause className="h-3.5 w-3.5" />
        ) : (
          <CircleDot className="h-3.5 w-3.5" />
        )}
        <span>
          {project.pageCount} note{project.pageCount === 1 ? "" : "s"}
        </span>
        {due && (
          <Badge
            data-testid="project-due-chip"
            data-overdue={isOverdue(project.dueDate, now) ? "true" : undefined}
            tone={dueTone(project.dueDate, now)}
            size="sm"
            icon={<Target className="h-3 w-3" />}
          >
            {t(locale, "dueWord")} {due.toLocaleDateString()}
          </Badge>
        )}
        {members.length > 0 && (
          <AvatarGroup
            data-testid="project-avatar-stack"
            users={members}
            size={24}
            max={4}
            className="ms-auto"
          />
        )}
      </div>

      {next && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Target className="h-3.5 w-3.5" />
          Next: {next.name}
        </p>
      )}
    </Card>
  );
}

/**
 * Self-contained WIP-limit editor for the project status columns.
 *
 * The limits live only in the board's local state (there is no persisted
 * project-board config yet), which is what makes the WIP strip and move guards
 * from `@/lib/kanban-wip` reachable before anything is saved. Blank input
 * clears a column's limit; only finite, non-negative integers are accepted,
 * mirroring the engine's own validation. The grade shown next to a field is the
 * live `checkWip` status for that column's current row count.
 */
function WipLimitsEditor({
  limits,
  columns,
  onChange,
  onClear,
}: {
  limits: WipLimits;
  columns: readonly WipColumn[];
  onChange: (key: string, value: string) => void;
  onClear: () => void;
}) {
  const statusByKey = new Map(columns.map((column) => [column.key, column.status]));
  const limited = Object.keys(limits).length > 0;
  return (
    <div className="mb-6 rounded-xl border border-border p-4" data-testid="wip-editor">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Gauge className="h-4 w-4" /> WIP limits
        </p>
        <div className="flex items-center gap-2">
          <p className="text-[11px] text-muted">Local only — leave blank for no limit.</p>
          {limited && (
            <Button type="button" variant="secondary" size="xs" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <ul className="flex flex-wrap gap-3">
        {STATUS_ORDER.map((status) => {
          const label = STATUS_LABELS[status] ?? status;
          const limit = limits[status];
          const grade = statusByKey.get(status);
          return (
            <li key={status} className="flex items-center gap-2">
              <span className="text-xs">{label}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={limit ?? ""}
                placeholder="∞"
                aria-label={`${label} WIP limit`}
                onChange={(event) => onChange(status, event.target.value)}
                className="h-8 w-16 rounded border border-border bg-bg px-2 text-sm outline-none focus-ring focus:border-accent"
              />
              {grade === "over" ? (
                <span className="text-[11px] text-danger">over</span>
              ) : grade === "at" ? (
                <span className="text-[11px] text-warning">at limit</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Projects list: progress at a glance, with inline creation. */
export function ProjectsBoard({
  locale,
  workspaceId,
  slug,
  projects,
  ticketsByProject,
  wipLimits,
  wipOverride = false,
  onMoveProject,
  loading = false,
  error = null,
  onRetry,
}: {
  workspaceId: string;
  slug: string;
  projects: ProjectCard[];
  /**
   * Optional ticket roll-up data keyed by project id (the flat `{ id, parentId,
   * estimate, done|state, ... }` shape `@/lib/sub-ticket-rollup` consumes). When
   * a project has at least one ticket a health badge is derived from it; when
   * this prop is omitted (or a project has no entry/empty list) no badge is
   * rendered and the board behaves exactly as before.
   */
  ticketsByProject?: Record<string, readonly RollupTicket[]>;
  locale: string;
  /**
   * Optional per-status WIP limits (keyed by project status, e.g.
   * `{ active: 3 }`) used to seed the board's local editor. Omit to start
   * unlimited — the WIP strip and move controls only appear once a limit is set
   * (in the editor, or through this prop for callers that already have config).
   */
  wipLimits?: WipLimits;
  /** Allow a move into a column that is already at/over its limit. */
  wipOverride?: boolean;
  /** Called when a card is moved to another status column. */
  onMoveProject?: (projectId: string, status: string) => void | Promise<void>;
  /** `loading` state: a skeleton grid matching the final card layout. */
  loading?: boolean;
  /** `error` state: message + retry, shown above the list. */
  error?: string | null;
  /** Retry handler for the `error` state. */
  onRetry?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [dueDate, setDueDate] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  // WIP limits are edited locally so the strip and move guards are reachable
  // without a persisted config. Seeded once from the optional prop; an unset
  // prop means no limits, exactly as before.
  const [localLimits, setLocalLimits] = useState<WipLimits>(() => wipLimits ?? {});

  const groups = useMemo(() => projectStatusGroups(projects), [projects]);
  const limits = localLimits;
  const wipEnabled = Object.keys(limits).length > 0;
  const check = useMemo(() => checkWip(groups, limits), [groups, limits]);
  const wip = useMemo(() => wipSummary(groups, limits), [groups, limits]);
  const movable = wipEnabled && onMoveProject !== undefined;

  /** Set (or clear, on blank) one status column's limit in local state. */
  const setLimit = (key: string, value: string) => {
    setLocalLimits((previous) => {
      const next: Record<string, number> = { ...previous };
      if (value.trim() === "") {
        delete next[key];
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) return previous;
        next[key] = parsed;
      }
      return next;
    });
  };
  const clearLimits = () => setLocalLimits({});

  const moveTo = (projectId: string, status: string) => {
    if (!onMoveProject) return;
    if (!canMoveRow(groups, limits, projectId, status, { override: wipOverride })) {
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

  const focusCreate = () => nameRef.current?.focus();

  return (
    <div>
      <div className="mb-6 rounded-xl border border-border p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FolderKanban className="h-4 w-4" /> {t(locale, "newProject")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={nameRef}
            value={name}
            aria-label={t(locale, "projectName")}
            placeholder={t(locale, "projectName")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus-ring focus:border-accent"
          />
          <input
            value={summary}
            aria-label={t(locale, "projectSummary")}
            placeholder={t(locale, "projectSummary")}
            onChange={(event) => setSummary(event.target.value)}
            className="h-9 w-72 rounded border border-border bg-bg px-2 text-sm outline-none focus-ring focus:border-accent"
          />
          <input
            type="date"
            value={dueDate}
            aria-label={t(locale, "projectDue")}
            onChange={(event) => setDueDate(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus-ring focus:border-accent"
          />
          <Button
            type="button"
            disabled={pending || !name.trim()}
            onClick={create}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Create
          </Button>
        </div>
      </div>

      <WipLimitsEditor
        limits={limits}
        columns={check.columns}
        onChange={setLimit}
        onClear={clearLimits}
      />

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

      {error && (
        <div
          role="alert"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{error}</span>
          {onRetry && (
            <Button
              type="button"
              variant="danger"
              tone="soft"
              size="sm"
              onClick={onRetry}
              leftIcon={<RefreshCw className="h-4 w-4" />}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <ul aria-hidden data-testid="projects-skeleton" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index}>
              <Skeleton variant="card" />
            </li>
          ))}
        </ul>
      ) : projects.length === 0 ? (
        <EmptyState
          data-testid="projects-empty"
          icon={<FolderKanban className="h-6 w-6" />}
          title="No projects yet"
          description="Create a project to track deliverables with milestones, then attach the notes that belong to it."
          primaryAction={
            <Button
              type="button"
              onClick={focusCreate}
              leftIcon={<Plus className="h-4 w-4" />}
            >
              New project
            </Button>
          }
          tip="Right-click a page in the sidebar and choose “Add to project”."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id} className="flex flex-col">
              <ProjectCardTile
                project={project}
                slug={slug}
                locale={locale}
                health={projectHealth(ticketsByProject?.[project.id])}
              />
              {movable && (
                <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                  <span className="text-muted">Move to</span>
                  {STATUS_ORDER.filter((status) => status !== project.status).map((status) => {
                    const allowed = canMoveRow(groups, limits, project.id, status, {
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
                        className="rounded border border-border px-1.5 py-0.5 text-muted u-interactive hover:bg-surface-2 focus-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
