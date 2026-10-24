"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { Archive, Trash2 } from "lucide-react";
import {
  bulkArchiveTicketsAction,
  bulkDeleteTicketsAction,
  bulkUpdateTicketsAction,
  toggleTicketLabelAction,
  updateTicketAction,
} from "@/server/actions/tickets";
import { useUndoRedo } from "@/components/providers/undo-redo-provider";
import {
  bulkEffectCommand,
  bulkPatchCommand,
  planBulkChanges,
  type BulkRowChange,
} from "@/lib/undo-bulk";
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
import type { LabelRow, TicketRow } from "./ticket-types";
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

/**
 * Pure inverse planning for a batch of bulk edits: one entry per selected ticket
 * that would really change, with the patch that restores it (`before`) and the
 * patch that re-applies the edit (`after`). Rows already at the target value are
 * dropped, so "set status to the status it already has" never enters history.
 *
 * Labels are planned as add/remove *toggles*: adding is only offered for rows
 * that lack the label, removing only for rows that carry it, which keeps the
 * undo/redo path idempotent even if a collaborator already changed the row.
 */
export function bulkTicketChanges(
  rows: readonly TicketRow[],
  selectedIds: readonly string[],
  data: BulkPatch,
): BulkRowChange<BulkPatch>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const changes: BulkRowChange<BulkPatch>[] = [];

  for (const rowId of selectedIds) {
    const row = byId.get(rowId);
    if (!row) continue;
    const before: BulkPatch = {};
    const after: BulkPatch = {};

    if (data.status !== undefined && data.status !== row.status) {
      before.status = row.status;
      after.status = data.status;
    }
    if (data.priority !== undefined && data.priority !== row.priority) {
      before.priority = row.priority;
      after.priority = data.priority;
    }
    if (data.assigneeId !== undefined && data.assigneeId !== row.assigneeId) {
      before.assigneeId = row.assigneeId;
      after.assigneeId = data.assigneeId;
    }
    if (data.projectId !== undefined && data.projectId !== row.projectId) {
      before.projectId = row.projectId;
      after.projectId = data.projectId;
    }
    if (data.estimate !== undefined) {
      const currentUnit = row.estimateUnit ?? "points";
      const nextUnit = data.estimateUnit ?? currentUnit;
      if (data.estimate !== row.estimate || nextUnit !== currentUnit) {
        before.estimate = row.estimate;
        before.estimateUnit = currentUnit;
        after.estimate = data.estimate;
        after.estimateUnit = nextUnit;
      }
    }
    for (const labelId of data.addLabelIds ?? []) {
      if (row.labelIds.includes(labelId)) continue;
      after.addLabelIds = [...(after.addLabelIds ?? []), labelId];
      before.removeLabelIds = [...(before.removeLabelIds ?? []), labelId];
    }
    for (const labelId of data.removeLabelIds ?? []) {
      if (!row.labelIds.includes(labelId)) continue;
      after.removeLabelIds = [...(after.removeLabelIds ?? []), labelId];
      before.addLabelIds = [...(before.addLabelIds ?? []), labelId];
    }

    if (Object.keys(before).length > 0 || Object.keys(after).length > 0) {
      changes.push({ rowId, before, after });
    }
  }
  return changes;
}

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
  tickets = [],
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
  /**
   * The live ticket rows the selection points at. Required to plan an honest
   * inverse for property edits (the previous value is not in the `BulkPatch`);
   * omitted, archive/restore still record one reversible step.
   */
  tickets?: readonly TicketRow[];
}) {
  const router = useRouter();
  const { push: pushGlobal } = useUndoRedo();
  const [estimate, setEstimate] = useState("0");
  const [unit, setUnit] = useState<string>("points");
  const [confirm, setConfirm] = useState<BulkDestructiveAction | null>(null);
  const { run: runDestructive, pending } = useAction(locale);

  const applyTicketPatch = async (ticketId: string, patch: BulkPatch) => {
    const { addLabelIds, removeLabelIds, ...scalars } = patch;
    if (Object.keys(scalars).length > 0) {
      await updateTicketAction({ ticketId, ...scalars });
    }
    for (const labelId of addLabelIds ?? []) {
      await toggleTicketLabelAction(ticketId, labelId);
    }
    for (const labelId of removeLabelIds ?? []) {
      await toggleTicketLabelAction(ticketId, labelId);
    }
  };

  const applyUpdate = (data: BulkPatch, label: string) => {
    // Snapshot before the write lands: the inverse needs each row's old value.
    // Planning here (not after the round-trip) means the history step is built
    // from the values the user actually saw when they clicked.
    const plan = planBulkChanges(label, bulkTicketChanges(tickets, checked, data));
    const at = Date.now();
    return run(label, async () => {
      const outcome = await safeAction(() =>
        bulkUpdateTicketsAction({ ticketIds: checked, ...data }),
      );
      if (!outcome.ok) return { ok: false, message: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { ok: false, message: result.error };

      const command = bulkPatchCommand<Record<string, unknown>, BulkPatch>(
        plan,
        applyTicketPatch,
        { at, id: crypto.randomUUID() },
      );
      if (command) pushGlobal(command);
      router.refresh();
      return { ok: true };
    });
  };

  const applyEstimate = () => {
    const value = estimate.trim() === "" ? null : Number(estimate);
    if (value !== null && !Number.isFinite(value)) return;
    applyUpdate({ estimate: value, estimateUnit: unit }, "Estimate updated");
    setEstimate("0");
  };

  const doArchive = () => {
    const ids = checked.slice();
    const at = Date.now();
    const label = ids.length === 1 ? "Archive ticket" : `Archive ${ids.length} tickets`;
    runDestructive(() => bulkArchiveTicketsAction({ ticketIds: ids }), {
      success: "Tickets archived",
      onSuccess: () => {
        // One command for the whole selection: one Ctrl+Z restores every row.
        pushGlobal(
          bulkEffectCommand<Record<string, unknown>>({
            id: crypto.randomUUID(),
            label,
            rowIds: ids,
            at,
            undo: async (rowIds) => {
              await bulkArchiveTicketsAction({ ticketIds: [...rowIds], archived: false });
              router.refresh();
            },
            redo: async (rowIds) => {
              await bulkArchiveTicketsAction({ ticketIds: [...rowIds], archived: true });
              router.refresh();
            },
          }),
        );
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
          label={t(locale, "selectAll")}
          className="me-1"
        />
      ) : null}

      <Select
        aria-label={t(locale, "bulkSetStatus")}
        className="w-36"
        size="sm"
        value=""
        options={statusOptions}
        placeholder={`${t(locale, "statusWord")}…`}
        onChange={(value) => value && applyUpdate({ status: value }, "Status updated")}
      />

      <Select
        aria-label={t(locale, "bulkSetPriority")}
        className="w-36"
        size="sm"
        value=""
        options={priorityOptions}
        placeholder={`${t(locale, "priorityWord")}…`}
        onChange={(value) => value && applyUpdate({ priority: value }, "Priority updated")}
      />

      <Select
        aria-label={t(locale, "bulkSetAssignee")}
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
        aria-label={t(locale, "bulkSetProject")}
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
        aria-label={t(locale, "bulkAddLabel")}
        className="w-36"
        size="sm"
        value=""
        disabled={labels.length === 0}
        options={labelOptions}
        placeholder={t(locale, "addLabelPlaceholder")}
        onChange={(value) => value && applyUpdate({ addLabelIds: [value] }, "Label added")}
      />

      <Select
        aria-label={t(locale, "bulkRemoveLabel")}
        className="w-36"
        size="sm"
        value=""
        disabled={labels.length === 0}
        options={labelOptions}
        placeholder={t(locale, "removeLabelPlaceholder")}
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
