import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InboxLoading from "./loading";

/**
 * The Inbox loading state is reachable: the route's default export renders the
 * day-grouped notification-row skeletons inside the shared container.
 */
describe("InboxLoading", () => {
  it("renders the shared container with notification-row skeletons", () => {
    const html = renderToStaticMarkup(createElement(InboxLoading));
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
    expect(html).toContain("notion-skeleton");
    expect(html).toContain("animate-shimmer");
    expect(html).toContain('data-skeleton="row"');
  });
});
