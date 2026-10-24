import { describe, expect, it, vi } from "vitest";

/**
 * UI wiring seam for recurring templates (R89.17/R31.22): the Templates menu
 * and the schedule dialog must render the same durable schedule the server
 * stores. The pure helpers are the seam; no DOM needed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/server/actions/database", () => ({
  deleteTemplateAction: vi.fn(),
  setTemplateRecurrenceAction: vi.fn(),
  setTemplatePausedAction: vi.fn(),
}));

import { templateScheduleMenuStatus } from "./database-actions";
import { scheduleTimeValue } from "./template-schedule-dialog";

describe("templateScheduleMenuStatus", () => {
  it("shows the next run for an active schedule", () => {
    const status = templateScheduleMenuStatus(
      { recurrence: "daily", nextRunAt: new Date(2026, 0, 6, 9, 0), paused: false },
      "en",
    );
    expect(status).toContain("2026");
    expect(status).not.toBe("daily");
  });

  it("shows the paused state instead of a next run", () => {
    expect(
      templateScheduleMenuStatus(
        { recurrence: "weekly", nextRunAt: new Date(2026, 0, 6, 9, 0), paused: true },
        "en",
      ),
    ).toBe("Paused");
  });

  it("renders nothing for a manual template", () => {
    expect(templateScheduleMenuStatus({ recurrence: null }, "en")).toBeNull();
  });
});

describe("scheduleTimeValue", () => {
  it("prefills the dialog from the stored next run", () => {
    const next = new Date(2026, 0, 6, 9, 5);
    expect(scheduleTimeValue(next.toISOString())).toBe("09:05");
  });

  it("falls back to 09:00 when unset or invalid", () => {
    expect(scheduleTimeValue(null)).toBe("09:00");
    expect(scheduleTimeValue("not-a-date")).toBe("09:00");
  });
});
