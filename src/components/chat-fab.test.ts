import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatFab } from "./chat-fab";
import { t } from "@/lib/i18n";

/**
 * The floating "Ask AI" button.
 *
 * The contract worth pinning is the accessible-name/role contract: it is a real
 * `<button>` (the pattern it replaced was a `div role="button"` that had to
 * re-implement focus and keyboard activation), it names itself, it advertises that
 * it opens a dialog, and it reports its expanded state. Plus the placement
 * invariants: bottom-right, above page content but below overlays, and hidden
 * while the panel it opens is open.
 */
const render = (props: Parameters<typeof ChatFab>[0]) =>
  renderToStaticMarkup(createElement(ChatFab, props));

describe("ChatFab", () => {
  it("is a real button that names itself", () => {
    const html = render({ open: false, onOpen: () => {}, locale: "en" });
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain(`aria-label="${t("en", "askAI")}"`);
    expect(html).not.toContain('role="button"');
  });

  it("announces that it opens a dialog and reflects its expanded state", () => {
    expect(render({ open: false, onOpen: () => {}, locale: "en" })).toContain('aria-haspopup="dialog"');
    expect(render({ open: false, onOpen: () => {}, locale: "en" })).toContain('aria-expanded="false"');
    expect(render({ open: true, onOpen: () => {}, locale: "en" })).toContain('aria-expanded="true"');
  });

  it("hides itself while the panel is open, so there is one entry point", () => {
    // Careful: `aria-hidden` on the mark contains the word "hidden", so match the
    // utility class, not the substring.
    const closed = render({ open: false, onOpen: () => {}, locale: "en" });
    const opened = render({ open: true, onOpen: () => {}, locale: "en" });
    expect(closed).not.toMatch(/class="[^"]*\bhidden\b/);
    expect(opened).toMatch(/class="[^"]*\bhidden\b/);
  });

  it("sits bottom-right, above content, with the token motion vocabulary", () => {
    const html = render({ open: false, onOpen: () => {}, locale: "en" });
    expect(html).toContain("bottom-5");
    expect(html).toContain("end-5");
    expect(html).toContain("fixed");
    expect(html).toContain("z-index:30"); // Z.sidebar
    expect(html).toContain("var(--ease-spring)");
    expect(html).toContain("var(--dur-3)");
    // No raw colour, no magic z-index: everything comes from the token layer.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/z-index:\s*(?!30)\d/);
  });

  it("draws its own mark instead of shipping someone else's face", () => {
    const html = render({ open: false, onOpen: () => {}, locale: "en" });
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("currentColor"); // theme-aware
    expect(html).not.toContain("<img");
  });

  it("localises its accessible name", () => {
    const html = render({ open: false, onOpen: () => {}, locale: "fr" });
    expect(html).toContain(`aria-label="${t("fr", "askAI")}"`);
  });
});
