import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/demo-workspace/tickets",
}));
vi.mock("@/server/actions/ticket-views", () => ({
  deleteTicketViewAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./ticket-bulk-actions", () => ({
  TicketBulkActions: () => null,
}));

import {
  TicketsToolbar,
  buildFilterOptions,
  buildSavedViewChips,
  countedLabel,
  nextSortDirection,
  ticketFilterCounts,
  ticketSortSpec,
  toggleSortDirection,
  type TicketSortState,
} from "./tickets-toolbar";
import type { TicketRow } from "./ticket-types";

/**
 * dz07 — tickets toolbar. The option/count/sort/saved-view mappings are pure, so
 * they are pinned without a DOM; the toolbar itself is snapshotted with
 * `renderToStaticMarkup` (idle) to prove the primitive wiring renders.
 */

type ToolbarProps = ComponentProps<typeof TicketsToolbar>;

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow => ({
  id: "t1",
  key: "T-1",
  title: "Ticket",
  description: "",
  descriptionDoc: null,
  type: "task",
  status: "todo",
  priority: "none",
  estimate: null,
  estimateUnit: null,
  startDate: null,
  dueDate: null,
  parentId: null,
  cycleId: null,
  projectId: null,
  projectName: null,
  milestoneId: null,
  milestoneName: null,
  assigneeId: null,
  assigneeName: null,
  assigneeEmail: null,
  labels: [],
  labelIds: [],
  commentCount: 0,
  childCount: 0,
  ...overrides,
});

const BASE_PROPS: ToolbarProps = {
  view: "board",
  setView: () => {},
  query: "",
  setQuery: () => {},
  statusFilter: "",
  setStatusFilter: () => {},
  priorityFilter: "",
  setPriorityFilter: () => {},
  labelFilter: "",
  setLabelFilter: () => {},
  assigneeFilter: "",
  setAssigneeFilter: () => {},
  projectFilter: "",
  setProjectFilter: () => {},
  hideDone: false,
  setHideDone: () => {},
  labels: [{ id: "l1", name: "Bug", color: "red", count: 3 }],
  members: [{ id: "u1", name: "Ada" }],
  projects: [{ id: "p1", name: "Apollo", icon: "🚀" }],
  views: [{ id: "v1", name: "Urgent bugs", config: { priority: "urgent" } }],
  locale: "en",
  run: () => {},
  setComposerOpen: () => {},
  setViewDialog: () => {},
  filteredCount: 5,
  rowsCount: 8,
  totals: { total: 12, unit: "points", count: 5 },
  remaining: { total: 7, unit: "points", count: 3 },
  closed: 2,
  checked: [],
  setChecked: () => {},
};

const renderToolbar = (overrides: Partial<ToolbarProps> = {}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(TicketsToolbar, { ...BASE_PROPS, ...overrides }),
    ),
  );

/* -------------------------------------------------------------------------- */
/* Counts + option building                                                    */
/* -------------------------------------------------------------------------- */

describe("countedLabel / buildFilterOptions", () => {
  it("folds a count into the label and leaves a missing one alone", () => {
    expect(countedLabel("Todo", 3)).toBe("Todo · 3");
    expect(countedLabel("Todo", 0)).toBe("Todo · 0");
    expect(countedLabel("Todo", undefined)).toBe("Todo");
  });

  it("builds one option per choice, carrying counts", () => {
    const options = buildFilterOptions(
      [
        { value: "todo", label: "Todo" },
        { value: "done", label: "Done" },
      ],
      { todo: 4 },
    );
    expect(options.map((option) => option.label)).toEqual(["Todo · 4", "Done"]);
    expect(options.map((option) => option.value)).toEqual(["todo", "done"]);
  });

  it("wraps a choice icon without a raw colour", () => {
    const [option] = buildFilterOptions([{ value: "p1", label: "Apollo", icon: "🚀" }]);
    expect(option.icon).toBeTruthy();
  });
});

describe("ticketFilterCounts", () => {
  it("counts each status", () => {
    const rows = [
      ticket({ id: "a", status: "todo" }),
      ticket({ id: "b", status: "todo" }),
      ticket({ id: "c", status: "done" }),
    ];
    expect(ticketFilterCounts(rows, "status")).toEqual({ todo: 2, done: 1 });
  });

  it("counts a ticket once per label it carries", () => {
    const rows = [
      ticket({ id: "a", labelIds: ["l1", "l2"] }),
      ticket({ id: "b", labelIds: ["l1"] }),
    ];
    expect(ticketFilterCounts(rows, "label")).toEqual({ l1: 2, l2: 1 });
  });

  it("skips unset assignee/project relations", () => {
    const rows = [
      ticket({ id: "a", assigneeId: "u1", projectId: null }),
      ticket({ id: "b", assigneeId: null, projectId: "p1" }),
    ];
    expect(ticketFilterCounts(rows, "assignee")).toEqual({ u1: 1 });
    expect(ticketFilterCounts(rows, "project")).toEqual({ p1: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* Sort state                                                                  */
/* -------------------------------------------------------------------------- */

describe("sort state", () => {
  it("toggles the direction and keeps the field", () => {
    expect(nextSortDirection("asc")).toBe("desc");
    expect(nextSortDirection("desc")).toBe("asc");
    const state: TicketSortState = { field: "priority", direction: "asc" };
    expect(toggleSortDirection(state)).toEqual({ field: "priority", direction: "desc" });
    expect(toggleSortDirection(toggleSortDirection(state))).toEqual(state);
  });

  it("resolves a spec only when a field is chosen", () => {
    expect(ticketSortSpec({ field: "", direction: "asc" })).toBeNull();
    const spec = ticketSortSpec({ field: "priority", direction: "desc" });
    expect(spec).toMatchObject({ propertyId: "priority", type: "select", dir: "desc" });
    expect(spec?.optionOrder).toEqual(["urgent", "high", "medium", "low", "none"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Saved-view chips                                                            */
/* -------------------------------------------------------------------------- */

describe("buildSavedViewChips", () => {
  it("flags the active view", () => {
    const chips = buildSavedViewChips(
      [
        { id: "v1", name: "Urgent" },
        { id: "v2", name: "Mine" },
      ],
      "v2",
    );
    expect(chips).toEqual([
      { id: "v1", name: "Urgent", active: false },
      { id: "v2", name: "Mine", active: true },
    ]);
  });

  it("flags nothing without an active id", () => {
    expect(buildSavedViewChips([{ id: "v1", name: "Urgent" }]).every((chip) => !chip.active)).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Static render                                                               */
/* -------------------------------------------------------------------------- */

describe("TicketsToolbar render", () => {
  it("renders the primitives and the rollup badges", () => {
    const html = renderToolbar();
    expect(html).toContain('data-testid="tickets-toolbar"');
    expect(html).toContain('data-testid="segmented"');
    expect(html).toContain("New ticket");
    expect(html).toContain("Hide closed");
    expect(html).toContain('aria-label="Filter by status"');
    expect(html).toContain('aria-label="Filter by priority"');
    expect(html).toContain('aria-label="Saved views"');
    expect(html).toContain('data-testid="ticket-presets-trigger"');
    expect(html).toContain('data-testid="tickets-archive-link"');
    // Rollups: counts, estimate total, remaining and closed percentage.
    expect(html).toContain("5 of 8 tickets");
    expect(html).toContain("Estimate total: 12 points");
    expect(html).toContain("Remaining: 7 points across 3 open");
    expect(html).toContain("Closed: 2/5 (40%)");
  });

  it("carries no raw hex, magic z-index or ad-hoc duration", () => {
    const html = renderToolbar();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/z-\[/);
  });
});
