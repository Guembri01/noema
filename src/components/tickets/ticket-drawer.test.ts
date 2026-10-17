import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — the ticket drawer.
 *
 * Node tests for the pure mappings (property row → control, activity grouping)
 * plus a `renderToStaticMarkup` pass over the sectioned drawer body: the four
 * sections, the design-system controls, and the grouped activity trail.
 */

vi.mock("@/server/actions/tickets", () => ({
  addTicketCommentAction: vi.fn(),
  archiveTicketAction: vi.fn(),
  deleteTicketAction: vi.fn(),
  linkTicketsAction: vi.fn(),
  restoreTicketAction: vi.fn(),
  toggleTicketLabelAction: vi.fn(),
}));
vi.mock("@/server/actions/cycles", () => ({ assignTicketToCycleAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import {
  PROPERTY_CONTROL,
  TicketDrawerBody,
  groupActivity,
  propertyControl,
  type TicketActivityRow,
  type TicketPropertyField,
} from "./ticket-drawer";
import type { TicketRow } from "./ticket-types";
import { TooltipProvider } from "@/components/ui/tooltip";

const noop = () => {};

const ticket: TicketRow = {
  id: "t1",
  key: "ABC-1",
  title: "Fix the thing",
  description: "A described problem.",
  descriptionDoc: null,
  type: "task",
  status: "todo",
  priority: "high",
  estimate: 3,
  estimateUnit: "points",
  startDate: null,
  dueDate: null,
  parentId: null,
  cycleId: null,
  projectId: null,
  projectName: null,
  milestoneId: null,
  milestoneName: null,
  assigneeId: "u1",
  assigneeName: "Ada Lovelace",
  assigneeEmail: null,
  labels: [{ id: "l1", name: "bug", color: "red" }],
  labelIds: ["l1"],
  commentCount: 2,
  childCount: 0,
};

const day = (d: number, h = 9) => new Date(2026, 4, d, h, 0, 0);

const activity: TicketActivityRow[] = [
  { id: "a", kind: "status_changed", detail: { to: "done" }, createdAt: day(10, 9), actor: { id: "u1", name: "Ada" } },
  { id: "b", kind: "comment_added", detail: null, createdAt: day(10, 8), actor: null },
  { id: "c", kind: "label_added", detail: { label: "bug" }, createdAt: day(9, 8), actor: null },
];

// The SSR pass groups against the real clock, so keep the fixture recent and
// assert on structure rather than the Today/Yesterday labels (pinned above).
const liveActivity: TicketActivityRow[] = [
  { id: "a", kind: "status_changed", detail: { to: "done" }, createdAt: new Date(Date.now() - 60_000), actor: { id: "u1", name: "Ada" } },
  { id: "b", kind: "comment_added", detail: null, createdAt: new Date(Date.now() - 120_000), actor: null },
];

const renderBody = () =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(TicketDrawerBody, {
        ticket,
        labels: [{ id: "l1", name: "bug", color: "red", count: 1 }],
        members: [{ id: "u1", name: "Ada Lovelace" }],
        projects: [],
        allTickets: [ticket],
        activity: liveActivity,
        cycles: [],
        slug: "workspace",
        locale: "en",
        onPatch: noop,
        onOpen: noop,
        onAddChild: noop,
        onCycleChange: noop,
        onToggleLabel: noop,
        onLinkTicket: noop,
        onAddComment: noop,
      }),
    ),
  );

describe("property row → control", () => {
  it("is total over every property field", () => {
    const fields: TicketPropertyField[] = [
      "status",
      "priority",
      "assignee",
      "project",
      "milestone",
      "cycle",
      "estimate",
      "startDate",
      "dueDate",
      "labels",
    ];
    expect(Object.keys(PROPERTY_CONTROL).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(["select", "date", "stepper", "tags"]).toContain(propertyControl(field));
    }
  });

  it("maps each property to its sanctioned primitive", () => {
    expect(propertyControl("status")).toBe("select");
    expect(propertyControl("priority")).toBe("select");
    expect(propertyControl("assignee")).toBe("select");
    expect(propertyControl("project")).toBe("select");
    expect(propertyControl("milestone")).toBe("select");
    expect(propertyControl("cycle")).toBe("select");
    expect(propertyControl("estimate")).toBe("stepper");
    expect(propertyControl("startDate")).toBe("date");
    expect(propertyControl("dueDate")).toBe("date");
    expect(propertyControl("labels")).toBe("tags");
  });
});

describe("groupActivity", () => {
  it("groups by calendar day, newest first, keeping entry order", () => {
    const groups = groupActivity(activity, day(10, 12));
    expect(groups.map((group) => group.key)).toEqual(["2026-05-10", "2026-05-09"]);
    expect(groups[0].label).toBe("Today");
    expect(groups[1].label).toBe("Yesterday");
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("falls back to a date label for older days and `Unknown` for junk dates", () => {
    const entries: TicketActivityRow[] = [
      { id: "old", kind: "created", detail: null, createdAt: day(1), actor: null },
      { id: "junk", kind: "created", detail: null, createdAt: "not-a-date", actor: null },
    ];
    const groups = groupActivity(entries, day(10, 12));
    expect(groups.map((group) => group.key)).toEqual(["2026-05-01", "unknown"]);
    expect(groups[1].label).toBe("Unknown");
    expect(groups[0].label).not.toBe("Today");
  });

  it("returns nothing for an empty trail", () => {
    expect(groupActivity([], day(10, 12))).toEqual([]);
  });
});

describe("TicketDrawerBody markup", () => {
  it("renders the four sections", () => {
    const html = renderBody();
    expect(html).toContain("Properties");
    expect(html).toContain("Description");
    expect(html).toContain("Comments");
    expect(html).toContain("Activity");
  });

  it("renders the design-system controls for the property rows", () => {
    const html = renderBody();
    expect(html).toContain('data-testid="select-trigger"'); // Select
    expect(html).toContain('data-testid="stepper"'); // Stepper
    expect(html).toContain('data-testid="date-picker-trigger"'); // DatePicker
    expect(html).toContain('class="tag'); // Tag (label)
  });

  it("renders the grouped activity trail with muted timestamps", () => {
    const html = renderBody();
    expect(html).toContain('data-testid="ticket-activity"');
    expect(html).toContain("Status changed");
    expect(html).toContain("<time");
    expect(html).toContain("text-muted");
    // the indent guide for each day group
    expect(html).toContain("border-s border-border");
  });
});
