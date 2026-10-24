"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Play, Plus, Repeat2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Section } from "@/components/ui/section";
import { Tag } from "@/components/ui/tag";
import { safeAction, useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  ruleFromForm,
  type RecurringRuleForm,
} from "@/lib/recurring-ticket-config";
import { TICKET_PRIORITIES } from "@/lib/tickets";
import {
  deleteRecurringTicketAction,
  listRecurringTicketsAction,
  saveRecurringTicketAction,
  setRecurringTicketEnabledAction,
  type RecurringTicketListItem,
} from "@/server/actions/automations";

/**
 * The tracker's "Recurring ticket" surface (MISSING_FEATURES §20).
 *
 * It is a real entry point on the tickets page, not a server-only feature:
 * create a cadence, see the workspace's schedules, pause/resume them and delete
 * them. The recurrence maths stays in `@/lib/recurring-tickets`; the form maps
 * through `ruleFromForm` (the same validator `saveRecurringTicketAction` uses),
 * and every mutation is a workspace-gated server action.
 */

/** A schedule row the panel renders. Mirrors the action's serializable shape. */
export type RecurringScheduleRow = RecurringTicketListItem;

/** The frequencies the create form offers. */
export const RECURRING_FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
] as const;

/** The one weekday a weekly form picks. */
export const RECURRING_WEEKDAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
  { value: "sat", label: "Saturday" },
  { value: "sun", label: "Sunday" },
] as const;

/** Stable status vocabulary for the row badge. */
export type RecurringScheduleState = "active" | "paused";

export function recurringScheduleState(enabled: boolean): RecurringScheduleState {
  return enabled ? "active" : "paused";
}

/** Badge tone per state — success for active, neutral for paused. */
export function recurringScheduleTone(enabled: boolean): "success" | "neutral" {
  return enabled ? "success" : "neutral";
}

/**
 * A deterministic, locale-independent next-run label. UTC is named explicitly
 * so the value cannot be mistaken for the viewer's local time.
 */
export function nextRunLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not scheduled";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Turn label ids into the names the row shows, dropping unknown ids. */
export function labelNames(
  ids: readonly string[],
  labels: readonly { id: string; name: string }[],
): string[] {
  const byId = new Map(labels.map((label) => [label.id, label.name]));
  return ids.map((id) => byId.get(id)).filter((name): name is string => Boolean(name));
}

/** The initial values the create form holds. */
export const RECURRING_FORM_DEFAULTS: RecurringRuleForm & {
  title: string;
  projectId: string;
  priority: string;
} = {
  title: "",
  freq: "weekly",
  interval: "1",
  weekday: "mon",
  monthDay: "1",
  projectId: "",
  priority: "none",
};

/** One schedule, rendered with the design-system Card/Badge/Tag primitives. */
export function RecurringScheduleRow({
  schedule,
  labels,
  pending,
  onToggle,
  onDelete,
}: {
  schedule: RecurringScheduleRow;
  labels: readonly { id: string; name: string }[];
  pending?: boolean;
  onToggle: (schedule: RecurringScheduleRow) => void;
  onDelete: (schedule: RecurringScheduleRow) => void;
}) {
  const names = labelNames(schedule.labels, labels);
  return (
    <Card
      variant="flat"
      padding="sm"
      data-testid="recurring-schedule-row"
      data-state={recurringScheduleState(schedule.enabled)}
      className="flex flex-wrap items-center gap-2"
    >
      <CalendarClock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-40 flex-1 truncate text-sm font-medium">{schedule.title}</span>

      <Badge tone={recurringScheduleTone(schedule.enabled)} size="sm">
        {schedule.enabled ? "Active" : "Paused"}
      </Badge>

      <span className="text-xs text-muted">{schedule.summary}</span>

      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <span className="text-fg-subtle">Next:</span>
        {nextRunLabel(schedule.nextRunAt)}
      </span>

      {names.map((name) => (
        <Tag key={name} hue="gray" size="sm">
          {name}
        </Tag>
      ))}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-label={
          schedule.enabled ? `Pause ${schedule.title}` : `Resume ${schedule.title}`
        }
        leftIcon={
          schedule.enabled ? (
            <Pause className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )
        }
        onClick={() => onToggle(schedule)}
      >
        {schedule.enabled ? "Pause" : "Resume"}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={pending}
        aria-label={`Delete ${schedule.title}`}
        onClick={() => onDelete(schedule)}
        className="text-muted hover:text-danger"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </Card>
  );
}

