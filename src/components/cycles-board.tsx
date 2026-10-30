"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Pencil, Plus, Trash2, TrendingUp } from "lucide-react";
import {
  createCycleAction,
  deleteCycleAction,
  updateCycleAction,
} from "@/server/actions/cycles";
import { useAction } from "@/lib/actions-client";
import { PromptDialog } from "@/components/prompt-dialog";
import {
  activeCycle,
  burndownSeries,
  cycleDays,
  cycleProgress,
  scopeChange,
  velocity,
  type Cycle,
  type CycleTicket,
} from "@/lib/cycles";
import { groupByBucket } from "@/lib/date-bucket";
import {
  formatEstimate,
  statusMeta,
  UNASSIGNED_BUCKET,
  workloadByAssignee,
} from "@/lib/tickets";
import { LocalTime } from "@/components/local-time";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress, type ProgressTone } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type CycleRow = {
  id: string;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  tickets: (CycleTicket & {
    key: string;
    title: string;
    assigneeId?: string | null;
    assigneeName?: string | null;
  })[];
};

const day = (value: string) => value.slice(0, 10);

/* ------------------------------------------------------------------------- *
 * Pure mappings (proven by cycles-board.test.ts)
 * ------------------------------------------------------------------------- */

/**
 * Hover-tooltip label for one burndown point: the date plus the measured
 * remaining effort. Unmeasured (future / not-yet-observed) days say so rather
 * than rendering a bare `null`.
 */
export function burndownPointLabel(
  point: { date: string; remaining: number | null },
  unit = "points",
): string {
  if (point.remaining === null) return `${point.date} · not measured yet`;
  return `${point.date} · ${point.remaining} ${unit} remaining`;
}

/** Hover-tooltip label for the ideal line at a point. */
export function burndownIdealLabel(
  point: { date: string; ideal: number },
  unit = "points",
): string {
  return `${point.date} · ideal ${point.ideal} ${unit}`;
}

/**
 * Build an SVG polyline `points` string from a burndown series. `remaining`
 * skips unmeasured days (a broken segment would be a lie); `ideal` always has a
 * value. Indexed by day, so a gap keeps the day's x-position.
 */
export function burndownPolyline(
  points: readonly { remaining: number | null; ideal: number }[],
  key: "remaining" | "ideal",
): string {
  const parts: string[] = [];
  points.forEach((point, index) => {
    const value = key === "remaining" ? point.remaining : point.ideal;
    if (value === null || !Number.isFinite(value)) return;
    parts.push(`${index},${value}`);
  });
  return parts.join(" ");
}

/** The chart's viewBox extent: `n-1` days wide, the busiest point tall. */
export function burndownViewBox(
  points: readonly { remaining: number | null; ideal: number }[],
): { width: number; height: number } {
  let height = 1;
  for (const point of points) {
    if (point.remaining !== null && Number.isFinite(point.remaining)) {
      height = Math.max(height, point.remaining);
    }
    if (Number.isFinite(point.ideal)) height = Math.max(height, point.ideal);
  }
  return { width: Math.max(points.length - 1, 1), height };
}

/**
 * Tone for the days-left badge: `danger` in the last day, `warning` in the last
 * three, `neutral` otherwise.
 */
export function daysLeftTone(daysLeft: number): BadgeTone {
  if (!Number.isFinite(daysLeft) || daysLeft <= 1) return "danger";
  if (daysLeft <= 3) return "warning";
  return "neutral";
}

/** A finished cycle reads green; anything else stays on the accent. */
export function cycleProgressTone(percent: number): ProgressTone {
  return percent >= 100 ? "success" : "accent";
}

/* ------------------------------------------------------------------------- *
 * Cycle card
 * ------------------------------------------------------------------------- */

/**
 * One cycle as a design-system card: a `Progress` bar for completion, a
 * days-left `Badge`, a token-coloured burndown chart with per-point hover
 * tooltips, and ticket chips as `Tag`s. Router-free and callback-driven, so it
 * renders (and is asserted) on its own.
 */
