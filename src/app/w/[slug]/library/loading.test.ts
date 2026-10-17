import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LibraryLoading from "./loading";

/**
 * The Library loading state is reachable: the route's default export renders a
 * layout-matched skeleton inside the shared full-bleed container.
 */
describe("LibraryLoading", () => {
  it("renders the shared container with card skeletons", () => {
    const html = renderToStaticMarkup(createElement(LibraryLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-skeleton="card"');
  });
});
