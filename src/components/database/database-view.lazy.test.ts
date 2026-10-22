import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const view = readFileSync("src/components/database/database-view.tsx", "utf8");
const renderers = readFileSync("src/components/database/view-renderers.tsx", "utf8");
const gallery = readFileSync("src/components/database/gallery-view.tsx", "utf8");

describe("database lazy surfaces", () => {
  it("does not statically import chart, timeline, calendar, form, or property options", () => {
    expect(view).not.toMatch(/import\s*\{[^}]*\b(ChartView|TimelineView|CalendarView|FormView)\b[^}]*\}/);
    expect(view).not.toMatch(/import\s*\{[^}]*\bPropertyOptionsEditor\b[^}]*\}/);
  });

  it("does not re-export CalendarView from the eager renderer modules", () => {
    expect(renderers).not.toMatch(/export\s*\{\s*CalendarView\s*\}/);
    expect(gallery).not.toMatch(/export\s*\{\s*CalendarView\s*\}/);
  });

  it("loads the optional views with next/dynamic", () => {
    expect(view).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/database\/timeline-chart-views"\)/);
    expect(view).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/database\/form-view"\)/);
  });
});
