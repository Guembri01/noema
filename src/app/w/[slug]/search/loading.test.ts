import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SearchLoading from "./loading";

/**
 * The Search loading state is reachable: the route's default export renders the
 * header, search field and result-row skeletons inside the shared container.
 */
describe("SearchLoading", () => {
  it("renders the shared container with result-row skeletons", () => {
    const html = renderToStaticMarkup(createElement(SearchLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('data-skeleton="row"');
  });
});
