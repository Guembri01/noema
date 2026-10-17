import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UndoButton } from "./toast-undo";
import { UNDO_WINDOW_MS } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

/**
 * The rendered Undo action.
 *
 * The accessibility contract is the point: the button names the action it will
 * undo ("Undo Delete"), advertises `Control+Z`, and carries a countdown that is
 * a pure CSS animation — the markup must contain no timer and no stateful
 * re-render, only a duration that matches the `withUndo` window.
 */
const render = (props: Parameters<typeof UndoButton>[0]): string =>
  renderToStaticMarkup(createElement(UndoButton, props));

describe("UndoButton", () => {
  it("names the action in its accessible label", () => {
    const html = render({ action: "Delete", onUndo: () => {} });
    expect(html).toContain('data-testid="undo-action"');
    expect(html).toContain('aria-label="Undo Delete"');
    expect(html).toContain('type="button"');
  });

  it("advertises the keyboard shortcut", () => {
    const html = render({ action: "Archive", onUndo: () => {} });
    expect(html).toContain('aria-keyshortcuts="Control+Z"');
  });

  it("renders the countdown as a CSS animation, not a timer", () => {
    const html = render({ action: "Move", onUndo: () => {} });
    expect(html).toContain("animation-name:undo-countdown");
    // The window is data: it rides a local custom property, so the animation
    // value itself stays token-driven (`var(--undo-window)`).
    expect(html).toContain(`--undo-window:${UNDO_WINDOW_MS}ms`);
    expect(html).toContain("animation-duration:var(--undo-window)");
    expect(html).toContain("animation-timing-function:var(--ease-linear)");
    // The keyframes belong to the shared vocabulary, not to a component.
    expect(html).not.toContain("@keyframes");
    expect(html).toContain('data-testid="undo-countdown"');
    // Decorative: screen readers get the button, not the bar.
    expect(html).toMatch(/aria-hidden="true"[^>]*>\s*<span data-testid="undo-countdown"/);
    expect(html).not.toContain("setInterval");
  });

  it("inherits a custom window on the animation", () => {
    const html = render({ action: "Rename", onUndo: () => {}, windowMs: 1500 });
    expect(html).toContain("--undo-window:1500ms");
  });

  it("localizes the undo word", () => {
    const html = render({ action: "Supprimer", onUndo: () => {}, locale: "fr" });
    expect(html).toContain(`aria-label="${t("fr", "undo")} Supprimer"`);
  });
});
