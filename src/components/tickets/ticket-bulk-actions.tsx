"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Archive, Trash2 } from "lucide-react";
import {
  bulkArchiveTicketsAction,
  bulkDeleteTicketsAction,
  bulkUpdateTicketsAction,
} from "@/server/actions/tickets";
import { ESTIMATE_UNITS, TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/tickets";
import { safeAction } from "@/lib/actions-client";
import { bulkArchiveConfirmLabel, bulkDeleteConfirmLabel } from "@/lib/ticket-delete";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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

const selectClass =
  "h-7 rounded border border-border bg-bg px-1.5 text-xs text-fg outline-none";
const chipButtonClass =
  "flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2";

/**
 * The board/list bulk action bar. Appears only while tickets are selected and
 * covers every bulk capability the user asked for: status, priority, assignee,
 * labels (add/remove), estimate (+ unit), project, plus archive and a permanent
 * delete that confirms exactly how many tickets it will remove.
 */
export function TicketBulkActions({
  checked,
  setChecked,
  labels,
  members,
  projects,
  run,
  locale = "en",
}: {
  checked: string[];
  setChecked: Dispatch<SetStateAction<string[]>>;
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  run: RunAction;
  locale?: string;
}) {
  const [estimate, setEstimate] = useState("");
  const [unit, setUnit] = useState<string>("points");
  const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);

  const applyUpdate = (data: BulkPatch, label: string) =>
    run(label, async () => {
      const outcome = await safeAction(() =>
        bulkUpdateTicketsAction({ ticketIds: checked, ...data }),
      );
      if (!outcome.ok) return { ok: false, message: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { ok: false, message: result.error };
      setConfirm(null);
      return { ok: true };
    });

  const applyEstimate = () => {
    const raw = estimate.trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return;
    applyUpdate({ estimate: value, estimateUnit: unit }, "Estimate updated");
    setEstimate("");
  };

  const doArchive = () =>
    run("Tickets archived", async () => {
      const outcome = await safeAction(() => bulkArchiveTicketsAction({ ticketIds: checked }));
      if (!outcome.ok) return { ok: false, message: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { ok: false, message: result.error };
      setConfirm(null);
      setChecked([]);
      return { ok: true };
    });

  const doDelete = () =>
    run("Tickets deleted", async () => {
      const outcome = await safeAction(() => bulkDeleteTicketsAction({ ticketIds: checked }));
      if (!outcome.ok) return { ok: false, message: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { ok: false, message: result.error };
      setConfirm(null);
      setChecked([]);
      return { ok: true };
    });

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs"
      data-testid="ticket-bulk-actions"
    >
      <strong className="text-fg">
        {checked.length} selected
      </strong>

      <select
        aria-label="Bulk set status"
        value=""
        className={selectClass}
        onChange={(event) => {
          const value = event.target.value;
          if (value) applyUpdate({ status: value }, "Status updated");
        }}
      >
        <option value="">{t(locale, "statusWord")}…</option>
        {TICKET_STATUSES.map((status) => (
          <option key={status.id} value={status.id}>
            {status.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Bulk set priority"
        value=""
        className={selectClass}
        onChange={(event) => {
          const value = event.target.value;
          if (value) applyUpdate({ priority: value }, "Priority updated");
        }}
      >
        <option value="">{t(locale, "priorityWord")}…</option>
        {TICKET_PRIORITIES.map((priority) => (
          <option key={priority.id} value={priority.id}>
            {priority.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Bulk set assignee"
        value=""
        className={selectClass}
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return;
          applyUpdate(
            { assigneeId: value === CLEAR ? null : value },
            t(locale, "assigneeUpdated"),
          );
        }}
      >
        <option value="">{t(locale, "assigneeWord")}…</option>
        <option value={CLEAR}>{t(locale, "unassigned")}</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Bulk set project"
        value=""
        className={selectClass}
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return;
          applyUpdate(
            { projectId: value === CLEAR ? null : value },
            t(locale, "projectUpdated"),
          );
        }}
      >
        <option value="">{t(locale, "projectWord")}…</option>
        <option value={CLEAR}>{t(locale, "noProject")}</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.icon ? `${project.icon} ` : ""}
            {project.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Bulk add label"
        value=""
        className={selectClass}
        disabled={labels.length === 0}
        onChange={(event) => {
          const value = event.target.value;
          if (value) applyUpdate({ addLabelIds: [value] }, "Label added");
        }}
      >
        <option value="">Add label…</option>
        {labels.map((label) => (
          <option key={label.id} value={label.id}>
            {label.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Bulk remove label"
        value=""
        className={selectClass}
        disabled={labels.length === 0}
        onChange={(event) => {
          const value = event.target.value;
          if (value) applyUpdate({ removeLabelIds: [value] }, "Label removed");
        }}
      >
        <option value="">Remove label…</option>
        {labels.map((label) => (
          <option key={label.id} value={label.id}>
            {label.name}
          </option>
        ))}
      </select>

      <span className="flex items-center gap-1">
        <input
          type="number"
          step="0.5"
          min="0"
          value={estimate}
          aria-label={t(locale, "ticketEstimateAria")}
          placeholder={t(locale, "estimateWord")}
          onChange={(event) => setEstimate(event.target.value)}
          className="h-7 w-20 rounded border border-border bg-bg px-1.5 text-xs outline-none focus:border-accent"
        />
        <select
          value={unit}
          aria-label={t(locale, "estimateUnitAria")}
          onChange={(event) => setUnit(event.target.value)}
          className={selectClass}
        >
          {ESTIMATE_UNITS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button type="button" className={chipButtonClass} onClick={applyEstimate}>
          {t(locale, "estimateWord")}
        </button>
      </span>

      {confirm === "archive" ? (
        <span className="flex items-center gap-2">
          <span className="text-muted">{bulkArchiveConfirmLabel(checked.length)}</span>
          <button
            type="button"
            className={cn(chipButtonClass, "border-amber-500/40 text-amber-600")}
            onClick={doArchive}
          >
            <Archive className="h-3.5 w-3.5" /> Confirm
          </button>
          <button type="button" className={chipButtonClass} onClick={() => setConfirm(null)}>
            {t(locale, "cancel")}
          </button>
        </span>
      ) : (
        <button type="button" className={chipButtonClass} onClick={() => setConfirm("archive")}>
          <Archive className="h-3.5 w-3.5" /> {t(locale, "archiveTicket")}
        </button>
      )}

      {confirm === "delete" ? (
        <span className="flex items-center gap-2">
          <span className="text-red-500">{bulkDeleteConfirmLabel(checked.length)}</span>
          <button
            type="button"
            className={cn(chipButtonClass, "border-red-500/40 text-red-500")}
            onClick={doDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete permanently
          </button>
          <button type="button" className={chipButtonClass} onClick={() => setConfirm(null)}>
            {t(locale, "cancel")}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={cn(chipButtonClass, "text-red-500")}
          onClick={() => setConfirm("delete")}
        >
          <Trash2 className="h-3.5 w-3.5" /> {t(locale, "delete")}
        </button>
      )}

      <button
        type="button"
        className={cn(chipButtonClass, "ml-auto")}
        onClick={() => setChecked([])}
      >
        Clear
      </button>
    </div>
  );
}
