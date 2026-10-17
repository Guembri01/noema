import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectsLoading from "./loading";

/**
 * Route loading state for the projects board. Pins the card grid (six cards on
 * the same `sm:grid-cols-2 lg:grid-cols-3` track as `ProjectsBoard`).
 */

const html = renderToStaticMarkup(createElement(ProjectsLoading));

const count = (needle: string) => html.split(needle).length - 1;

describe("projects loading route", () => {
  it("renders the shared container with a busy status", () => {
    expect(html).toContain('data-testid="projects-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
  });

  it("stands in for the card grid", () => {
    expect(html).toContain('data-testid="projects-loading-grid"');
    expect(html).toContain("grid gap-4 sm:grid-cols-2 lg:grid-cols-3");
    expect(count('data-skeleton="card"')).toBe(6);
  });
});
