import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TrashLoading from "./loading";

/**
 * The Trash loading state is reachable: the route's default export renders the
 * heading and the archived-page row skeleton inside the shared container.
 */
describe("TrashLoading", () => {
  it("renders the shared container with row skeletons", () => {
    const html = renderToStaticMarkup(createElement(TrashLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-skeleton="row"');
  });
});
