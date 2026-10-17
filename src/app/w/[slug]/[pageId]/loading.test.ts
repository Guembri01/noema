import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DW16 — the page-route loading skeleton.
 *
 * `loading.tsx` is the shell Next streams the instant a page navigation starts,
 * before the route's server tree (page detail, database, references, versions)
 * resolves. It must mirror the real page's shape — a title bar plus paragraph
 * lines — and paint with the sanctioned skeleton fill (the token gradient +
 * `animate-shimmer`, never a raw hex) so landing real content shifts nothing.
 * A `renderToStaticMarkup` pass pins that shape.
 */

import PageRouteLoading from "./loading";

describe("PageRouteLoading skeleton", () => {
  const html = renderToStaticMarkup(createElement(PageRouteLoading));

  it("announces itself as a busy, polite region", () => {
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
  });

  it("paints every bar with the sanctioned token skeleton fill", () => {
    const bars = html.match(/notion-skeleton/g) ?? [];
    // breadcrumb (2) + title bar + icon — at least four, never a raw hex.
    expect(bars.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).toContain("animate-shimmer");
  });

  it("shapes the body as paragraph lines", () => {
    const paragraphs = html.match(/data-skeleton="text"/g) ?? [];
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(html).toContain("Loading page");
  });
});
