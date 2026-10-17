import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectDetailLoading from "./loading";

/**
 * Route loading state for one project. Pins the shared container plus the
 * section rhythm (Overview, Milestones, Tickets) that matches `ProjectDetail`.
 */

const html = renderToStaticMarkup(createElement(ProjectDetailLoading));

const count = (needle: string) => html.split(needle).length - 1;

describe("project detail loading route", () => {
  it("renders the shared container with a busy status", () => {
    expect(html).toContain('data-testid="project-detail-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
  });

  it("stands in for the milestone and ticket rows", () => {
    // 4 milestone rows + 5 ticket rows.
    expect(count('data-skeleton="row"')).toBe(9);
    expect(count("notion-skeleton")).toBeGreaterThan(9);
  });
});
