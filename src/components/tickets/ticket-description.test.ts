import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TicketDescription,
  blockChoice,
  DESCRIPTION_AUTOSAVE_MS,
} from "./ticket-description";

/**
 * The ticket description's block picker (pure part) plus its autosave cadence.
 *
 * The editor itself is exercised by the drawer's markup test and, end to end,
 * by `e2e/descriptions.spec.ts`; what is pinned here is the mapping from a
 * caret's flags to the picker entry, and that the debounce stays inside the
 * design system's "standard" motion band (150-220 ms is *animation*; this is a
 * network cadence, and the old textarea used the same 800 ms).
 */
describe("blockChoice", () => {
  it("reads a heading level when the caret is in one", () => {
    expect(blockChoice({ heading: 1 })).toBe("h1");
    expect(blockChoice({ heading: 2 })).toBe("h2");
    expect(blockChoice({ heading: 3 })).toBe("h3");
  });

  it("reads a quote, then falls back to plain text", () => {
    expect(blockChoice({ blockquote: true })).toBe("quote");
    expect(blockChoice({})).toBe("paragraph");
  });

  it("prefers the heading when a heading sits inside a quote", () => {
    expect(blockChoice({ heading: 2, blockquote: true })).toBe("h2");
  });

  it("ignores a heading level outside the picker (4-6 render as text)", () => {
    expect(blockChoice({ heading: 4 })).toBe("paragraph");
  });
});

describe("autosave cadence", () => {
  it("keeps the drawer's 800 ms quiet period", () => {
    expect(DESCRIPTION_AUTOSAVE_MS).toBe(800);
  });
});

/*
 * The two panel controls in the toolbar. Their *contents* need a live editor
 * (ProseMirror does not mount without a DOM), so what is pinned here is the
 * contract the panels are opened through: each control is a labelled dialog
 * trigger that names its own panel, and nothing renders until one is opened.
 */
describe(
  "description toolbar panels",
  // Radix-backed static renders stretched past the 5 s default under
  // full-suite contention (8.2 s, P3-T09).
  { timeout: 60_000 },
  () => {
  const render = (locale = "en") =>
    renderToStaticMarkup(
      // The toolbar's buttons carry tooltips, which are Radix-backed and need the
      // provider the app's layout supplies.
      createElement(
        TooltipProvider,
        null,
        createElement(TicketDescription, {
          doc: null,
          text: "",
          locale,
          onSave: () => {},
        }),
      ),
    );

  it("opens the colour panel from a dialog trigger that names it", () => {
    const html = render();
    expect(html).toMatch(
      /aria-label="Text color"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]*-description-color"/,
    );
  });

  it("opens the link panel from a dialog trigger that names it", () => {
    const html = render();
    expect(html).toMatch(
      /aria-label="Link"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]*-description-link"/,
    );
  });

  it("is a toggle button when it is not a dialog trigger", () => {
    // The mark buttons keep `aria-pressed`; only the two panels announce
    // themselves as dialogs, so nothing is announced as both.
    const html = render();
    expect(html).toMatch(/aria-label="Bold"[^>]*aria-pressed="false"/);
    expect(html).not.toMatch(/aria-label="Text color"[^>]*aria-pressed/);
    expect(html).not.toMatch(/aria-label="Link"[^>]*aria-pressed/);
  });

  it("renders no panel until one is opened", () => {
    expect(render()).not.toContain("ticket-description-panel");
  });

  it("localises the two triggers", () => {
    const html = render("fr");
    expect(html).toContain('aria-label="Couleur du texte"');
    expect(html).toContain('aria-label="Lien"');
  });
});
