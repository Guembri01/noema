import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * The tracker's recurring-ticket surface.
 *
 * Pure mappings are pinned directly; the real `RecurringScheduleRow` is
 * rendered with `react-dom/server` (no DOM needed) so the create/list/pause/
 * resume/delete affordances are proven in markup. A source assertion keeps the
 * panel mounted on the tickets surface — the feature is not server-only.
 */

vi.mock("@/server/actions/automations", () => ({
  listRecurringTicketsAction: vi.fn(),
  saveRecurringTicketAction: vi.fn(),
  deleteRecurringTicketAction: vi.fn(),
  setRecurringTicketEnabledAction: vi.fn(),
}));

import {
  RecurringScheduleRow,
  labelNames,
  nextRunLabel,
  recurringScheduleState,
  recurringScheduleTone,
  type RecurringScheduleRow as Schedule,
} from "./recurring-tickets-manager";

const schedule: Schedule = {
  id: "recur-1",
  templateId: "tmpl-1",
  title: "Weekly report",
  projectId: null,
  priority: "medium",
  labels: ["l1"],
  enabled: true,
  summary: "Every 2 weeks on Tue, Thu",
  rule: { freq: "weekly", interval: 2, byWeekday: ["tue", "thu"] },
  lastRunAt: "2026-01-01T12:00:00.000Z",
  nextRunAt: "2026-01-06T00:00:00.000Z",
};

const render = (overrides: Partial<Parameters<typeof RecurringScheduleRow>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RecurringScheduleRow, {
      schedule,
      labels: [{ id: "l1", name: "reporting" }],
      onToggle: () => {},
      onDelete: () => {},
      ...overrides,
    }),
  );

describe("pure mappings", () => {
  it("maps enabled to the active/paused state and badge tone", () => {
    expect(recurringScheduleState(true)).toBe("active");
    expect(recurringScheduleState(false)).toBe("paused");
    expect(recurringScheduleTone(true)).toBe("success");
    expect(recurringScheduleTone(false)).toBe("neutral");
  });

  it("renders a deterministic UTC next-run label", () => {
    expect(nextRunLabel("2026-01-06T00:00:00.000Z")).toBe("2026-01-06 00:00 UTC");
    expect(nextRunLabel(null)).toBe("Not scheduled");
    expect(nextRunLabel("not-a-date")).toBe("Not scheduled");
  });

  it("resolves label names and drops unknown ids", () => {
    expect(
      labelNames(["l1", "missing"], [
        { id: "l1", name: "reporting" },
        { id: "l2", name: "ops" },
      ]),
    ).toEqual(["reporting"]);
  });
});

describe("RecurringScheduleRow", () => {
  it("renders the schedule, its cadence, next run, labels and controls", () => {
    const html = render();

    expect(html).toContain('data-testid="recurring-schedule-row"');
    expect(html).toContain('data-state="active"');
    expect(html).toContain("Weekly report");
    expect(html).toContain("Active");
    expect(html).toContain("Every 2 weeks on Tue, Thu");
    expect(html).toContain("2026-01-06 00:00 UTC");
    expect(html).toContain("reporting");
    expect(html).toContain('aria-label="Pause Weekly report"');
    expect(html).toContain('aria-label="Delete Weekly report"');
  });

  it("offers Resume and says Not scheduled for a paused row", () => {
    const html = render({
      schedule: { ...schedule, enabled: false, nextRunAt: null },
    });

    expect(html).toContain('data-state="paused"');
    expect(html).toContain("Paused");
    expect(html).toContain("Not scheduled");
    expect(html).toContain('aria-label="Resume Weekly report"');
  });
});

describe("tracker wiring", () => {
  it("mounts the recurring-ticket panel on the tickets surface", () => {
    const source = readFileSync(
      new URL("./tickets-workspace.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "@/components/recurring-tickets-manager"');
    expect(source).toContain("<RecurringTicketsManager");
  });
});
