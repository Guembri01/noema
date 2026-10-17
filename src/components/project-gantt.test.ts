import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";

// A rendered chart calls `useRouter().refresh()` after it persists a drag; there
// is no app-router context under `renderToStaticMarkup`, so the hook is stubbed.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import {
  GANTT_MAX_STAGGER_STEPS,
  GANTT_RUNWAY_MIN_DAYS,
  GANTT_STAGGER_MS,
  GANTT_TONE_CLASS,
  buildGanttAxis,
  ganttBarGeometry,
  ganttStagger,
  ganttStatusTone,
  milestoneMarkers,
  padGanttAxis,
  percentAlong,
  type GanttMilestone,
} from "@/components/project-gantt";
import { daysBetween, shiftDays } from "@/lib/gantt-schedule";

/**
 * Gantt — the pure axis/bar/marker geometry and stagger maths, plus a static
 * render of a chart with two milestone bars (Radix tooltips need a provider, so
 * the render is wrapped in one exactly like the app layout does).
 */

const { ProjectGantt } = await import("@/components/project-gantt");

const h = createElement;

const NOW = new Date("2026-04-10T00:00:00");
const START = "2026-04-01T00:00:00";
const DUE = "2026-04-20T00:00:00";

describe("gantt axis", () => {
  it("spans every supplied date plus today", () => {
    const axis = buildGanttAxis([START, DUE], NOW);
    expect(percentAlong(axis, START)).toBe(0);
    expect(percentAlong(axis, DUE)).toBe(100);
    expect(axis.from).toBeLessThan(axis.to);
  });

  it("widens a single-point range to a week and floors the span at a day", () => {
    const axis = buildGanttAxis([], NOW);
    expect(axis.to - axis.from).toBe(7 * 24 * 60 * 60 * 1000);
    expect(axis.span).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("ignores blank and unparseable dates", () => {
    const axis = buildGanttAxis([null, "nope", START], NOW);
    expect(percentAlong(axis, START)).toBe(0);
  });
});

describe("gantt runway", () => {
  it("gives a fitted axis room to drag outward on both sides", () => {
    const fitted = buildGanttAxis([START, DUE], NOW);
    const axis = padGanttAxis(fitted);

    expect(daysBetween(axis.from, fitted.from)).toBeGreaterThanOrEqual(GANTT_RUNWAY_MIN_DAYS);
    expect(daysBetween(fitted.to, axis.to)).toBeGreaterThanOrEqual(GANTT_RUNWAY_MIN_DAYS);
    // The data no longer touches the edges, which is what lets a bar move.
    expect(percentAlong(axis, START)).toBeGreaterThan(0);
    expect(percentAlong(axis, DUE)).toBeLessThan(100);
    expect(percentAlong(axis, START)).toBeLessThan(percentAlong(axis, DUE));
  });

  it("scales the runway with a long span", () => {
    const long = buildGanttAxis([START, new Date(2027, 3, 20).toISOString()], NOW);
    const padded = padGanttAxis(long);
    expect(daysBetween(padded.from, long.from)).toBeGreaterThan(GANTT_RUNWAY_MIN_DAYS);
  });

  it("keeps a unit span drawable", () => {
    const axis = padGanttAxis({ from: 0, to: 0, span: 0 }, 0);
    expect(axis.span).toBeGreaterThan(0);
  });
});

describe("gantt bar geometry", () => {
  const axis = buildGanttAxis([START, DUE], NOW);

  it("computes left/width from start → end percentages", () => {
    const span = ganttBarGeometry(axis, START, DUE);
    expect(span.left).toBe(0);
    expect(span.width).toBeCloseTo(100, 5);
  });

  it("pins a missing start to the left edge and a missing end to the right", () => {
    expect(ganttBarGeometry(axis, null, null)).toEqual({ left: 0, width: 100 });
    expect(ganttBarGeometry(axis, START, null).width).toBeCloseTo(100, 5);
  });

  it("never collapses a bar below the minimum width", () => {
    const span = ganttBarGeometry(axis, START, START);
    expect(span.width).toBeGreaterThanOrEqual(2);
    expect(span.width).toBeLessThanOrEqual(100);
  });
});

describe("milestone markers", () => {
  it("positions dated milestones and drops undated ones", () => {
    const axis = buildGanttAxis([START, DUE], NOW);
    const milestones: GanttMilestone[] = [
      { id: "m1", name: "Spec", status: "done", dueDate: START },
      { id: "m2", name: "Build", status: "planned", dueDate: null },
    ];
    const markers = milestoneMarkers(axis, milestones);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ id: "m1", left: 0, status: "done" });
  });
});

