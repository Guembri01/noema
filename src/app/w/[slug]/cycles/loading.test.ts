import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CyclesLoading from "./loading";

/**
 * The Cycles loading state is reachable: the route's default export renders the
 * cycle-card skeletons inside the shared container.
 */
describe("CyclesLoading", () => {
  it("renders the shared container with cycle-card skeletons", () => {
    const html = renderToStaticMarkup(createElement(CyclesLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('data-skeleton="card"');
  });
});
