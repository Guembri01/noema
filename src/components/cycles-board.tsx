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
import { formatEstimate, UNASSIGNED_BUCKET, workloadByAssignee } from "@/lib/tickets";
import { LocalTime } from "@/components/local-time";
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

/** Committed vs completed, plus a burndown sparkline. */
export function CyclesBoard({
  workspaceId,
  cycles,
  locale,
}: {
  workspaceId: string;
  cycles: CycleRow[];
  locale: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CycleRow | null>(null);

  const current = activeCycle(cycles);
  const past = velocity(cycles);
  const averageVelocity =
    past.length === 0 ? 0 : Math.round((past.reduce((sum, row) => sum + row.completed, 0) / past.length) * 10) / 10;

  // Fold cycles into calendar sections by the month their start date lands in,
  // so the board reads chronologically ("March 2026", "April 2026", …).
  const groups = groupByBucket(cycles, { dateOf: (cycle) => cycle.startDate, unit: "month" });

  const renderCycle = (cycle: CycleRow) => {
    const progress = cycleProgress(cycle.tickets, cycle);
    const isCurrent = current?.id === cycle.id;
    const max = Math.max(progress.committed, 1);
    // The pure burndown/scope helpers read the stored `start`/`end`
    // shape, so map the row's `startDate`/`endDate` onto it.
    const cycleRef: Cycle = {
      id: cycle.id,
      name: cycle.name,
      start: cycle.startDate,
      end: cycle.endDate,
    };
    const burndown = burndownSeries(cycleRef, cycle.tickets);
    const scope = scopeChange(cycle.tickets, cycleRef);
    // Per-person load inside this cycle's window; the page only ships
    // the assignee name, so fall back to it when there is no id.
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
    return (
      <li
        key={cycle.id}
        className={cn(
          "rounded-xl border p-4",
          isCurrent ? "border-accent/40" : "border-border",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">{cycle.name}</h3>
          {isCurrent && (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              running
            </span>
          )}
          <span className="text-xs text-muted">
            <LocalTime value={cycle.startDate} mode="date" /> →{" "}
            <LocalTime value={cycle.endDate} mode="date" /> · {cycleDays(cycle)} days ·{" "}
            {progress.daysLeft} left
          </span>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label={`Edit ${cycle.name}`}
              onClick={() => {
                setCreating(false);
                setEditing(cycle);
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${cycle.name}`}
              disabled={pending}
              onClick={() =>
                run(() => deleteCycleAction(cycle.id), {
                  success: "Cycle deleted",
                  onSuccess: () => router.refresh(),
                })
              }
              className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500"
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
          <span
            className={cn(
              "rounded border px-1.5 py-0.5",
              scope.added > 0
                ? "border-amber-500/40 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
                : "border-border text-muted",
            )}
            title={`Planned ${scope.planned} · added ${scope.added} · ${formatEstimate(
              scope.addedEstimate,
              progress.unit,
            )} added after the cycle started`}
          >
            {scope.added > 0
              ? `+${scope.added} added · ${Math.round(scope.ratio * 100)}% scope change`
              : "No scope change"}
          </span>
        </div>

        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${cycle.name} completion: ${progress.percent}%`}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${progress.percent}%` }}
          />
        </div>

        {/* Burndown: measured remaining effort against the ideal line. */}
        <figure className="mt-3">
          <svg
            viewBox={`0 0 ${Math.max(burndown.length - 1, 1)} ${max}`}
            preserveAspectRatio="none"
            className="h-16 w-full text-fg"
            role="img"
            aria-label={`${cycle.name} burndown: remaining vs ideal`}
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeWidth="0.12"
              points={burndown.map((point, index) => `${index},${point.ideal}`).join(" ")}
            />
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="0.2"
              points={burndown
                .map((point, index) =>
                  point.remaining === null ? null : `${index},${point.remaining}`,
                )
                .filter((value): value is string => value !== null)
                .join(" ")}
            />
          </svg>
          <figcaption className="mt-1 flex items-center gap-3 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-px w-3 bg-current" />
              remaining
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-px w-3 bg-current opacity-25" />
              ideal
            </span>
          </figcaption>
        </figure>

        {load.length > 0 && (
          <ul className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <li className="font-medium uppercase tracking-wide">Workload</li>
            {load.map((bucket) => (
              <li
                key={bucket.assigneeId}
                className="rounded border border-border px-1.5 py-0.5"
                title={`${bucket.openCount} open · ${formatEstimate(bucket.points, bucket.unit)}`}
              >
                {loadLabel(bucket.assigneeId)}: {bucket.openCount} open ·{" "}
                {formatEstimate(bucket.points, bucket.unit)}
              </li>
            ))}
          </ul>
        )}

        {cycle.tickets.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {cycle.tickets.slice(0, 8).map((ticket) => (
              <li
                key={ticket.id}
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted"
                title={ticket.title}
              >
                <span className="font-mono">{ticket.key}</span>{" "}
                {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
              </li>
            ))}
            {cycle.tickets.length > 8 && (
              <li className="text-[11px] text-muted">+{cycle.tickets.length - 8} more</li>
            )}
          </ul>
        )}
      </li>
    );
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
        <span title="Average completed points in the last six finished cycles">
          <TrendingUp className="mr-1 inline h-3 w-3" aria-hidden />
          {t(locale, "velocity")}: {averageVelocity} pts/cycle
        </span>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
          className="ml-auto flex h-8 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg"
        >
          <Plus className="h-4 w-4" /> {t(locale, "newCycle")}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {cycles.length === 0 ? (
        <div className="notion-empty rounded-xl border border-dashed border-border">
          <span className="notion-empty-icon">
            <CalendarRange className="h-5 w-5" aria-hidden />
          </span>
          <p>No cycles yet.</p>
          <p className="text-xs">A cycle is a time box — plan two weeks, commit to the estimate, then review it.</p>
        </div>
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
              <ul className="space-y-3">{group.entries.map(renderCycle)}</ul>
            </section>
          ))}
        </div>
      )}

      <PromptDialog
        open={creating || editing !== null}
        locale={locale}
        title={editing ? `Edit ${editing.name}` : "New cycle"}
        description="A cycle is a time box. Tickets you schedule into it count towards its committed estimate."
        fields={[
          { name: "name", label: "Name", defaultValue: editing?.name ?? "", placeholder: "Sprint 12" },
          {
            name: "start",
            label: "Starts",
            defaultValue: editing ? day(editing.startDate) : "",
            placeholder: "2026-04-01",
          },
          {
            name: "end",
            label: "Ends",
            defaultValue: editing ? day(editing.endDate) : "",
            placeholder: "2026-04-14",
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
