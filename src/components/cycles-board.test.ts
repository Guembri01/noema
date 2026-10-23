import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CycleRow } from "@/components/cycles-board";
import { burndownSeries, type Cycle } from "@/lib/cycles";

/**
 * Cycles board — the burndown series → tooltip-label/polyline mappings, the
 * days-left tone, and a static render of one cycle card (Progress + days-left
 * Badge + token-coloured burndown + ticket Tags).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/server/actions/cycles", () => ({
  createCycleAction: vi.fn(async () => ({ ok: true })),
  deleteCycleAction: vi.fn(async () => ({ ok: true })),
  updateCycleAction: vi.fn(async () => ({ ok: true })),
}));

const {
  CycleCard,
  burndownIdealLabel,
  burndownPointLabel,
  burndownPolyline,
  burndownViewBox,
  cycleProgressTone,
  daysLeftTone,
} = await import("@/components/cycles-board");

const h = createElement;

const NOW = new Date("2026-04-05T00:00:00.000Z");

const cycle: CycleRow = {
  id: "c1",
  name: "Sprint 12",
  goal: "Ship the tracker",
  startDate: "2026-04-01T00:00:00.000Z",
  endDate: "2026-04-14T00:00:00.000Z",
  tickets: [
    {
      id: "t1",
      key: "NOE-1",
      title: "First",
      status: "done",
      priority: "high",
      type: "task",
      estimate: 3,
      estimateUnit: "points",
      startDate: null,
      dueDate: "2026-04-03T00:00:00.000Z",
      completedAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
      assigneeName: "Ada",
    },
    {
      id: "t2",
      key: "NOE-2",
      title: "Second",
      status: "todo",
      priority: "low",
      type: "bug",
      estimate: 5,
      estimateUnit: "points",
      startDate: null,
      dueDate: "2026-04-10T00:00:00.000Z",
      completedAt: null,
      updatedAt: "2026-04-05T00:00:00.000Z",
      assigneeName: "Bob",
    },
  ],
};

const cycleRef: Cycle = {
  id: cycle.id,
  name: cycle.name,
  start: cycle.startDate,
  end: cycle.endDate,
};

describe("burndown series + tooltip labels", () => {
  const series = burndownSeries(cycleRef, cycle.tickets, { now: NOW });

  it("measures eight points and burns three on the completion day", () => {
    expect(series.map((point) => point.remaining)).toEqual([
      8, 8, 5, 5, 5, null, null, null, null, null, null, null, null, null,
    ]);
  });

  it("labels a measured point and an unmeasured one", () => {
    expect(burndownPointLabel(series[0], "points")).toBe("2026-04-01 · 8 points remaining");
    expect(burndownPointLabel(series[13], "points")).toBe("2026-04-14 · not measured yet");
    expect(burndownIdealLabel(series[0], "points")).toBe("2026-04-01 · ideal 8 points");
  });

  it("builds a polyline that skips unmeasured days but keeps their x", () => {
    expect(burndownPolyline(series, "remaining")).toBe("0,8 1,8 2,5 3,5 4,5");
    expect(burndownPolyline(series, "ideal")).toContain("13,0");
  });

  it("sizes the viewBox from the busiest point", () => {
    expect(burndownViewBox(series)).toEqual({ width: 13, height: 8 });
  });
});

describe("days-left + progress tones", () => {
  it("goes danger in the last day and warning in the last three", () => {
    expect(daysLeftTone(1)).toBe("danger");
    expect(daysLeftTone(0)).toBe("danger");
    expect(daysLeftTone(3)).toBe("warning");
    expect(daysLeftTone(9)).toBe("neutral");
  });

  it("reads success only when fully complete", () => {
    expect(cycleProgressTone(100)).toBe("success");
    expect(cycleProgressTone(42)).toBe("accent");
  });
});

describe("renderToStaticMarkup — cycle card", () => {
  const html = renderToStaticMarkup(
    h(CycleCard, { cycle, isCurrent: false, locale: "en", now: NOW }),
  );

  it("renders the progress bar and the days-left badge", () => {
    expect(html).toContain('data-testid="cycle-card"');
    expect(html).toContain('data-testid="cycle-days-left"');
    expect(html).toContain('role="progressbar"');
  });

  it("renders the burndown on token colours with per-point tooltips", () => {
    expect(html.match(/data-testid="burndown-point"/g)).toHaveLength(5);
    expect(html).toContain("text-action");
    expect(html).toContain("text-muted");
    expect(html).toContain("<title>2026-04-01 · 8 points remaining</title>");
  });

  it("renders ticket chips as hue tags", () => {
    expect(html).toContain("tag-blue");
    expect(html).toContain("tag-green");
    expect(html).toContain("NOE-1");
  });
});
