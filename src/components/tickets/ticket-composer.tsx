"use client";

import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { Tag } from "@/components/ui/tag";
import { ESTIMATE_UNITS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from "@/lib/tickets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { LabelRow } from "./ticket-types";

/**
 * The new-ticket composer.
 *
 * One form body (`TicketComposerForm`) with a `variant` prop renders both the
 * inline board row and the dialog the toolbar opens, so the fields, validation
 * and submit path exist exactly once:
 *
 * - `variant="inline"` — the responsive grid that sits above the views;
 * - `variant="dialog"` — a single column inside a `Dialog`.
 *
 * Every control is a design-system primitive (`Field`/`Input`/`Textarea`,
 * `Select`, `Stepper`, `DatePicker`, `Tag`, `Button`), so colour, shape, motion
 * and the seven states come from tokens. The existing FormData contract is
 * preserved: the same `name`s are submitted, so the parent action is untouched.
 *
 * The pure estimate parsing and draft validation below are exported so the
 * mappings are pinned by node tests.
 */

/** Estimate nudged in half steps, matching the old `step="0.5"` field. */
export const ESTIMATE_STEP = 0.5;

/** Sensible fresh-ticket defaults (the previous native selects' first options). */
export const DEFAULT_TICKET_TYPE = TICKET_TYPES[0].id;
export const DEFAULT_TICKET_STATUS = "todo";
export const DEFAULT_TICKET_PRIORITY = "none";
export const DEFAULT_ESTIMATE_UNIT = ESTIMATE_UNITS[0];

/** The estimate field's contribution to a draft. */
export type EstimateParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * Parse an estimate input. An empty/whitespace field means "no estimate"
 * (`value: null`); a negative or non-numeric value is an error. Pure.
 */
export function parseEstimate(text: string): EstimateParse {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a number." };
  if (value < 0) return { ok: false, error: "Estimate cannot be negative." };
  return { ok: true, value };
}

/** The draft fields validation reads — the subset of `FormData` that can fail. */
export type TicketDraftFields = {
  title: string;
  estimate: string;
  startDate: string;
  dueDate: string;
};

/** One message per invalid field; an absent key means the field is valid. */
export type TicketDraftErrors = Partial<
  Record<"title" | "estimate" | "startDate" | "dueDate", string>
>;

/**
 * Validate a draft: a title is required, the estimate must parse, and a due
 * date may not precede the start date. Pure, so the rules are pinned by tests.
 */
export function validateTicketDraft(fields: TicketDraftFields): TicketDraftErrors {
  const errors: TicketDraftErrors = {};
  if (fields.title.trim() === "") errors.title = "Give the ticket a title.";
  const estimate = parseEstimate(fields.estimate);
  if (!estimate.ok) errors.estimate = estimate.error;
  if (fields.startDate !== "" && fields.dueDate !== "" && fields.dueDate < fields.startDate) {
    errors.dueDate = "Due date cannot be before the start date.";
  }
  return errors;
}

/** Read the validated fields back out of a submitted form. */
export function ticketDraftFromForm(form: FormData): TicketDraftFields {
  return {
    title: String(form.get("title") ?? ""),
    estimate: String(form.get("estimate") ?? ""),
    startDate: String(form.get("startDate") ?? ""),
    dueDate: String(form.get("dueDate") ?? ""),
  };
}

export type TicketComposerVariant = "inline" | "dialog";

export type TicketComposerProps = {
  onSubmit: (form: FormData) => void;
  pending: boolean;
  projects: { id: string; name: string; icon: string | null }[];
  members: { id: string; name: string }[];
  /** Workspace labels, offered as selectable `Tag` chips. */
  labels?: LabelRow[];
  locale: string;
  onCancel: () => void;
};

export type TicketComposerFormProps = TicketComposerProps & {
  variant?: TicketComposerVariant;
  /** Seed the validation state (uncontrolled); useful when the form reopens. */
  defaultErrors?: TicketDraftErrors;
  /** Stable id namespace (a dialog and an inline copy can coexist). */
  idPrefix?: string;
};

/** Per-variant layout tokens. Pure, so both densities are easy to reason about. */
export const COMPOSER_LAYOUT: Record<
  TicketComposerVariant,
  { form: string; wide: string; footer: string }
> = {
  inline: {
    form: "grid gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4",
    wide: "sm:col-span-2 lg:col-span-4",
    footer: "flex items-center gap-2 sm:col-span-2 lg:col-span-4",
  },
  dialog: {
    form: "grid gap-3",
    wide: "",
    footer: "flex items-center justify-end gap-2",
  },
};

const TYPE_OPTIONS: SelectOption[] = TICKET_TYPES.map((type) => ({
  value: type.id,
  label: type.label,
  icon: <span aria-hidden>{type.icon}</span>,
}));

const STATUS_OPTIONS: SelectOption[] = TICKET_STATUSES.map((status) => ({
  value: status.id,
  label: status.label,
}));

const PRIORITY_OPTIONS: SelectOption[] = TICKET_PRIORITIES.map((priority) => ({
  value: priority.id,
  label: priority.label,
}));

const UNIT_OPTIONS: SelectOption[] = ESTIMATE_UNITS.map((unit) => ({
  value: unit,
  label: unit,
}));

/** A small field caption (the selects and dates carry their own `aria-label`). */
function Caption({ children }: { children: React.ReactNode }) {
  return <span className="block text-sm font-medium text-fg">{children}</span>;
}

/**
 * Label + control + error, wrapped so the label never double-fires the control.
 * Used for the enum selects, whose errors are inline messages under the field.
 */
function ControlField({
  label,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1", className)}>
      <Caption>{label}</Caption>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The shared new-ticket body, rendered inline or inside a dialog. */
export function TicketComposerForm({
  variant = "inline",
  onSubmit,
  pending,
  projects,
  members,
  labels = [],
  locale,
  onCancel,
  defaultErrors,
  idPrefix,
}: TicketComposerFormProps) {
  const reactId = useId();
  const base = idPrefix ?? `ticket-composer-${reactId}`;
  const titleId = `${base}-title`;
  const descriptionId = `${base}-description`;
  const startId = `${base}-start`;
  const dueId = `${base}-due`;

  const layout = COMPOSER_LAYOUT[variant];

  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<TicketDraftErrors>(defaultErrors ?? {});

  const clearError = (key: keyof TicketDraftErrors) =>
    setErrors((previous) => (previous[key] ? { ...previous, [key]: undefined } : previous));

  const toggleLabel = (id: string, next: boolean) =>
    setLabelIds((ids) => (next ? [...ids, id] : ids.filter((value) => value !== id)));

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextErrors = validateTicketDraft(ticketDraftFromForm(form));
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    onSubmit(form);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      data-variant={variant}
      data-testid="ticket-composer"
      className={layout.form}
    >
      <Field
        id={titleId}
        label={t(locale, "ticketTitle")}
        error={errors.title}
        required
        className={layout.wide}
      >
        <Input
          name="title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            clearError("title");
          }}
          placeholder={t(locale, "ticketTitle")}
          disabled={pending}
          aria-label={t(locale, "ticketTitle")}
        />
      </Field>

      <Field
        id={descriptionId}
        label={t(locale, "ticketDescriptionAria")}
        className={layout.wide}
      >
        <Textarea
          name="description"
          placeholder={t(locale, "descriptionOptional")}
          rows={2}
          disabled={pending}
          aria-label={t(locale, "ticketDescriptionAria")}
        />
      </Field>

      <ControlField label={t(locale, "ticketTypeAria")}>
        <Select
          name="type"
          defaultValue={DEFAULT_TICKET_TYPE}
          options={TYPE_OPTIONS}
          disabled={pending}
          aria-label={t(locale, "ticketTypeAria")}
        />
      </ControlField>

      <ControlField label={t(locale, "ticketStatusAria")}>
        <Select
          name="status"
          defaultValue={DEFAULT_TICKET_STATUS}
          options={STATUS_OPTIONS}
          disabled={pending}
          aria-label={t(locale, "ticketStatusAria")}
        />
      </ControlField>

      <ControlField label={t(locale, "ticketPriorityAria")}>
        <Select
          name="priority"
          defaultValue={DEFAULT_TICKET_PRIORITY}
          options={PRIORITY_OPTIONS}
          disabled={pending}
          aria-label={t(locale, "ticketPriorityAria")}
        />
      </ControlField>

      <ControlField label={t(locale, "estimateWord")} error={errors.estimate}>
        <div
          role="group"
          aria-label={t(locale, "ticketEstimateAria")}
          className="flex items-start gap-2"
        >
          <Stepper
            className="flex-1"
            value={estimate ?? 0}
            onValueChange={(value) => {
              setEstimate(value);
              clearError("estimate");
            }}
            min={0}
            step={ESTIMATE_STEP}
            placeholder={t(locale, "estimateWord")}
            disabled={pending}
            invalid={Boolean(errors.estimate)}
            errorMessage={errors.estimate}
          />
          <Select
            name="estimateUnit"
            defaultValue={DEFAULT_ESTIMATE_UNIT}
            options={UNIT_OPTIONS}
            disabled={pending}
            aria-label={t(locale, "estimateUnitAria")}
            className="w-24 shrink-0"
          />
        </div>
        <input type="hidden" name="estimate" value={estimate === null ? "" : String(estimate)} />
      </ControlField>

      <ControlField label={t(locale, "startDateAria")}>
        <DatePicker
          id={startId}
          value={{ date: startDate || null }}
          onChange={(value) => {
            setStartDate(value.date ?? "");
            clearError("dueDate");
          }}
          placeholder={t(locale, "startDateAria")}
          showPresets={false}
          className={cn("w-full", pending && "pointer-events-none opacity-50")}
        />
        <input type="hidden" name="startDate" value={startDate} />
      </ControlField>

      <ControlField label={t(locale, "dueDateAria")} error={errors.dueDate}>
        <DatePicker
          id={dueId}
          value={{ date: dueDate || null }}
          onChange={(value) => {
            setDueDate(value.date ?? "");
            clearError("dueDate");
          }}
          placeholder={t(locale, "dueDateAria")}
          showPresets={false}
          className={cn("w-full", pending && "pointer-events-none opacity-50")}
        />
        <input type="hidden" name="dueDate" value={dueDate} />
      </ControlField>

      <ControlField label={t(locale, "ticketProjectAria")}>
        <Select
          name="projectId"
          defaultValue=""
          options={projects.map((project) => ({
            value: project.id,
            label: project.name,
            ...(project.icon ? { icon: <span aria-hidden>{project.icon}</span> } : {}),
          }))}
          placeholder={t(locale, "noProject")}
          disabled={pending}
          aria-label={t(locale, "ticketProjectAria")}
        />
      </ControlField>

      <ControlField label={t(locale, "ticketAssigneeAria")}>
        <Select
          name="assigneeId"
          defaultValue=""
          options={members.map((member) => ({ value: member.id, label: member.name }))}
          placeholder={t(locale, "unassigned")}
          disabled={pending}
          aria-label={t(locale, "ticketAssigneeAria")}
        />
      </ControlField>

      {labels.length > 0 ? (
        <ControlField label={t(locale, "labelsHeading")} className={layout.wide}>
          <div role="group" aria-label={t(locale, "labelsHeading")} className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <Tag
                key={label.id}
                hue={label.color}
                size="sm"
                dot
                selected={labelIds.includes(label.id)}
                disabled={pending}
                onSelectedChange={(next) => toggleLabel(label.id, next)}
              >
                {label.name}
              </Tag>
            ))}
          </div>
          {labelIds.map((id) => (
            <input key={id} type="hidden" name="labelIds" value={id} />
          ))}
        </ControlField>
      ) : null}

      <div className={layout.footer}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          {t(locale, "cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={pending}
          leftIcon={<Check className="h-4 w-4" />}
        >
          {t(locale, "createTicket")}
        </Button>
      </div>
    </form>
  );
}

/** Inline composer (the board row above the views). */
export function TicketComposer(props: TicketComposerProps) {
  return <TicketComposerForm {...props} variant="inline" />;
}

export type TicketComposerDialogProps = Omit<TicketComposerProps, "onCancel"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Dialog composer (the toolbar's primary action, when wired up). */
export function TicketComposerDialog({
  open,
  onOpenChange,
  ...composer
}: TicketComposerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={t(composer.locale, "newTicket")} className="p-5">
        <h2 className="mb-4 text-xl font-semibold tracking-[-0.01em] text-fg">
          {t(composer.locale, "newTicket")}
        </h2>
        <TicketComposerForm
          {...composer}
          variant="dialog"
          idPrefix="ticket-composer-dialog"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
