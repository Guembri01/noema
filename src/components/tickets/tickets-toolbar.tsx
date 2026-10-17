"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  ArrowDown,
  ArrowUp,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { deleteTicketViewAction } from "@/server/actions/ticket-views";
import { TicketBulkActions } from "./ticket-bulk-actions";
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
import type { LabelRow, TicketRow } from "./ticket-types";
import type { TicketSortField, TicketSortSpec } from "./ticket-view-renderers";
import { TicketComposerDialog } from "./ticket-composer";

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

/** The five filter fields that surface as `Select` controls. */
export type TicketFilterKey = "status" | "priority" | "label" | "assignee" | "project";

/** Per-option counts, one map per filter field. */
export type TicketFilterCounts = Partial<
  Record<TicketFilterKey, Readonly<Record<string, number>>>
>;

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
export const TICKET_SORT_SPECS: Record<TicketSortField, Omit<TicketSortSpec, "dir">> = {
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
export const TICKET_SORT_LABELS: Record<TicketSortField, string> = {
  estimate: "Estimate",
  priority: "Priority",
  status: "Status",
  date: "Due date",
  assignee: "Assignee",
};

/** The sortable fields in the order the control offers them. */
export const TICKET_SORT_FIELDS = Object.keys(TICKET_SORT_SPECS) as TicketSortField[];

/** Narrow a string back to a sortable field. */
export function isTicketSortField(value: string): value is TicketSortField {
  return value in TICKET_SORT_SPECS;
}

/** The view switcher's options. */
const TICKET_VIEW_OPTIONS: readonly SegmentedOption<TicketView>[] = [
  { value: "list", label: "List", icon: <List className="h-3.5 w-3.5" /> },
  { value: "board", label: "Board", icon: <Rows3 className="h-3.5 w-3.5" /> },
  { value: "timeline", label: "Timeline", icon: <CalendarDays className="h-3.5 w-3.5" /> },
];

/* -------------------------------------------------------------------------- *
 * Pure mappings — option building, sort state, saved-view chips
 * -------------------------------------------------------------------------- */

/** A filter option before counts are folded in. */
export type FilterChoice = { value: string; label: string; icon?: string | null };

/**
 * Fold a count into an option label. A missing count leaves the label alone;
 * a present one (including `0`) renders as `"Label · 3"` so the count travels
 * with the option through search and the trigger alike.
 */
export function countedLabel(label: string, count: number | undefined): string {
  return count === undefined ? label : `${label} · ${count}`;
}

/** Build the `SelectOption[]` for one filter, folding per-option counts in. */
export function buildFilterOptions(
  choices: readonly FilterChoice[],
  counts?: Readonly<Record<string, number>>,
): SelectOption[] {
  return choices.map((choice) => ({
    value: choice.value,
    label: countedLabel(choice.label, counts?.[choice.value]),
    ...(choice.icon ? { icon: <span aria-hidden>{choice.icon}</span> } : {}),
  }));
}

/**
 * Count tickets per option for one filter field. Status/priority count the
 * scalar; a label counts every ticket that carries it (a ticket may carry
 * several); assignee/project skip unset values so a blank relation never grows
 * an "empty" bucket. Pure, so the counts are pinned without a DOM.
 */
export function ticketFilterCounts(
  tickets: readonly TicketRow[],
  field: TicketFilterKey,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (key: string | null) => {
    if (!key) return;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const ticket of tickets) {
    if (field === "status") bump(ticket.status);
    else if (field === "priority") bump(ticket.priority);
    else if (field === "assignee") bump(ticket.assigneeId);
    else if (field === "project") bump(ticket.projectId);
    else for (const labelId of ticket.labelIds) bump(labelId);
  }
  return counts;
}

/** The toolbar's sort control state. An empty `field` means "unsorted". */
export type TicketSortState = {
  field: TicketSortField | "";
  direction: TicketSortSpec["dir"];
};

/** Default sort state: unsorted, ascending. */
export const TICKET_SORT_DEFAULT: TicketSortState = { field: "", direction: "asc" };

/** Flip a sort direction. */
export function nextSortDirection(direction: TicketSortSpec["dir"]): TicketSortSpec["dir"] {
  return direction === "asc" ? "desc" : "asc";
}

/** Toggle the current direction, keeping the field. Pure — pinned by the test. */
export function toggleSortDirection(state: TicketSortState): TicketSortState {
  return { ...state, direction: nextSortDirection(state.direction) };
}

/**
 * Resolve a sort state to the engine's `TicketSortSpec`, or `null` when no
 * field is chosen (the caller clears the view's sort).
 */
export function ticketSortSpec(state: TicketSortState): TicketSortSpec | null {
  if (state.field === "") return null;
  return { ...TICKET_SORT_SPECS[state.field], dir: state.direction };
}

/** One saved-view chip: its identity, label, and whether it is the active one. */
export type SavedViewChip = { id: string; name: string; active: boolean };

/** Map saved views to chips, flagging the active one. Pure. */
export function buildSavedViewChips(
  views: readonly { id: string; name: string }[],
  activeId?: string | null,
): SavedViewChip[] {
  return views.map((view) => ({
    id: view.id,
    name: view.name,
    active: activeId !== undefined && activeId !== null && view.id === activeId,
  }));
}

/** Per-label counts, taken straight off the `LabelRow[]` the toolbar already holds. */
function countsFromLabels(labels: readonly LabelRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label.id] = label.count;
  return counts;
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

/**
 * The optional dialog-mounted composer. When the caller wires this up the
 * toolbar's primary action opens the design-system dialog instead of toggling
 * the inline composer row; omitting it keeps the original inline behaviour.
 */
export type TicketComposerDialogConfig = {
  onSubmit: (form: FormData) => void;
  pending?: boolean;
  labels?: LabelRow[];
};

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
  counts,
  tickets,
  composerDialog,
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
  /** Per-option counts; omitted fields simply render without a count. */
  counts?: TicketFilterCounts;
  /**
   * Optional ticket set used to derive per-option counts when `counts` is not
   * supplied. Label counts always come from `labels[].count`.
   */
  tickets?: readonly TicketRow[];
  /** Optional dialog composer; see {@link TicketComposerDialogConfig}. */
  composerDialog?: TicketComposerDialogConfig;
}) {
  // The archive view lives one segment under the board. Derive it from the
  // current pathname so the toolbar stays self-contained (no extra prop) — the
  // board is always mounted at `/w/<slug>/tickets`.
  const pathname = usePathname();
  const archiveHref = `${pathname.replace(/\/+$/, "")}/archive`;

  // In-session named presets — saved views tagged `scope: "tickets"`. They are
  // never persisted; applying one overlays the live filters and view type.
  const [presets, setPresets] = useState<SavedView[]>([]);
  const [presetName, setPresetName] = useState("");

  // Sort field + direction. Kept locally so the control renders, and mirrored
  // into the parent's view state through the optional `onSortChange` writer.
  const [sort, setSort] = useState<TicketSortState>(TICKET_SORT_DEFAULT);
  const [dialogOpen, setDialogOpen] = useState(false);

  // `/` focuses the search field, the way the hint promises (and only when the
  // user is not already typing somewhere).
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Set the toolbar's sort and write it (or `null`) to the view state. */
  const applySort = (next: TicketSortState) => {
    setSort(next);
    onSortChange?.(ticketSortSpec(next));
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

  const filterCounts = useMemo((): TicketFilterCounts => {
    const fromTickets = (field: TicketFilterKey): Record<string, number> | undefined =>
      tickets ? ticketFilterCounts(tickets, field) : undefined;
    return {
      status: counts?.status ?? fromTickets("status"),
      priority: counts?.priority ?? fromTickets("priority"),
      label: counts?.label ?? countsFromLabels(labels),
      assignee: counts?.assignee ?? fromTickets("assignee"),
      project: counts?.project ?? fromTickets("project"),
    };
  }, [counts, labels, tickets]);

  const statusOptions = useMemo(
    () =>
      buildFilterOptions(
        TICKET_STATUSES.map((status) => ({ value: status.id, label: status.label })),
        filterCounts.status,
      ),
    [filterCounts.status],
  );
  const priorityOptions = useMemo(
    () =>
      buildFilterOptions(
        TICKET_PRIORITIES.map((priority) => ({ value: priority.id, label: priority.label })),
        filterCounts.priority,
      ),
    [filterCounts.priority],
  );
  const labelOptions = useMemo(
    () =>
      buildFilterOptions(
        labels.map((label) => ({ value: label.id, label: label.name })),
        filterCounts.label,
      ),
    [filterCounts.label, labels],
  );
  const assigneeOptions = useMemo(
    () =>
      buildFilterOptions(
        members.map((member) => ({ value: member.id, label: member.name })),
        filterCounts.assignee,
      ),
    [filterCounts.assignee, members],
  );
  const projectOptions = useMemo(
    () =>
      buildFilterOptions(
        projects.map((project) => ({
          value: project.id,
          label: project.name,
          icon: project.icon,
        })),
        filterCounts.project,
      ),
    [filterCounts.project, projects],
  );
  const sortOptions = useMemo(
    (): SelectOption[] =>
      TICKET_SORT_FIELDS.map((field) => ({ value: field, label: TICKET_SORT_LABELS[field] })),
    [],
  );

  const savedViewChips = useMemo(() => buildSavedViewChips(views), [views]);
  const presetChips = useMemo(() => buildSavedViewChips(presets), [presets]);
  const closedPercent = filteredCount > 0 ? Math.round((closed / filteredCount) * 100) : 0;

  const openComposer = () => {
    if (composerDialog) setDialogOpen(true);
    else setComposerOpen((value) => !value);
  };

  return (
    <>
      {/* Toolbar */}
      {/* `gap-x-2` keeps horizontal density while `gap-y-3` gives wrapped rows
          a consistent, roomier line gap; every fixed-width control carries
          `shrink-0` so a wrapped row can never squeeze or abut its neighbour. */}
      <div
        className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-3"
        data-testid="tickets-toolbar"
      >
        <Segmented<TicketView>
          ariaLabel="Ticket layout"
          options={TICKET_VIEW_OPTIONS}
          value={view}
          onValueChange={(next) => setView(next)}
          size="sm"
        />

        {/* Entry point for the archive view — the flip side of the board's
            archive action, sitting beside the list/board/timeline switcher. */}
        <Button asChild variant="secondary" size="sm" leftIcon={<Archive className="h-3.5 w-3.5" />}>
          <Link
            href={archiveHref}
            aria-label={t(locale, "archivedTickets")}
            data-testid="tickets-archive-link"
          >
            Archive
          </Link>
        </Button>

        {/* Search: the primitive field with a clear affordance and a `/` hint. */}
        <span className="w-48 min-w-48 shrink-0">
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            clearable
            onClear={() => setQuery("")}
            size="sm"
            aria-label={t(locale, "searchTickets")}
            placeholder={t(locale, "searchTickets")}
            leading={<Search className="h-3.5 w-3.5" aria-hidden />}
            trailing={
              <span aria-hidden>
                <Kbd size="xs">/</Kbd>
              </span>
            }
            data-testid="ticket-search-input"
          />
        </span>

        {/* Filters: one searchable, clearable Select per field, with counts. */}
        <span className="w-36 min-w-36 shrink-0">
          <Select
            size="sm"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value)}
            options={statusOptions}
            placeholder={t(locale, "anyStatus")}
            aria-label={t(locale, "filterByStatus")}
          />
        </span>
        <span className="w-36 min-w-36 shrink-0">
          <Select
            size="sm"
            value={priorityFilter}
            onChange={(value) => setPriorityFilter(value)}
            options={priorityOptions}
            placeholder={t(locale, "anyPriority")}
            aria-label={t(locale, "filterByPriority")}
          />
        </span>
        <span className="w-40 min-w-40 shrink-0">
          <Select
            size="sm"
            value={labelFilter}
            onChange={(value) => setLabelFilter(value)}
            options={labelOptions}
            placeholder={t(locale, "anyLabel")}
            aria-label={t(locale, "filterByLabel")}
            disabled={labels.length === 0}
          />
        </span>
        <span className="w-40 min-w-40 shrink-0">
          <Select
            size="sm"
            value={assigneeFilter}
            onChange={(value) => setAssigneeFilter(value)}
            options={assigneeOptions}
            placeholder={t(locale, "anyone")}
            aria-label={t(locale, "filterByAssignee")}
            disabled={members.length === 0}
          />
        </span>
        <span className="w-40 min-w-40 shrink-0">
          <Select
            size="sm"
            value={projectFilter}
            onChange={(value) => setProjectFilter(value)}
            options={projectOptions}
            placeholder={t(locale, "anyProject")}
            aria-label={t(locale, "filterByProject")}
            disabled={projects.length === 0}
          />
        </span>

        <Switch
          size="sm"
          checked={hideDone}
          onCheckedChange={setHideDone}
          label={t(locale, "hideClosed")}
          aria-label={t(locale, "hideClosedTickets")}
        />

        {/* Sort: field + an asc/desc toggle, written to the view via `onSortChange`. */}
        <span className="flex min-w-max shrink-0 items-center gap-1" data-testid="ticket-sort">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted" aria-hidden />
          <span className="w-32">
            <Select
              size="sm"
              value={sort.field}
              onChange={(value) =>
                applySort({
                  field: isTicketSortField(value) ? value : "",
                  direction: sort.direction,
                })
              }
              options={sortOptions}
              placeholder={t(locale, "sort")}
              aria-label={t(locale, "sortTicketsBy")}
              menuClassName="w-40"
            />
          </span>
          <Tooltip label={sort.direction === "asc" ? "Ascending" : "Descending"}>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              data-testid="ticket-sort-direction"
              aria-label={t(locale, "sortDirection")}
              disabled={sort.field === ""}
              onClick={() => applySort(toggleSortDirection(sort))}
            >
              {sort.direction === "asc" ? (
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </Tooltip>
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              aria-label={t(locale, "savedViews")}
              leftIcon={<Bookmark className="h-3.5 w-3.5" />}
            >
              {t(locale, "savedViews")}
              <Badge size="sm" tone="neutral" count={views.length} className="ms-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {views.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted">No saved views yet.</p>
            )}
            {savedViewChips.map((chip, index) => (
              <div key={chip.id} className="flex items-center gap-1 pr-1">
                <DropdownMenuItem
                  className="flex-1"
                  data-active={chip.active ? "true" : undefined}
                  onSelect={() => {
                    const config = views[index]?.config as Record<string, unknown> | undefined;
                    if (!config) return;
                    setQuery(String(config.query ?? ""));
                    setStatusFilter(String(config.status ?? ""));
                    setPriorityFilter(String(config.priority ?? ""));
                    setLabelFilter(String(config.labelId ?? ""));
                    setAssigneeFilter(String(config.assigneeId ?? ""));
                    setProjectFilter(String(config.projectId ?? ""));
                    setHideDone(Boolean(config.hideClosed));
                    if (
                      config.view === "list" ||
                      config.view === "board" ||
                      config.view === "timeline"
                    ) {
                      setView(config.view);
                    }
                  }}
                >
                  {chip.name}
                </DropdownMenuItem>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${t(locale, "delete")} ${chip.name}`}
                  onClick={() =>
                    run("View deleted", async () => {
                      const result = await deleteTicketViewAction(chip.id);
                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              aria-label={t(locale, "viewPresets")}
              data-testid="ticket-presets-trigger"
              leftIcon={<Star className="h-3.5 w-3.5" />}
            >
              Presets
              <Badge size="sm" tone="accent" count={presets.length} className="ms-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72" data-testid="ticket-presets-popover">
            {presets.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted">
                No presets yet. Capture the current filters below.
              </p>
            )}
            {presetChips.map((chip) => {
              const preset = presets.find((candidate) => candidate.id === chip.id);
              return (
                <div key={chip.id} className="flex items-center gap-1 pr-1">
                  <DropdownMenuItem
                    className="flex-1"
                    data-testid={`apply-ticket-preset-${chip.id}`}
                    onSelect={() => preset && applyPreset(preset)}
                  >
                    {chip.name}
                  </DropdownMenuItem>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t(locale, "delete")} ${chip.name}`}
                    onClick={() => removePreset(chip.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              );
            })}
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1 p-1">
              <Input
                value={presetName}
                data-testid="ticket-preset-name"
                aria-label={t(locale, "viewName")}
                placeholder={t(locale, "viewNamePlaceholder")}
                size="sm"
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  // Keep the menu's type-ahead from swallowing the name.
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    savePreset();
                  }
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="save-ticket-preset"
                disabled={presetName.trim().length === 0}
                onClick={savePreset}
                leftIcon={<Plus className="h-3 w-3" />}
              >
                {t(locale, "save")}
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="primary"
          size="sm"
          className="ml-auto"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={openComposer}
        >
          {t(locale, "newTicket")}
        </Button>
      </div>

      {/* Rollups — one Badge per stat, separated by a hairline rail. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral" size="sm" icon={<Filter className="h-3 w-3" />}>
          {`${filteredCount} of ${rowsCount} tickets`}
        </Badge>
        <span aria-hidden className="h-4 w-px bg-border" />
        <Badge tone="neutral" size="sm">
          {`${t(locale, "estimateTotal")}: ${formatEstimate(totals.total, totals.unit)}`}
        </Badge>
        <span aria-hidden className="h-4 w-px bg-border" />
        <Badge tone="neutral" size="sm">
          {`${t(locale, "remaining")}: ${formatEstimate(remaining.total, remaining.unit)}`}
          {remaining.count > 0 ? ` across ${remaining.count} open` : ""}
        </Badge>
        <span aria-hidden className="h-4 w-px bg-border" />
        <Badge tone="neutral" size="sm">
          {`Closed: ${closed}/${filteredCount}`}
          {filteredCount > 0 ? ` (${closedPercent}%)` : ""}
        </Badge>
      </div>

      {checked.length > 0 && (
        <TicketBulkActions
          checked={checked}
          setChecked={setChecked}
          labels={labels}
          members={members}
          projects={projects}
          run={run}
          locale={locale}
        />
      )}

      {composerDialog && (
        <TicketComposerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={composerDialog.onSubmit}
          pending={composerDialog.pending ?? false}
          labels={composerDialog.labels}
          projects={projects}
          members={members}
          locale={locale}
        />
      )}
    </>
  );
}
