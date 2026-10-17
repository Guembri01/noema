import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — the board card, rendered statically. Pins the Tag/Badge/Avatar
 * treatment, the token-only hover lift and the preserved drag class contract.
 */
import { BoardCard, statusBadgeTone } from "./ticket-view-renderers";
import type { TicketRow } from "./ticket-types";

const ticket: TicketRow = {
  id: "t1",
  key: "ABC-1",
  title: "Fix the thing",
  description: "",
  descriptionDoc: null,
  type: "task",
  status: "todo",
  priority: "urgent",
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
  commentCount: 0,
  childCount: 2,
};

describe("statusBadgeTone", () => {
  it("maps ticket colours to badge tones and defaults to neutral", () => {
    expect(statusBadgeTone("red")).toBe("danger");
    expect(statusBadgeTone("green")).toBe("success");
    expect(statusBadgeTone("yellow")).toBe("warning");
    expect(statusBadgeTone("blue")).toBe("accent");
    expect(statusBadgeTone("nonsense")).toBe("neutral");
    expect(statusBadgeTone(undefined)).toBe("neutral");
  });
});

describe("BoardCard markup", () => {
  const html = renderToStaticMarkup(createElement(BoardCard, { ticket, locale: "en" }));

  it("renders the card identity", () => {
    expect(html).toContain('data-testid="ticket-board-card"');
    expect(html).toContain("ABC-1");
    expect(html).toContain("Fix the thing");
  });

  it("uses the Tag / Badge / Avatar treatment", () => {
    expect(html).toContain("tag "); // Tag (label)
    expect(html).toContain("data-tone="); // Badge (priority/estimate)
    expect(html).toContain("data-kind="); // Avatar (assignee)
  });

  it("keeps the drag class contract and the token hover lift", () => {
    expect(html).toContain("cursor-grab");
    expect(html).toContain("active:cursor-grabbing");
    expect(html).toContain("u-interactive");
    expect(html).toContain("u-surface");
    expect(html).toContain("hover:shadow-2");
    expect(html).toContain("hover:border-border-strong");
  });
});