/**
 * The panel mounted on the tracker: a disclosure button plus the create form
 * and the workspace's schedules. Schedules load the first time the panel opens
 * (and after every mutation), so the tickets page itself stays one query.
 */
export function RecurringTicketsManager({
  workspaceId,
  projects,
  labels,
  locale = "en",
}: {
  workspaceId: string;
  projects: readonly { id: string; name: string }[];
  labels: readonly { id: string; name: string }[];
  locale?: string;
}) {
  const { run, pending, error, clearError } = useAction(locale);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [schedules, setSchedules] = useState<RecurringScheduleRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecurringScheduleRow | null>(null);
  const [form, setForm] = useState({ ...RECURRING_FORM_DEFAULTS });
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);

  const load = useCallback(async () => {
    const outcome = await safeAction(() => listRecurringTicketsAction(workspaceId), {
      locale,
    });
    if (!outcome.ok) {
      setLoadError(outcome.error);
      return;
    }
    if ("error" in outcome.value) {
      setLoadError(outcome.value.error);
      return;
    }
    setLoadError(null);
    setSchedules(outcome.value.tickets);
    setLoaded(true);
  }, [workspaceId, locale]);

  useEffect(() => {
    if (!open || loaded) return;
    void load();
  }, [open, loaded, load]);

  const createSchedule = () => {
    setFormError(null);
    if (!form.title.trim()) {
      setFormError("Give the recurring ticket a title.");
      return;
    }
    const mapped = ruleFromForm({
      freq: form.freq,
      interval: form.interval,
      weekday: form.weekday,
      monthDay: form.monthDay,
    });
    if (!mapped.ok) {
      setFormError(mapped.error);
      return;
    }
    run(
      () =>
        saveRecurringTicketAction({
          workspaceId,
          title: form.title,
          projectId: form.projectId || null,
          priority: form.priority === "none" ? null : form.priority,
          labels: selectedLabels,
          rule: mapped.rule,
        }),
      {
        success: "Recurring ticket scheduled",
        onSuccess: () => {
          setForm({ ...RECURRING_FORM_DEFAULTS });
          setSelectedLabels([]);
          void load();
        },
      },
    );
  };

  const toggleSchedule = (schedule: RecurringScheduleRow) =>
    run(
      () =>
        setRecurringTicketEnabledAction({
          workspaceId,
          id: schedule.id,
          enabled: !schedule.enabled,
        }),
      {
        success: schedule.enabled ? "Schedule paused" : "Schedule resumed",
        onSuccess: () => void load(),
      },
    );

  const removeSchedule = (schedule: RecurringScheduleRow) =>
    run(() => deleteRecurringTicketAction(workspaceId, schedule.id), {
      success: "Recurring ticket deleted",
      onSuccess: () => {
        setDeleteTarget(null);
        void load();
      },
    });

  const toggleLabel = (labelId: string) =>
    setSelectedLabels((current) =>
      current.includes(labelId)
        ? current.filter((id) => id !== labelId)
        : [...current, labelId],
    );

  return (
    <Section
      className="mt-8"
      title="Recurring tickets"
      description="Create tickets on a schedule — daily, weekly, monthly or yearly."
      action={
        <Button
          type="button"
          variant={open ? "secondary" : "primary"}
          size="sm"
          aria-expanded={open}
          data-testid="recurring-tickets-toggle"
          leftIcon={<Repeat2 className="h-4 w-4" />}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide schedules" : "Manage schedules"}
        </Button>
      }
    >
      {open && (
        <>
          <Card variant="flat" padding="md">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (pending) return;
                createSchedule();
              }}
            >
              <Field id="recurring-title" label="Ticket title" className="min-w-56 flex-1">
                <Input
                  value={form.title}
                  placeholder="e.g. Weekly report"
                  onChange={(event) =>
                    setForm((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </Field>

              <Field id="recurring-freq" label="Repeats" className="w-32 shrink-0">
                <Select
                  value={form.freq}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, freq: value }))
                  }
                  options={RECURRING_FREQUENCIES.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  aria-label="How often the ticket repeats"
                />
              </Field>

              <Field id="recurring-interval" label="Every" className="w-24 shrink-0">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={form.interval}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, interval: event.target.value }))
                  }
                />
              </Field>

              {form.freq === "weekly" && (
                <Field id="recurring-weekday" label="On" className="w-36 shrink-0">
                  <Select
                    value={form.weekday ?? "mon"}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, weekday: value }))
                    }
                    options={RECURRING_WEEKDAYS.map((day) => ({
                      value: day.value,
                      label: day.label,
                    }))}
                    aria-label="Weekday the ticket repeats on"
                  />
                </Field>
              )}

              {(form.freq === "monthly" || form.freq === "yearly") && (
                <Field id="recurring-month-day" label="Day" className="w-24 shrink-0">
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={form.monthDay}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, monthDay: event.target.value }))
                    }
                  />
                </Field>
              )}

              <Field id="recurring-project" label="Project" className="w-44 shrink-0">
                <Select
                  value={form.projectId || "none"}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      projectId: value === "none" ? "" : value,
                    }))
                  }
                  options={[
                    { value: "none", label: "No project" },
                    ...projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    })),
                  ]}
                  aria-label="Project for the recurring ticket"
                />
              </Field>

              <Field id="recurring-priority" label="Priority" className="w-36 shrink-0">
                <Select
                  value={form.priority}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, priority: value }))
                  }
                  options={TICKET_PRIORITIES.map((priority) => ({
                    value: priority.id,
                    label: priority.label,
                  }))}
                  aria-label="Priority for the recurring ticket"
                />
              </Field>

              {labels.length > 0 && (
                <div
                  role="group"
                  aria-label="Labels for the recurring ticket"
                  className="flex min-w-56 flex-col gap-1.5"
                >
                  <span className="text-sm font-medium text-fg">Labels</span>
                  <div className="flex flex-wrap gap-1">
                    {labels.map((label) => {
                      const active = selectedLabels.includes(label.id);
                      return (
                        <Button
                          key={label.id}
                          type="button"
                          variant={active ? "primary" : "secondary"}
                          size="xs"
                          aria-pressed={active}
                          onClick={() => toggleLabel(label.id)}
                        >
                          {label.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}

              <Button
                type="submit"
                size="sm"
                loading={pending}
                disabled={pending || !form.title.trim()}
                leftIcon={<Plus className="h-4 w-4" />}
              >
                Schedule
              </Button>
            </form>

            {(formError || error) && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {formError ?? error}
              </p>
            )}
          </Card>

          {loadError && (
            <p role="alert" className="text-xs text-danger">
              {loadError}
            </p>
          )}

          {!loaded && !loadError ? (
            <p className="text-xs text-muted" role="status">
              Loading schedules…
            </p>
          ) : schedules.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<CalendarClock className="h-4 w-4" />}
              title="No recurring tickets yet"
              description="Schedule the first one above; it appears here with its next run."
            />
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Recurring ticket schedules">
              {schedules.map((schedule) => (
                <li key={schedule.id}>
                  <RecurringScheduleRow
                    schedule={schedule}
                    labels={labels}
                    pending={pending}
                    onToggle={(row) => {
                      clearError();
                      toggleSchedule(row);
                    }}
                    onDelete={(row) => {
                      clearError();
                      setDeleteTarget(row);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}

          <ConfirmDialog
            open={deleteTarget !== null}
            onOpenChange={(value) => {
              if (!value) setDeleteTarget(null);
            }}
            tone="danger"
            title={deleteTarget ? `Delete “${deleteTarget.title}”?` : ""}
            description="The schedule stops spawning tickets. Tickets it already created stay in the tracker."
            confirmLabel={t(locale, "delete")}
            cancelLabel={t(locale, "cancel")}
            pending={pending}
            onConfirm={() => {
              if (deleteTarget) removeSchedule(deleteTarget);
            }}
          />
        </>
      )}
    </Section>
  );
}
