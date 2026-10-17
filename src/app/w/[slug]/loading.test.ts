import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceHomeLoading from "./loading";

/**
 * The workspace-home loading state is reachable: the route's default export
 * renders the greeting header and the template-gallery skeleton inside the
 * shared container.
 */
describe("WorkspaceHomeLoading", () => {
  it("renders the shared container with gallery-card skeletons", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceHomeLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-skeleton="card"');
  });
});
