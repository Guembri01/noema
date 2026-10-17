import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AuditLogLoading from "./loading";

/**
 * The settings audit-log loading state is reachable: the route's default export
 * renders the filter controls and the activity-table skeleton inside the shared
 * container.
 */
describe("AuditLogLoading", () => {
  it("renders the shared container with a table skeleton", () => {
    const html = renderToStaticMarkup(createElement(AuditLogLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-skeleton="table"');
  });
});
