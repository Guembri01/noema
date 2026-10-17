import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AuditLoading from "./loading";

/**
 * The Audit loading state is reachable: the route's default export renders the
 * filter controls and events-table skeleton inside the shared container.
 */
describe("AuditLoading", () => {
  it("renders the shared container with a table skeleton", () => {
    const html = renderToStaticMarkup(createElement(AuditLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('data-skeleton="table"');
  });
});