describe("status tones + stagger", () => {
  it("maps statuses onto token fills", () => {
    expect(ganttStatusTone("done")).toBe("success");
    expect(ganttStatusTone("in_progress")).toBe("accent");
    expect(ganttStatusTone("planned")).toBe("muted");
    expect(GANTT_TONE_CLASS.success).toContain("bg-success");
  });

  it("staggers at ≤40ms and caps the total delay", () => {
    expect(GANTT_STAGGER_MS).toBeLessThanOrEqual(40);
    expect(ganttStagger(0)).toBe(0);
    expect(ganttStagger(1)).toBe(GANTT_STAGGER_MS);
    expect(ganttStagger(999)).toBe(GANTT_MAX_STAGGER_STEPS * GANTT_STAGGER_MS);
    expect(ganttStagger(Number.NaN)).toBe(0);
  });
});

describe("renderToStaticMarkup — two bars", () => {
  const milestones: GanttMilestone[] = [
    { id: "m1", name: "Spec", status: "done", dueDate: "2026-04-05T00:00:00" },
    { id: "m2", name: "Build", status: "in_progress", dueDate: "2026-04-15T00:00:00" },
  ];
  const html = renderToStaticMarkup(
    h(
      TooltipProvider,
      null,
      h(ProjectGantt, { name: "Apollo", startDate: START, dueDate: DUE, milestones, locale: "en" }),
    ),
  );

  it("renders one status-toned bar per milestone", () => {
    expect(html.match(/data-testid="gantt-milestone"/g)).toHaveLength(2);
    expect(html).toContain('data-status="done"');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain("bg-success");
    expect(html).toContain("bg-accent");
  });

  it("draws the today marker in danger and the project bar in accent", () => {
    expect(html).toContain('data-testid="gantt-today"');
    expect(html).toContain("border-danger");
    expect(html).toContain('data-testid="gantt-project-bar"');
  });

  it("animates mounts with the rise token", () => {
    expect(html).toContain("animate-rise");
  });
});

/**
 * The reschedule contract: a chart without the write callbacks (a client seat, or
 * a caller that only wants the picture) must render today's read-only chart — no
 * handles, no tab stops, no "drag me" copy — while one handed the callbacks gets
 * grips and live sliders. Permission itself is decided by the page (it passes
 * `canEditContent`), so the component only has to honour what it is given.
 */
describe("renderToStaticMarkup — reschedule contract", () => {
  const milestones: GanttMilestone[] = [
    { id: "m1", name: "Spec", status: "planned", dueDate: "2026-04-05T00:00:00" },
    { id: "m2", name: "Build", status: "planned", dueDate: null },
  ];

  function render(props: Record<string, unknown>): string {
    return renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(ProjectGantt, {
          name: "Apollo",
          startDate: START,
          dueDate: DUE,
          milestones,
          locale: "en",
          ...props,
        }),
      ),
    );
  }

  const writable = {
    projectId: "p1",
    canEdit: true,
    onProjectDates: async () => ({ ok: true }),
    onMilestoneDue: async () => ({ ok: true }),
  };

  it("is read-only without the callbacks: no grips and nothing focusable", () => {
    const html = render({});

    expect(html).not.toContain("gantt-project-resize-start");
    expect(html).not.toContain("gantt-project-resize-end");
    expect(html).not.toContain("cursor-grab");
    expect(html).not.toContain("Drag the project bar");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it("stays read-only for a viewer who may not edit", () => {
    const html = render({ ...writable, canEdit: false });

    expect(html).not.toContain("gantt-project-resize-start");
    expect(html).toContain('aria-disabled="true"');
  });

  it("grows grips and focusable sliders for an editor", () => {
    const html = render(writable);

    expect(html).toContain('data-testid="gantt-project-resize-start"');
    expect(html).toContain('data-testid="gantt-project-resize-end"');
    expect(html).toContain("cursor-ew-resize");
    expect(html).toContain("cursor-grab");
    // project bar + two grips + the one dated milestone's dot
    expect(html.match(/role="slider"/g)).toHaveLength(4);
    expect(html).toContain('tabindex="0"');
  });

  it("announces the chart's dates and states the drag affordance", () => {
    const html = render(writable);

    expect(html).toContain("Move timeline item");
    expect(html).toContain("Drag the project bar");
    // An undated milestone has no dot to grab, so it is not a stop in the tab order.
    expect(html.match(/data-testid="gantt-milestone"/g)).toHaveLength(1);
  });
});
