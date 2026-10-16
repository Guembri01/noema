import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FindBar, FIND_DEBOUNCE_MS, type FindBarProps } from "./find-bar";

/**
 * Render proof for the find bar. The matcher itself is covered exhaustively by
 * `src/lib/find-in-page.test.ts`; these assertions lock the *chrome* — the
 * counter, the polite live region, the toggles, the tokens and the 320 px
 * layout classes — at 0, 1 and many matches.
 */

const render = (props: Partial<FindBarProps> & Pick<FindBarProps, "blocks">): string =>
  renderToStaticMarkup(createElement(FindBar, props));

const twelve = (): FindBarProps["blocks"] => [
  { id: "p", text: Array.from({ length: 12 }, () => "x").join(" ") },
];

describe("FindBar", () => {
  it("is a labelled search landmark built from the design-system surface", () => {
    const html = render({ blocks: twelve(), initialQuery: "x" });
    expect(html).toContain('role="search"');
    expect(html).toContain('data-testid="editor-find-bar"');
    expect(html).toContain('aria-label="Find in page"');
    expect(html).toContain('placeholder="Find in page"');
    // Tokens: raised surface, the rise entrance, the interactive helper, Z.popover.
    expect(html).toContain("surface-raised");
    expect(html).toContain("animate-rise");
    expect(html).toContain("u-interactive");
    expect(html).toContain('style="z-index:50"');
    // 320 px-safe: a viewport-capped width that can wrap.
    expect(html).toContain("w-[min(92vw,26rem)]");
    expect(html).toContain("flex-wrap");
  });

  it("renders many matches as a 1-based counter plus the announced sentence", () => {
    const html = render({ blocks: twelve(), initialQuery: "x" });
    expect(html).toContain("1 / 12");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("1 of 12 matches");
  });

  it("renders a single match", () => {
    const html = render({
      blocks: [{ id: "p", text: "needle in a haystack" }],
      initialQuery: "needle",
    });
    expect(html).toContain("1 / 1");
    expect(html).toContain("1 of 1 matches");
    expect(html).not.toContain("disabled");
  });

  it("renders zero matches with the navigation disabled", () => {
    const html = render({ blocks: [{ id: "p", text: "hello world" }], initialQuery: "zzz" });
    expect(html).toContain("0 / 0");
    expect(html).toContain("0 of 0 matches");
    // Both step buttons carry the disabled attribute.
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes the toggles with aria-pressed and aria-labels", () => {
    const html = render({ blocks: twelve(), initialQuery: "x" });
    expect(html).toContain('aria-label="Match case"');
    expect(html).toContain('aria-label="Match whole word"');
    expect(html).toContain('aria-label="Use regular expression"');
    expect(html).toContain('aria-label="Previous match"');
    expect(html).toContain('aria-label="Next match"');
    expect(html).toContain('aria-label="Close find in page"');
    // Three toggle buttons, all off by default.
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
  });

  it("shows the keyboard hints on the navigation buttons", () => {
    const html = render({ blocks: twelve(), initialQuery: "x" });
    expect(html).toContain("⇧⏎");
    expect(html).toContain("⏎");
    expect(html).toContain("Previous match (⇧⏎)");
    expect(html).toContain("Next match (⏎)");
  });

  it("pins the debounce contract", () => {
    expect(FIND_DEBOUNCE_MS).toBe(120);
  });
});
