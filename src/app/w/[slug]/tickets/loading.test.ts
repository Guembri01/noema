import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TicketsLoading from "./loading";

/**
 * Route loading state for the tickets workspace. Pins the layout match (a board
 * of four columns of cards) and the a11y contract (busy + status), so the
 * placeholder cannot drift away from `TicketBoardView`.
 */

const html = renderToStaticMarkup(createElement(TicketsLoading));

const count = (needle: string) => html.split(needle).length - 1;

describe("tickets loading route", () => {
  it("renders the shared container with a busy status", () => {
    expect(html).toContain('data-testid="tickets-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("mx-auto w-full max-w-[1600px] px-8 py-12");
  });

  it("stands in for the board: four columns of three card skeletons", () => {
    expect(count('data-skeleton="card"')).toBe(12);
    expect(count("w-64 shrink-0")).toBe(4);
  });

  it("draws shimmering bars for the header, toolbar and rollups", () => {
    expect(count("notion-skeleton")).toBeGreaterThan(20);
    // The board is not empty — no accidental empty tree.
    expect(html).not.toBe("");
  });
});
