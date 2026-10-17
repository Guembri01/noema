import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TicketArchiveLoading from "./loading";

/**
 * Route loading state for archived tickets. Pins the narrow container and the
 * row-based list that matches `TicketArchiveView`.
 */

const html = renderToStaticMarkup(createElement(TicketArchiveLoading));

const count = (needle: string) => html.split(needle).length - 1;

describe("tickets archive loading route", () => {
  it("renders the shared container with a busy status", () => {
    expect(html).toContain('data-testid="tickets-archive-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("mx-auto w-full max-w-[900px] px-8 py-12");
  });

  it("stands in for the archival list with six row skeletons", () => {
    expect(count('data-skeleton="row"')).toBe(6);
    expect(count("notion-skeleton")).toBeGreaterThan(6);
  });
});
