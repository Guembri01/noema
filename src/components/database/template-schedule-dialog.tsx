"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Pause, Play, Trash2 } from "lucide-react";
import {
  setTemplatePausedAction,
  setTemplateRecurrenceAction,
} from "@/server/actions/database";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  formatTemplateNextRun,
  isTemplateRecurrence,
} from "@/lib/template-schedule";

/** The template fields the schedule editor reads. */
export type ScheduleEditorTemplate = {
  id: string;
  name: string;
  recurrence?: string | null;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  paused?: boolean;
};

/** Local `HH:mm` from a stored ISO timestamp, else the default slot. */
export function scheduleTimeValue(nextRunAt?: string | Date | null): string {
  if (!nextRunAt) return "09:00";
  const date = nextRunAt instanceof Date ? nextRunAt : new Date(nextRunAt);
  if (!Number.isFinite(date.getTime())) return "09:00";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

const CADENCES = ["off", "daily", "weekly", "monthly"] as const;

/**
 * The user-facing schedule editor for a database row template
 * (docs/specs/templates.md R31.20/R31.22, docs/specs/database-deep.md R89.17).
 *
 * It owns the four decisions a user makes: cadence (or off), wall-clock time,
 * pause/resume and clearing the schedule. Every write goes through the same
 * `setTemplateRecurrenceAction` / `setTemplatePausedAction` the cron relies on;
 * the dialog only displays the durable `nextRunAt`/`lastRunAt` the server
 * returns, so the panel can never disagree with the scheduler.
 */
export function TemplateScheduleDialog({
  locale,
  template,
  open,
  onOpenChange,
}: {
  locale: string;
  template: ScheduleEditorTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [recurrence, setRecurrence] = useState<string>("off");
  const [time, setTime] = useState("09:00");

  useEffect(() => {
    if (!open || !template) return;
    setRecurrence(isTemplateRecurrence(template.recurrence) ? template.recurrence : "off");
    setTime(scheduleTimeValue(template.nextRunAt));
  }, [open, template]);

  if (!template) return null;

  const scheduled = recurrence !== "off";
  const nextRun = formatTemplateNextRun(template.nextRunAt, locale) ?? t(locale, "notScheduled");
  const lastRun = formatTemplateNextRun(template.lastRunAt, locale);

  const save = () => {
    startTransition(async () => {
      const [rawHour, rawMinute] = time.split(":");
      const hour = rawHour === "" ? 9 : Number(rawHour);
      const minute = rawMinute === undefined || rawMinute === "" ? 0 : Number(rawMinute);
      const outcome = await safeAction(() =>
        setTemplateRecurrenceAction(
          template.id,
          scheduled ? recurrence : null,
          scheduled ? { hour, minute } : {},
        ),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(t(locale, scheduled ? "templateScheduleSaved" : "templateScheduleCleared"));
      onOpenChange(false);
      router.refresh();
    });
  };

  const clear = () => {
    startTransition(async () => {
      const outcome = await safeAction(() => setTemplateRecurrenceAction(template.id, null));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(t(locale, "templateScheduleCleared"));
      onOpenChange(false);
      router.refresh();
    });
  };

  const togglePaused = () => {
    startTransition(async () => {
      const outcome = await safeAction(() =>
        setTemplatePausedAction(template.id, !template.paused),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(
        t(locale, template.paused ? "templateScheduleResumed" : "templateSchedulePaused"),
      );
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t(locale, "templateSchedule")}
        className="w-full max-w-md rounded-overlay border border-border bg-bg p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-surface-2">
            <CalendarClock className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {t(locale, "templateSchedule")} · {template.name}
            </h2>
            <p className="mt-1 text-xs text-muted">{t(locale, "templateScheduleHint")}</p>
          </div>
        </div>

        <label className="mt-4 block text-xs font-medium text-muted" htmlFor="template-schedule-cadence">
          {t(locale, "repeatLabel")}
        </label>
        <select
          id="template-schedule-cadence"
          data-testid="template-schedule-cadence"
          value={recurrence}
          onChange={(event) => setRecurrence(event.target.value)}
          className="focus-ring mt-1 w-full rounded-control border border-border bg-bg px-2.5 py-1.5 text-sm"
        >
          {CADENCES.map((cadence) => (
            <option key={cadence} value={cadence}>
              {cadence === "off" ? t(locale, "offWord") : cadence}
            </option>
          ))}
        </select>

        {scheduled && (
          <label className="mt-3 block text-xs font-medium text-muted" htmlFor="template-schedule-time">
            {t(locale, "templateScheduleTime")}
            <input
              id="template-schedule-time"
              data-testid="template-schedule-time"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="focus-ring mt-1 block w-full rounded-control border border-border bg-bg px-2.5 py-1.5 text-sm"
            />
          </label>
        )}

        <dl className="mt-4 space-y-1 rounded-control bg-surface-2 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{t(locale, "templateNextRun")}</dt>
            <dd data-testid="template-schedule-next-run">
              {nextRun}
              {template.paused ? ` · ${t(locale, "templatePaused")}` : ""}
            </dd>
          </div>
          {lastRun && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">{t(locale, "templateLastRun")}</dt>
              <dd>{lastRun}</dd>
            </div>
          )}
        </dl>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {template.recurrence && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="template-schedule-pause"
              disabled={pending}
              onClick={togglePaused}
              leftIcon={
                template.paused ? (
                  <Play className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Pause className="h-3.5 w-3.5" aria-hidden />
                )
              }
            >
              {t(locale, template.paused ? "templateResumeSchedule" : "templatePauseSchedule")}
            </Button>
          )}
          {template.recurrence && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="template-schedule-clear"
              disabled={pending}
              onClick={clear}
              leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            >
              {t(locale, "offWord")}
            </Button>
          )}
          <Button
            type="button"
            variant="subtle"
            size="sm"
            data-testid="template-schedule-save"
            disabled={pending}
            onClick={save}
          >
            {t(locale, "save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
