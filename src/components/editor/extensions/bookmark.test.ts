import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookmarkCardSurface } from "./bookmark";

/**
 * ds05 — bookmark card. The Tiptap node view is split into the presentational
 * `BookmarkCardSurface`, so the loading skeleton, the error ink and the loaded
 * card can all be rendered with `renderToStaticMarkup` from the node test
 * environment (no DOM).
 */

const renderCard = (props: Parameters<typeof BookmarkCardSurface>[0] = {}): string =>
  renderToStaticMarkup(createElement(BookmarkCardSurface, props));

describe("BookmarkCardSurface — loading", () => {
  it("renders a layout-shaped skeleton", () => {
    const html = renderCard({ state: "loading" });
    expect(html).toContain('data-bookmark-state="loading"');
    expect(html).toContain('aria-busy="true"');
    // The shared Skeleton fill + card frame (so nothing shifts on load).
    expect(html).toContain("notion-skeleton");
    expect(html).toContain('data-skeleton="card"');
    expect(html).not.toContain("noema-bookmark-card");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("BookmarkCardSurface — ready", () => {
  it("renders the token-based link card with its hover treatment", () => {
    const html = renderCard({
      url: "https://example.com/article",
      title: "Example article",
      description: "A short summary",
      image: "https://cdn.example.com/thumb.png",
      icon: "https://example.com/favicon.ico",
      host: "example.com",
    });
    expect(html).toContain('data-bookmark-state="ready"');
    expect(html).toContain("noema-bookmark-card");
    // Chrome comes from tokens: border / surface / radius.
    expect(html).toContain("border-border");
    expect(html).toContain("bg-surface");
    expect(html).toContain("rounded-md");
    // Hover/press settle through the utilities, never a size change.
    expect(html).toContain("u-surface");
    expect(html).toContain("u-interactive");
    expect(html).toContain("hover:bg-surface-2");
    // The structural hooks the e2e selectors rely on stay put.
    expect(html).toContain("noema-bookmark-link");
    expect(html).toContain("noema-bookmark-title");
    expect(html).toContain("noema-bookmark-image");
    expect(html).toContain("noema-bookmark-actions");
    expect(html).toContain('aria-label="Edit link"');
    expect(html).toContain('aria-label="Remove"');
    expect(html).toContain("Example article");
    expect(html).toContain("example.com");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("frames a provider embed with the overlay/surface tokens", () => {
    const html = renderCard({
      url: "https://example.com/article",
      host: "example.com",
      embedUrl: "https://www.youtube.com/embed/abc",
    });
    expect(html).toContain("noema-bookmark-embed");
    expect(html).toContain("bg-overlay");
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain('loading="lazy"');
  });
});

describe("BookmarkCardSurface — error", () => {
  it("renders inline danger ink", () => {
    const html = renderCard({ state: "error", error: "Enter a valid web address." });
    expect(html).toContain('data-bookmark-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(html).toContain("Enter a valid web address.");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("falls back to a message when none is given", () => {
    const html = renderCard({ state: "error" });
    expect(html).toContain("Couldn&#x27;t load this link.");
  });
});

describe("tokens-only guard", () => {
  const source = readFileSync(new URL("./bookmark.tsx", import.meta.url), "utf8");
  // Mirror `scripts/check-design-system.mjs`: comment lines (which may quote a
  // URL fragment like `owner/repo#123`) are not code.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  it("carries no raw hex and no legacy palette class", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/,
    );
  });
});
