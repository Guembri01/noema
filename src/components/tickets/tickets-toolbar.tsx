"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowUpDown,
  Bookmark,
  CalendarDays,
  Filter,
  List,
  Plus,
  Rows3,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { bulkUpdateTicketsAction } from "@/server/actions/tickets";
import { deleteTicketViewAction } from "@/server/actions/ticket-views";
import {
  applySavedView,
  deserializeSavedViews,
  parseSavedView,
  type FilterNode,
  type SavedView,
  type ViewConfigLike,
} from "@/lib/saved-views";
import { TICKET_PRIORITIES, TICKET_STATUSES, formatEstimate } from "@/lib/tickets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { LabelRow } from "./ticket-types";
import type { TicketSortField, TicketSortSpec } from "./ticket-view-renderers";

/** The three ticket layouts the toolbar switches between. */
type TicketView = "list" | "board" | "timeline";

/** The flat, in-session ticket filter set the toolbar edits and a preset captures. */
type TicketFilterState = {
  query: string;
  status: string;
  priority: string;
  labelId: string;
  assigneeId: string;
  projectId: string;
  hideClosed: boolean;
};

/**
 * Ticket presets bridge the toolbar to `@/lib/saved-views`, whose `SavedView` is
 * the storage-only, scope-tagged preset shape shared with databases
 * (`scope: "tickets"`). Nothing is persisted: presets live in this component's
 * state for the session and overlay the live config through `applySavedView`,
 * so the preset's list replaces the current one while fields it leaves unset
 * survive. A preset carries the full filter/sort/group shape; this surface owns
 * filters (one opaque node each) and the view type, so those are what it reads
 * back and writes to the toolbar's controls.
 */
const TICKET_FILTER_FIELDS = [
  "query",
  "status",
  "priority",
  "labelId",
  "assigneeId",
  "projectId",
] as const;

/**
 * Base sort spec per sortable ticket field. These reuse the list view's engine
 * type (`TicketSortSpec` from `./ticket-view-renderers`) so the toolbar and the
 * renderer agree on the field union and on how each column is compared: an
 * estimate is numeric, a due date is parsed as a date, an assignee is text, and
 * priority/status are `select` columns ranked by the domain's display order.
 * Typed as a complete record, so adding a field to `TicketSortField` fails the
 * build until it is mapped here too.
 */
const TICKET_SORT_SPECS: Record<TicketSortField, Omit<TicketSortSpec, "dir">> = {
  estimate: { propertyId: "estimate", type: "number" },
  priority: {
    propertyId: "priority",
    type: "select",
    optionOrder: TICKET_PRIORITIES.map((priority) => priority.id),
  },
  status: {
    propertyId: "status",
    type: "select",
    optionOrder: TICKET_STATUSES.map((status) => status.id),
  },
  date: { propertyId: "date", type: "date" },
  assignee: { propertyId: "assignee", type: "text" },
};

/** Field labels, one per sortable field (same exhaustiveness guarantee). */
const TICKET_SORT_LABELS: Record<TicketSortField, string> = {
  estimate: "Estimate",
  priority: "Priority",
  status: "Status",
  date: "Due date",
  assignee: "Assignee",
};

/** The sortable fields in the order the control offers them. */
const TICKET_SORT_FIELDS = Object.keys(TICKET_SORT_SPECS) as TicketSortField[];

/** Narrow a `<select>` value back to a sortable field. */
function isTicketSortField(value: string): value is TicketSortField {
  return value in TICKET_SORT_SPECS;
}

/** One `FilterNode` per active toolbar filter; inactive filters are omitted. */
function ticketFilterNodes(state: TicketFilterState): FilterNode[] {
  const nodes: FilterNode[] = [];
  for (const field of TICKET_FILTER_FIELDS) {
    const value = state[field];
    if (value) nodes.push({ field, value });
  }
  if (state.hideClosed) nodes.push({ field: "hideClosed", value: true });
  return nodes;
}

/**
 * Read a preset's filter nodes back into the toolbar's flat filter state. Every
 * field starts blank, so a preset that sets a filter replaces the whole set and
 * one that omits a field clears it.
 */
function ticketFilterState(nodes: readonly FilterNode[] | undefined): TicketFilterState {
  const state: TicketFilterState = {
    query: "",
    status: "",
    priority: "",
    labelId: "",
    assigneeId: "",
    projectId: "",
    hideClosed: false,
  };
  for (const node of nodes ?? []) {
    const field = node.field;
    const value = node.value;
    if (field === "hideClosed") {
      state.hideClosed = value === true;
    } else if (
      typeof field === "string" &&
      (TICKET_FILTER_FIELDS as readonly string[]).includes(field) &&
      typeof value === "string"
    ) {
      state[field as (typeof TICKET_FILTER_FIELDS)[number]] = value;
    }
  }
  return state;
}

/** The base config a preset overlays: the toolbar's live filters and view type. */
function ticketViewConfig(view: TicketView, state: TicketFilterState): ViewConfigLike {
  const config: ViewConfigLike = { viewType: view };
  const filter = ticketFilterNodes(state);
  if (filter.length > 0) config.filter = filter;
  return config;
}

