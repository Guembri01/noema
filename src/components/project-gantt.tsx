"use client";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type GanttMilestone = {
  id: string;
  name: string;
  status: string;
  dueDate: string | null;
};

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/**
 * Lightweight Gantt: the project spans start → due, milestones are dated
 * markers on the same axis, and "today" is pinned so progress is obvious.
 * Pure layout (no timeline dependencies), so it stays fast and printable.
 */
export function ProjectGantt({
  name,
  startDate,
  dueDate,
  milestones,
  locale,
}: {
  name: string;
  startDate: string | null;
  dueDate: string | null;
  milestones: GanttMilestone[];
  locale: string;
}) {
  const dated = milestones.filter((milestone) => milestone.dueDate);
  const today = startOfDay(new Date());

  const points: Date[] = [today];
  if (startDate) points.push(startOfDay(new Date(startDate)));
  if (dueDate) points.push(startOfDay(new Date(dueDate)));
  for (const milestone of dated) points.push(startOfDay(new Date(milestone.dueDate!)));

  const from = new Date(Math.min(...points.map((date) => date.getTime())));
  const to = new Date(Math.max(...points.map((date) => date.getTime())));
  if (to.getTime() === from.getTime()) to.setTime(to.getTime() + 7 * DAY);
  const span = Math.max(to.getTime() - from.getTime(), DAY);

  const pct = (value: string | Date) =>
    Math.min(100, Math.max(0, ((new Date(value).getTime() - from.getTime()) / span) * 100));

  const projectStart = startDate ? pct(startDate) : 0;
  const projectEnd = dueDate ? pct(dueDate) : 100;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">{t(locale, "timelineLabel")}</p>
        <p className="text-[11px] text-muted">
          {from.toLocaleDateString()} → {to.toLocaleDateString()}
        </p>
      </div>

      <div className="relative">
        {/* today marker */}
        <div
          className="absolute -top-1 bottom-0 z-10 border-l border-dashed border-accent"
          style={{ left: `${pct(today)}%` }}
          aria-hidden
        />
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs text-muted">{name}</span>
            <div className="relative h-5 flex-1 rounded bg-surface-2">
              <div
                className="absolute inset-y-0 rounded bg-accent/70"
                style={{
                  left: `${Math.min(projectStart, projectEnd)}%`,
                  width: `${Math.max(Math.abs(projectEnd - projectStart), 2)}%`,
                }}
              />
            </div>
          </div>

          {milestones.map((milestone) => {
            const position = milestone.dueDate ? pct(milestone.dueDate) : null;
            return (
              <div key={milestone.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-32 shrink-0 truncate text-xs",
                    milestone.status === "done" ? "text-muted line-through" : "text-muted",
                  )}
                >
                  {milestone.name}
                </span>
                <div className="relative h-3 flex-1">
                  <div className="absolute inset-y-1/2 h-px w-full bg-border" />
                  {position !== null ? (
                    <span
                      title={new Date(milestone.dueDate!).toLocaleDateString()}
                      className={cn(
                        "absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg",
                        milestone.status === "done"
                          ? "bg-emerald-500"
                          : milestone.status === "in_progress"
                            ? "bg-accent"
                            : "bg-muted",
                      )}
                      style={{ left: `${position}%` }}
                    />
                  ) : (
                    <span className="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] text-muted">
                      {t(locale, "noDate")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-muted">
        {t(locale, "ganttLegend")}
      </p>
    </div>
  );
}
