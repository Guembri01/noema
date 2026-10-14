import type { Dispatch, SetStateAction } from "react";
import {
  Bookmark,
  CalendarDays,
  Filter,
  List,
  Plus,
  Rows3,
  Search,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bulkUpdateTicketsAction } from "@/server/actions/tickets";
import { deleteTicketViewAction } from "@/server/actions/ticket-views";
import { TICKET_PRIORITIES, TICKET_STATUSES, formatEstimate } from "@/lib/tickets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { LabelRow } from "./ticket-types";

/** Shared shape of the orchestrator's action runner (wraps a server action). */
export type RunAction = (
  label: string | null,
  task: () => Promise<{ ok: boolean; message?: string }>,
) => void;

/** Toolbar: view switcher, search, filters, saved views, plus the rollup bar. */
export function TicketsToolbar({
  view,
  setView,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  priorityFilter,
  setPriorityFilter,
  labelFilter,
  setLabelFilter,
  assigneeFilter,
  setAssigneeFilter,
  projectFilter,
  setProjectFilter,
  hideDone,
  setHideDone,
  labels,
  members,
  projects,
  views,
  locale,
  run,
  setComposerOpen,
  setViewDialog,
  filteredCount,
  rowsCount,
  totals,
  remaining,
  closed,
  checked,
  setChecked,
}: {
  view: "list" | "board" | "timeline";
  setView: Dispatch<SetStateAction<"list" | "board" | "timeline">>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  statusFilter: string;
  setStatusFilter: Dispatch<SetStateAction<string>>;
  priorityFilter: string;
  setPriorityFilter: Dispatch<SetStateAction<string>>;
  labelFilter: string;
  setLabelFilter: Dispatch<SetStateAction<string>>;
  assigneeFilter: string;
  setAssigneeFilter: Dispatch<SetStateAction<string>>;
  projectFilter: string;
  setProjectFilter: Dispatch<SetStateAction<string>>;
  hideDone: boolean;
  setHideDone: Dispatch<SetStateAction<boolean>>;
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  views: { id: string; name: string; config: Record<string, unknown> }[];
  locale: string;
  run: RunAction;
  setComposerOpen: Dispatch<SetStateAction<boolean>>;
  setViewDialog: Dispatch<SetStateAction<boolean>>;
  filteredCount: number;
  rowsCount: number;
  totals: { total: number; unit: string; count: number };
  remaining: { total: number; unit: string; count: number };
  closed: number;
  checked: string[];
  setChecked: Dispatch<SetStateAction<string[]>>;
}) {
  return (
    <>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {[
            { id: "list" as const, label: "List", icon: List },
            { id: "board" as const, label: "Board", icon: Rows3 },
            { id: "timeline" as const, label: "Timeline", icon: CalendarDays },
          ].map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={view === option.id}
                onClick={() => setView(option.id)}
                className={cn(
                  "flex h-8 items-center gap-1 rounded px-2 text-sm",
                  view === option.id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2",
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {option.label}
              </button>
            );
          })}
        </div>

        <span className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            value={query}
            aria-label={t(locale, "searchTickets")}
            placeholder={t(locale, "searchTickets")}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-48 rounded border border-border bg-bg pl-7 pr-2 text-sm outline-none focus:border-accent"
          />
        </span>

        <select
          value={statusFilter}
          aria-label="Filter by status"
          onChange={(event) => setStatusFilter(event.target.value)}
          className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          <option value="">Any status</option>
          {TICKET_STATUSES.map((status) => (
            <option key={status.id} value={status.id}>
              {status.label}
            </option>
          ))}
        </select>

        <select
          value={priorityFilter}
          aria-label="Filter by priority"
          onChange={(event) => setPriorityFilter(event.target.value)}
          className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority.id} value={priority.id}>
              {priority.label}
            </option>
          ))}
        </select>

        <select
          value={labelFilter}
          aria-label="Filter by label"
          onChange={(event) => setLabelFilter(event.target.value)}
          className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          <option value="">Any label</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>

        <select
          value={assigneeFilter}
          aria-label="Filter by assignee"
          onChange={(event) => setAssigneeFilter(event.target.value)}
          className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          <option value="">Anyone</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>

        <select
          value={projectFilter}
          aria-label="Filter by project"
          onChange={(event) => setProjectFilter(event.target.value)}
          className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          <option value="">Any project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.icon ?? "🚀"} {project.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input
            type="checkbox"
            checked={hideDone}
            aria-label="Hide closed tickets"
            onChange={(event) => setHideDone(event.target.checked)}
          />
          {t(locale, "hideClosed")}
        </label>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Saved views"
              className="flex h-8 items-center gap-1 rounded border border-border px-2 text-sm text-muted hover:bg-surface-2"
            >
              <Bookmark className="h-3.5 w-3.5" /> {t(locale, "savedViews")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {views.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted">No saved views yet.</p>
            )}
            {views.map((view) => (
              <div key={view.id} className="flex items-center gap-1 pr-1">
                <DropdownMenuItem
                  className="flex-1"
                  onSelect={() => {
                    const config = view.config as Record<string, unknown>;
                    setQuery(String(config.query ?? ""));
                    setStatusFilter(String(config.status ?? ""));
                    setPriorityFilter(String(config.priority ?? ""));
                    setLabelFilter(String(config.labelId ?? ""));
                    setAssigneeFilter(String(config.assigneeId ?? ""));
                    setProjectFilter(String(config.projectId ?? ""));
                    setHideDone(Boolean(config.hideClosed));
                    if (config.view === "list" || config.view === "board" || config.view === "timeline") {
                      setView(config.view);
                    }
                  }}
                >
                  {view.name}
                </DropdownMenuItem>
                <button
                  type="button"
                  aria-label={`Delete view ${view.name}`}
                  onClick={() =>
                    run("View deleted", async () => {
                      const result = await deleteTicketViewAction(view.id);

                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                  className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setViewDialog(true)}>
              <Plus className="h-4 w-4 text-muted" /> Save current filters
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={() => setComposerOpen((value) => !value)}
          className="ml-auto flex h-8 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg"
        >
          <Plus className="h-4 w-4" /> {t(locale, "newTicket")}
        </button>
      </div>

      {/* Rollups */}
      <p className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Filter className="h-3 w-3" /> {filteredCount} of {rowsCount} tickets
        </span>
        <span>
          {t(locale, "estimateTotal")}: <strong className="text-fg">{formatEstimate(totals.total, totals.unit)}</strong>
        </span>
        <span>
          {t(locale, "remaining")}: <strong className="text-fg">{formatEstimate(remaining.total, remaining.unit)}</strong>
          {remaining.count > 0 ? ` across ${remaining.count} open` : ""}
        </span>
        <span>
          Closed: {closed}/{filteredCount}
          {filteredCount > 0 ? ` (${Math.round((closed / filteredCount) * 100)}%)` : ""}
        </span>
        {checked.length > 0 && (
          <span className="flex items-center gap-2">
            <strong className="text-fg">{checked.length} selected</strong>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 hover:bg-surface-2"
              onClick={() =>
                run("Bulk update applied", async () => {
                  const result = await bulkUpdateTicketsAction({
                    ticketIds: checked,
                    priority: "high",
                  });

                  setChecked([]);
                  return "error" in result ? { ok: false, message: result.error } : { ok: true };
                })
              }
            >
              Mark high priority
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 hover:bg-surface-2"
              onClick={() =>
                run("Tickets closed", async () => {
                  const result = await bulkUpdateTicketsAction({ ticketIds: checked, status: "done" });

                  setChecked([]);
                  return "error" in result ? { ok: false, message: result.error } : { ok: true };
                })
              }
            >
              Close
            </button>
          </span>
        )}
      </p>
    </>
  );
}
