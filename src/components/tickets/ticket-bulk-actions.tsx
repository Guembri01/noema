"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Archive, Trash2 } from "lucide-react";
import {
  bulkArchiveTicketsAction,
  bulkDeleteTicketsAction,
  bulkUpdateTicketsAction,
  restoreTicketAction,
} from "@/server/actions/tickets";
import { ESTIMATE_UNITS, TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/tickets";
import { safeAction, useAction } from "@/lib/actions-client";
import {
  bulkArchiveConfirmLabel,
  bulkDeleteConfirmLabel,
  ticketNoun,
} from "@/lib/ticket-delete";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmTone } from "@/components/ui/confirm-dialog";
import { Select, type SelectOption } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import type { LabelRow } from "./ticket-types";
import type { RunAction } from "./tickets-toolbar";

/** The scalar patches the bulk endpoint accepts (mirrors the action input). */
type BulkPatch = {
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  projectId?: string | null;
  estimate?: number | null;
  estimateUnit?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

/** Sentinel option value meaning "clear this relation" (→ `null`). */
const CLEAR = "__clear__";

/* -------------------------------------------------------------------------- *
 * Pure mappings — property → control and bulk action → confirm copy
 * -------------------------------------------------------------------------- */

/**
 * The two destructive bulk actions, each with its own confirm surface. `tone`
 * feeds `ConfirmDialog` so a permanent delete always reads `danger` while a
 * reversible archive stays neutral.
 */
export type BulkDestructiveAction = "archive" | "delete";

export type BulkConfirmCopy = {
  tone: ConfirmTone;
  title: string;
  /** The count-aware sentence the user reads before committing. */
  description: string;
  confirmLabel: string;
};

/**
 * The copy for a destructive bulk confirmation. Pure and total, and built on
 * `@/lib/ticket-delete` so the drawer's single-ticket delete and the board's
 * bulk delete keep one source of truth for the count sentence.
 */
export function bulkConfirmCopy(
  action: BulkDestructiveAction,
  count: number,
  locale = "en",
): BulkConfirmCopy {
  if (action === "delete") {
    return {
      tone: "danger",
      title: count === 1 ? "Delete this ticket" : `Delete ${count} ${ticketNoun(count)}`,
      description: bulkDeleteConfirmLabel(count),
      confirmLabel: "Delete permanently",
    };
  }
  return {
    tone: "default",
    title: `Archive ${count} ${ticketNoun(count)}`,
    description: bulkArchiveConfirmLabel(count),
    confirmLabel: t(locale, "archiveTicket"),
  };
}

/**
 * The board/list bulk action bar. Appears only while tickets are selected and
 * covers every bulk capability the user asked for: status, priority, assignee,
 * labels (add/remove), estimate (+ unit), project, plus archive and a permanent
 * delete behind a `danger` `ConfirmDialog`.
 *
 * ds08: rebuilt on the design-system primitives — `Badge` counts, `Button`
 * variants, `Select`/`Stepper` controls, a `Switch` select-all and the shared
 * `ConfirmDialog`. No native `<select>`, no raw `red-500`/`amber-500` classes.
 */
export function TicketBulkActions({
  checked,
  setChecked,
  labels,
  members,
  projects,
  run,
  locale = "en",
  allIds,
}: {
  checked: string[];
  setChecked: Dispatch<SetStateAction<string[]>>;
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  run: RunAction;
  locale?: string;
  /**
   * Every selectable id on screen. When supplied the bar shows a "Select all"
   * `Switch`; omitted (the current toolbar wiring) leaves it out.
   */
  allIds?: string[];
}) {
  const [estimate, setEstimate] = useState("0");
  const [unit, setUnit] = useState<string>("points");
  const [confirm, setConfirm] = useState<BulkDestructiveAction | null>(null);
  const { run: runDestructive, pending } = useAction(locale);

  const applyUpdate = (data: BulkPatch, label: string) =>
    run(label, async () => {
      const outcome = await safeAction(() =>
        bulkUpdateTicketsAction({ ticketIds: checked, ...data }),
      );
      if (!outcome.ok) return { ok: false, message: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { ok: false, message: result.error };
      return { ok: true };
    });

  const applyEstimate = () => {
    const value = estimate.trim() === "" ? null : Number(estimate);
    if (value !== null && !Number.isFinite(value)) return;
    applyUpdate({ estimate: value, estimateUnit: unit }, "Estimate updated");
    setEstimate("0");
  };

  const doArchive = () => {
    const ids = checked.slice();
    runDestructive(() => bulkArchiveTicketsAction({ ticketIds: ids }), {
      success: "Tickets archived",
      undo: {
        label: t(locale, "archiveTicket"),
        undo: async () => {
          for (const id of ids) await restoreTicketAction(id);
        },
      },
      onSuccess: () => {
        setConfirm(null);
        setChecked((current) => current.filter((id) => !ids.includes(id)));
      },
    });
  };

  const doDelete = () => {
    const ids = checked.slice();
    runDestructive(() => bulkDeleteTicketsAction({ ticketIds: ids }), {
      success: "Tickets deleted",
      onSuccess: () => {
        setConfirm(null);
        setChecked((current) => current.filter((id) => !ids.includes(id)));
      },
    });
  };

  const statusOptions: SelectOption[] = TICKET_STATUSES.map((status) => ({
    value: status.id,
    label: status.label,
    tag: status.color,
  }));
  const priorityOptions: SelectOption[] = TICKET_PRIORITIES.map((priority) => ({
    value: priority.id,
    label: priority.label,
    tag: priority.color,
  }));
  const memberOptions: SelectOption[] = [
    { value: CLEAR, label: t(locale, "unassigned") },
    ...members.map((member) => ({ value: member.id, label: member.name })),
  ];
  const projectOptions: SelectOption[] = [
    { value: CLEAR, label: t(locale, "noProject") },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
  const labelOptions: SelectOption[] = labels.map((label) => ({
    value: label.id,
    label: label.name,
    tag: label.color,
  }));

  const total = allIds?.length ?? 0;
  const allSelected = total > 0 && checked.length === total;
  const copy = confirm ? bulkConfirmCopy(confirm, checked.length, locale) : null;

  return (
    <div
      data-testid="ticket-bulk-actions"
      className="animate-rise mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs"
    >
      <span className="flex items-center gap-1.5 text-fg">
        <Badge tone="accent" count={checked.length} />
        <span>{checked.length === 1 ? "ticket selected" : "tickets selected"}</span>
      </span>

      {total > 0 ? (
        <Switch
          size="sm"
          checked={allSelected}
          onCheckedChange={(on) => setChecked(on ? (allIds ?? []).slice() : [])}
          label="Select all"
          className="me-1"
        />
      ) : null}

      <Select
        aria-label="Bulk set status"
        className="w-36"
        size="sm"
        value=""
        options={statusOptions}
        placeholder={`${t(locale, "statusWord")}…`}
        onChange={(value) => value && applyUpdate({ status: value }, "Status updated")}
      />

      <Select
        aria-label="Bulk set priority"
        className="w-36"
        size="sm"
        value=""
        options={priorityOptions}
        placeholder={`${t(locale, "priorityWord")}…`}
        onChange={(value) => value && applyUpdate({ priority: value }, "Priority updated")}
      />

      <Select
        aria-label="Bulk set assignee"
        className="w-40"
        size="sm"
        value=""
        options={memberOptions}
        placeholder={`${t(locale, "assigneeWord")}…`}
        onChange={(value) =>
          value && applyUpdate({ assigneeId: value === CLEAR ? null : value }, t(locale, "assigneeUpdated"))
        }
      />

      <Select
        aria-label="Bulk set project"
        className="w-40"
        size="sm"
        value=""
        options={projectOptions}
        placeholder={`${t(locale, "projectWord")}…`}
        onChange={(value) =>
          value && applyUpdate({ projectId: value === CLEAR ? null : value }, t(locale, "projectUpdated"))
        }
      />

      <Select
        aria-label="Bulk add label"
        className="w-36"
        size="sm"
        value=""
        disabled={labels.length === 0}
        options={labelOptions}
        placeholder="Add label…"
        onChange={(value) => value && applyUpdate({ addLabelIds: [value] }, "Label added")}
      />

      <Select
        aria-label="Bulk remove label"
        className="w-36"
        size="sm"
        value=""
        disabled={labels.length === 0}
        options={labelOptions}
        placeholder="Remove label…"
        onChange={(value) => value && applyUpdate({ removeLabelIds: [value] }, "Label removed")}
      />

      <span className="flex items-center gap-1">
        <Stepper
          value={estimate.trim() === "" ? 0 : Number(estimate)}
          min={0}
          step={0.5}
          onValueChange={(value) => setEstimate(String(value))}
          className="w-28"
          inputClassName="text-xs"
        />
        <Select
          aria-label={t(locale, "estimateUnitAria")}
          className="w-24"
          size="sm"
          value={unit}
          options={ESTIMATE_UNITS.map((option) => ({ value: option, label: option }))}
          onChange={setUnit}
        />
        <Button type="button" size="sm" variant="subtle" onClick={applyEstimate}>
          {t(locale, "estimateWord")}
        </Button>
      </span>

      <Button
        type="button"
        size="sm"
        variant="secondary"
        leftIcon={<Archive className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => setConfirm("archive")}
      >
        {t(locale, "archiveTicket")}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="danger"
        tone="soft"
        leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => setConfirm("delete")}
      >
        {t(locale, "delete")}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ms-auto"
        onClick={() => setChecked([])}
      >
        Clear
      </Button>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        tone={copy?.tone ?? "default"}
        title={copy?.title ?? ""}
        description={copy?.description}
        confirmLabel={copy?.confirmLabel}
        pending={pending}
        onConfirm={confirm === "delete" ? doDelete : doArchive}
      >
        <p className="text-muted">
          {`${checked.length} ${ticketNoun(checked.length)} ${
            confirm === "delete" ? "will be removed" : "will move to the archive"
          }.`}
        </p>
      </ConfirmDialog>
    </div>
  );
}
