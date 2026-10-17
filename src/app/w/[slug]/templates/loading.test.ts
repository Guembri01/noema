import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TemplatesLoading from "./loading";

/**
 * The Templates loading state is reachable: the route's default export renders
 * the search/sort controls and card grid inside the shared container.
 */
describe("TemplatesLoading", () => {
  it("renders the shared container with template-card skeletons", () => {
    const html = renderToStaticMarkup(createElement(TemplatesLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('data-skeleton="card"');
  });
});