export function CycleCard({
  cycle,
  isCurrent,
  locale,
  now,
  onEdit,
  onDelete,
  deleting = false,
}: {
  cycle: CycleRow;
  isCurrent: boolean;
  locale: string;
  /** Fixed clock for deterministic rendering; defaults to `new Date()`. */
  now?: Date;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const progress = cycleProgress(cycle.tickets, cycle);
  const max = Math.max(progress.committed, 1);
  // The pure burndown/scope helpers read the stored `start`/`end` shape, so map
  // the row's `startDate`/`endDate` onto it.
  const cycleRef: Cycle = {
    id: cycle.id,
    name: cycle.name,
    start: cycle.startDate,
    end: cycle.endDate,
  };
  const burndown = burndownSeries(cycleRef, cycle.tickets, now ? { now } : {});
  const scope = scopeChange(cycle.tickets, cycleRef);
  const view = burndownViewBox(burndown);
  // Per-person load inside this cycle's window; the page only ships the
  // assignee name, so fall back to it when there is no id.
  const load = workloadByAssignee(
    cycle.tickets.map((ticket) => ({
      ...ticket,
      assigneeId: ticket.assigneeId ?? ticket.assigneeName ?? null,
    })),
    { dateRange: { start: cycle.startDate, end: cycle.endDate } },
  );
  const loadLabel = (assigneeId: string) => {
    if (assigneeId === UNASSIGNED_BUCKET) return t(locale, "unassigned");
    const holder = cycle.tickets.find(
      (ticket) => (ticket.assigneeId ?? ticket.assigneeName) === assigneeId,
    );
    return holder?.assigneeName ?? assigneeId;
  };
  // Read the cycle's tickets as a small schedule: one bucket per UTC due day,
  // chronological. The engine skips tickets with no (or an invalid) due date, so
  // the undated tally is derived from what it did bucket.
  const byDue = groupByBucket(cycle.tickets, {
    dateOf: (ticket) => ticket.dueDate,
    unit: "day",
  });
  const dated = byDue.reduce((sum, bucket) => sum + bucket.entries.length, 0);
  const undated = cycle.tickets.length - dated;
  const pointRadius = Math.max(view.height * 0.02, 0.05);

  return (
    <li
      data-testid="cycle-card"
      className={cn("rounded-lg border p-4", isCurrent ? "border-action/40" : "border-border")}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">{cycle.name}</h3>
        {isCurrent && (
          <Badge data-testid="cycle-running" tone="accent" size="sm">
            running
          </Badge>
        )}
        <span className="text-xs text-muted">
          <LocalTime value={cycle.startDate} mode="date" /> →{" "}
          <LocalTime value={cycle.endDate} mode="date" /> · {cycleDays(cycle)} days
        </span>
        <Badge
          data-testid="cycle-days-left"
          tone={daysLeftTone(progress.daysLeft)}
          size="sm"
          className="ms-auto"
        >
          {progress.daysLeft} left
        </Badge>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`${t(locale, "edit")} ${cycle.name}`}
            onClick={onEdit}
            disabled={!onEdit}
            className="flex h-7 w-7 items-center justify-center rounded-control text-muted u-interactive hover:bg-surface-2 focus-ring disabled:opacity-50"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`${t(locale, "delete")} ${cycle.name}`}
            onClick={onDelete}
            disabled={!onDelete || deleting}
            className="flex h-7 w-7 items-center justify-center rounded-control text-muted u-interactive hover:bg-surface-2 hover:text-danger focus-ring disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {cycle.goal && <p className="mt-1 text-sm text-muted">{cycle.goal}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <span>
          Completed{" "}
          <strong className="text-fg">
            {formatEstimate(progress.completed, progress.unit)}
          </strong>{" "}
          of {formatEstimate(progress.committed, progress.unit)}
        </span>
        <span className="text-muted">
          {progress.remaining} {progress.unit} remaining · {progress.percent}%
        </span>
        <span className="text-muted">{cycle.tickets.length} tickets</span>
        <Badge
          tone={scope.added > 0 ? "warning" : "neutral"}
          size="sm"
          title={`Planned ${scope.planned} · added ${scope.added} · ${formatEstimate(
            scope.addedEstimate,
            progress.unit,
          )} added after the cycle started`}
        >
          {scope.added > 0
            ? `+${scope.added} added · ${Math.round(scope.ratio * 100)}% scope change`
            : "No scope change"}
        </Badge>
      </div>

      <div className="mt-2">
        <Progress
          value={progress.completed}
          max={max}
          size="sm"
          tone={cycleProgressTone(progress.percent)}
          valueText={`${cycle.name} completion: ${progress.percent}%`}
        />
      </div>

      {/* Burndown: measured remaining effort against the ideal line. */}
      <figure className="mt-3">
        <svg
          viewBox={`0 0 ${view.width} ${view.height}`}
          preserveAspectRatio="none"
          className="h-16 w-full"
          role="img"
          aria-label={`${cycle.name} ${t(locale, "burndownAria")}`}
        >
          <polyline
            className="text-muted"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.35"
            strokeWidth="0.12"
            vectorEffect="non-scaling-stroke"
            points={burndownPolyline(burndown, "ideal")}
          />
          <polyline
            className="text-action"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.2"
            vectorEffect="non-scaling-stroke"
            points={burndownPolyline(burndown, "remaining")}
          />
          {burndown.map((point, index) => {
            if (point.remaining === null) return null;
            return (
              <circle
                key={point.date}
                data-testid="burndown-point"
                className="fill-action"
                cx={index}
                cy={point.remaining}
                r={pointRadius}
              >
                <title>{burndownPointLabel(point, progress.unit)}</title>
              </circle>
            );
          })}
        </svg>
        <figcaption className="mt-1 flex items-center gap-3 text-3xs text-muted">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-px w-3 bg-action" />
            remaining
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-px w-3 bg-muted opacity-35" />
            ideal
          </span>
        </figcaption>
      </figure>

      {load.length > 0 && (
        <ul className="mt-3 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
          <li className="font-medium uppercase tracking-wide">Workload</li>
          {load.map((bucket) => (
            <li
              key={bucket.assigneeId}
              className="rounded-chip border border-border px-1.5 py-0.5"
              title={`${bucket.openCount} open · ${formatEstimate(bucket.points, bucket.unit)}`}
            >
              {loadLabel(bucket.assigneeId)}: {bucket.openCount} open ·{" "}
              {formatEstimate(bucket.points, bucket.unit)}
            </li>
          ))}
        </ul>
      )}

      {cycle.tickets.length > 0 && (
        <div className="mt-3 space-y-2">
          {byDue.map((bucket) => (
            <div key={bucket.key}>
              <h4 className="flex items-baseline gap-1.5 text-3xs font-medium uppercase tracking-wide text-muted">
                {bucket.label}
                <span className="font-normal normal-case tracking-normal">
                  {bucket.entries.length}
                </span>
              </h4>
              <ul className="mt-0.5 flex flex-wrap gap-1.5">
                {bucket.entries.map((ticket) => (
                  <li key={ticket.id}>
                    <Tag
                      hue={statusMeta(ticket.status).color}
                      size="sm"
                      title={ticket.title}
                      className="font-mono"
                    >
                      {ticket.key}
                    </Tag>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {undated > 0 && (
            <p className="text-2xs text-muted">
              {undated} ticket{undated === 1 ? "" : "s"} without a due date
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** Committed vs completed, plus a burndown chart. */
export function CyclesBoard({
  workspaceId,
  cycles,
  locale,
  loading = false,
}: {
  workspaceId: string;
  cycles: CycleRow[];
  locale: string;
  /** `loading` state: a skeleton column matching the cycle cards. */
  loading?: boolean;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CycleRow | null>(null);

  const current = activeCycle(cycles);
  const past = velocity(cycles);
  const averageVelocity =
    past.length === 0
      ? 0
      : Math.round((past.reduce((sum, row) => sum + row.completed, 0) / past.length) * 10) / 10;

  // Fold cycles into calendar sections by the month their start date lands in,
  // so the board reads chronologically ("March 2026", "April 2026", …).
  const groups = groupByBucket(cycles, { dateOf: (cycle) => cycle.startDate, unit: "month" });

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
  };

  const save = (values: Record<string, string>) =>
    run(
      () =>
        editing
          ? updateCycleAction({
              cycleId: editing.id,
              name: values.name,
              startDate: values.start,
              endDate: values.end,
              goal: values.goal || null,
            })
          : createCycleAction({
              workspaceId,
              name: values.name,
              startDate: values.start,
              endDate: values.end,
              goal: values.goal || undefined,
            }),
      {
        success: editing ? "Cycle updated" : "Cycle created",
        onSuccess: () => router.refresh(),
      },
    );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          {cycles.length} cycle{cycles.length === 1 ? "" : "s"}
        </span>
        {current && <span>Running now: {current.name}</span>}
        <span title={t(locale, "velocityHint")}>
          <TrendingUp className="mr-1 inline h-3 w-3" aria-hidden />
          {t(locale, "velocity")}: {averageVelocity} pts/cycle
        </span>
        <Button
          type="button"
          onClick={openCreate}
          className="ml-auto"
          leftIcon={<Plus className="h-4 w-4" />}
        >
          {t(locale, "newCycle")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}

      {loading ? (
        <div aria-hidden data-testid="cycles-skeleton" className="space-y-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : cycles.length === 0 ? (
        <EmptyState
          data-testid="cycles-empty"
          icon={<CalendarRange className="h-6 w-6" />}
          title="No cycles yet"
          description="A cycle is a time box — plan two weeks, commit to the estimate, then review it."
          primaryAction={
            <Button type="button" onClick={openCreate} leftIcon={<Plus className="h-4 w-4" />}>
              {t(locale, "newCycle")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label} className="space-y-3">
              <h2 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-muted">
                {group.label}
                <span className="font-normal normal-case tracking-normal">
                  {group.entries.length} cycle{group.entries.length === 1 ? "" : "s"}
                </span>
              </h2>
              <ul className="space-y-3">
                {group.entries.map((cycle) => (
                  <CycleCard
                    key={cycle.id}
                    cycle={cycle}
                    isCurrent={current?.id === cycle.id}
                    locale={locale}
                    onEdit={() => {
                      setCreating(false);
                      setEditing(cycle);
                    }}
                    onDelete={() =>
                      run(() => deleteCycleAction(cycle.id), {
                        success: "Cycle deleted",
                        onSuccess: () => router.refresh(),
                      })
                    }
                    deleting={pending}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <PromptDialog
        open={creating || editing !== null}
        locale={locale}
        title={editing ? `${t(locale, "edit")} ${editing.name}` : t(locale, "newCycle")}
        description="A cycle is a time box. Tickets you schedule into it count towards its committed estimate."
        fields={[
          { name: "name", label: "Name", defaultValue: editing?.name ?? "", placeholder: "Sprint 12" },
          {
            name: "start",
            label: "Starts",
            kind: "date",
            defaultValue: editing ? day(editing.startDate) : "",
          },
          {
            name: "end",
            label: "Ends",
            kind: "date",
            defaultValue: editing ? day(editing.endDate) : "",
          },
          {
            name: "goal",
            label: "Goal",
            hint: "optional",
            required: false,
            defaultValue: editing?.goal ?? "",
            placeholder: "Ship the ticket tracker",
          },
        ]}
        confirmLabel={editing ? "Save cycle" : "Create cycle"}
        onSubmit={save}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}