/** Narrow a merged `viewType` back to the toolbar's view union. */
function asTicketView(viewType: string | undefined, fallback: TicketView): TicketView {
  return viewType === "list" || viewType === "board" || viewType === "timeline"
    ? viewType
    : fallback;
}

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
  onSortChange,
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
  /**
   * Optional writer for the toolbar's sort. Called with the chosen
   * `TicketSortSpec` (the list view's `{ propertyId, dir, type, ... }` shape)
   * whenever the field or direction changes, or `null` when the sort is
   * cleared. Omitted by callers that own no sort state, so the control is
   * purely additive and the existing filters/presets are untouched.
   */
  onSortChange?: (spec: TicketSortSpec | null) => void;
}) {
  // In-session named presets — saved views tagged `scope: "tickets"`. They are
  // never persisted; applying one overlays the live filters and view type.
  const [presets, setPresets] = useState<SavedView[]>([]);
  const [presetName, setPresetName] = useState("");

  // Sort field + direction. Kept locally so the control renders, and mirrored
  // into the parent's view state through the optional `onSortChange` writer.
  const [sortField, setSortField] = useState<TicketSortField | "">("");
  const [sortDirection, setSortDirection] = useState<TicketSortSpec["dir"]>("asc");

  /** Set the toolbar's sort and write it (or `null`) to the view state. */
  const changeSort = (field: TicketSortField | "", direction: TicketSortSpec["dir"]) => {
    setSortField(field);
    setSortDirection(direction);
    onSortChange?.(field === "" ? null : { ...TICKET_SORT_SPECS[field], dir: direction });
  };

  const liveFilters: TicketFilterState = {
    query,
    status: statusFilter,
    priority: priorityFilter,
    labelId: labelFilter,
    assigneeId: assigneeFilter,
    projectId: projectFilter,
    hideClosed: hideDone,
  };

  /** Overlay a preset over the live filters and view type. */
  const applyPreset = (preset: SavedView) => {
    const merged = applySavedView(ticketViewConfig(view, liveFilters), preset);
    const next = ticketFilterState(merged.filter);
    setQuery(next.query);
    setStatusFilter(next.status);
    setPriorityFilter(next.priority);
    setLabelFilter(next.labelId);
    setAssigneeFilter(next.assigneeId);
    setProjectFilter(next.projectId);
    setHideDone(next.hideClosed);
    setView(asTicketView(merged.viewType, view));
  };

  /** Capture the live filters + view type under a name (replacing a same-named one). */
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const filter = ticketFilterNodes(liveFilters);
    const preset = parseSavedView({
      name,
      scope: "tickets",
      viewType: view,
      ...(filter.length > 0 ? { filter } : {}),
    });
    if (!preset) return;
    setPresets((previous) =>
      deserializeSavedViews([
        ...previous.filter(
          (candidate) => candidate.name.trim().toLowerCase() !== name.toLowerCase(),
        ),
        preset,
      ]),
    );
    setPresetName("");
  };

  const removePreset = (id: string) =>
    setPresets((previous) => previous.filter((candidate) => candidate.id !== id));

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

        {/* Sort: field + direction, written to the view via `onSortChange`. */}
        <span className="flex items-center gap-1" data-testid="ticket-sort">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted" aria-hidden />
          <select
            value={sortField}
            aria-label="Sort tickets by"
            data-testid="ticket-sort-field"
            onChange={(event) =>
              changeSort(
                isTicketSortField(event.target.value) ? event.target.value : "",
                sortDirection,
              )
            }
            className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
          >
            <option value="">Sort</option>
            {TICKET_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {TICKET_SORT_LABELS[field]}
              </option>
            ))}
          </select>
          <select
            value={sortDirection}
            aria-label="Sort direction"
            data-testid="ticket-sort-direction"
            disabled={sortField === ""}
            onChange={(event) =>
              changeSort(sortField, event.target.value === "desc" ? "desc" : "asc")
            }
            className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none disabled:opacity-50"
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </span>

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

        {/* In-session presets — named filter/sort/group saved views for tickets,
            applied locally through `applySavedView` (nothing hits the server). */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="View presets"
              data-testid="ticket-presets-trigger"
              className={cn(
                "flex h-8 items-center gap-1 rounded border border-border px-2 text-sm hover:bg-surface-2",
                presets.length > 0 ? "text-fg" : "text-muted",
              )}
            >
              <Star className="h-3.5 w-3.5" /> Presets
              {presets.length > 0 ? ` (${presets.length})` : ""}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72" data-testid="ticket-presets-popover">
            <div className="space-y-2">
              {presets.length === 0 && (
                <p className="text-xs text-muted">No presets yet. Capture the current filters below.</p>
              )}
              {presets.map((preset) => (
                <div key={preset.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid={`apply-ticket-preset-${preset.id}`}
                    onClick={() => applyPreset(preset)}
                    className="flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-surface-2"
                  >
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t(locale, "delete")} ${preset.name}`}
                    onClick={() => removePreset(preset.id)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-1 border-t border-border pt-2">
                <input
                  value={presetName}
                  data-testid="ticket-preset-name"
                  aria-label={t(locale, "viewName")}
                  placeholder={t(locale, "viewNamePlaceholder")}
                  onChange={(event) => setPresetName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") savePreset();
                  }}
                  className="h-8 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
                />
                <button
                  type="button"
                  data-testid="save-ticket-preset"
                  disabled={presetName.trim().length === 0}
                  onClick={savePreset}
                  className="flex items-center gap-1 text-xs text-accent disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" /> {t(locale, "save")}
                </button>
              </div>
            </div>
          </PopoverContent>
        </Popover>

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
