import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RoadmapLoading from "./loading";

/**
 * The Roadmap loading state is reachable: the route's default export renders the
 * timeline lanes and rollup columns inside the shared container.
 */
describe("RoadmapLoading", () => {
  it("renders the shared container with lane and text skeletons", () => {
    const html = renderToStaticMarkup(createElement(RoadmapLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    // The lanes are card-like sections (bordered) holding text skeletons.
    expect(html).toContain("rounded-xl border border-border");
    expect(html).toContain('data-skeleton="text"');
  });
});
