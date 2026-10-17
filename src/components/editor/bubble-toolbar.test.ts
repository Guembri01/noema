import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Editor } from "@tiptap/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BubbleToolbar,
  LINK_POPOVER_INITIAL,
  bubbleButtonClass,
  isActiveSwatch,
  linkPopoverTarget,
  nextLinkPopover,
  normalizeLinkUrl,
  swatchChoices,
  tagSwatchValue,
  type LinkPopoverState,
} from "./bubble-toolbar";

/**
 * ds05 — bubble toolbar. The editor facade (`@/components/comment-panel`) and
 * the AI transport pull in Next/React tree code, so both are mocked; everything
 * under test here is the toolbar's own pure chrome + state machine plus a
 * static render in idle and active-mark states.
 */

vi.mock("@/components/comment-panel", () => ({ COMMENT_EVENT: "noema:comment" }));
vi.mock("@/lib/ai-client", () => ({ runAiSkill: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/* -------------------------------------------------------------------------- */
/* Active swatch detection                                                     */
/* -------------------------------------------------------------------------- */

describe("isActiveSwatch", () => {
  it("treats null/undefined/empty as the same unset value", () => {
    expect(isActiveSwatch(null, null)).toBe(true);
    expect(isActiveSwatch(undefined, null)).toBe(true);
    expect(isActiveSwatch("", null)).toBe(true);
    expect(isActiveSwatch("var(--tag-red-fg)", null)).toBe(false);
  });

  it("compares token strings case-insensitively and trimmed", () => {
    expect(isActiveSwatch(" var(--tag-red-fg) ", "VAR(--TAG-RED-FG)")).toBe(true);
    expect(isActiveSwatch("var(--tag-red-fg)", "var(--tag-blue-fg)")).toBe(false);
  });
});

describe("swatchChoices", () => {
  it("starts with a clear cell then one per hue, token-only", () => {
    const swatches = swatchChoices("text");
    expect(swatches).toHaveLength(10);
    expect(swatches[0]).toEqual({ value: null, labelKey: "colorDefault" });
    expect(swatchChoices("highlight")[0]).toEqual({ value: null, labelKey: "colorNone" });
    for (const swatch of swatches.slice(1)) {
      expect(swatch.value).toMatch(/^var\(--tag-[a-z]+-(fg|bg)\)$/);
    }
  });

  it("maps text to fg and highlight to bg tokens", () => {
    expect(tagSwatchValue("text", "red")).toBe("var(--tag-red-fg)");
    expect(tagSwatchValue("highlight", "red")).toBe("var(--tag-red-bg)");
  });
});

/* -------------------------------------------------------------------------- */
/* Link popover state machine                                                  */
/* -------------------------------------------------------------------------- */

describe("link popover state machine", () => {
  it("primes from the live mark on open", () => {
    const state = nextLinkPopover(LINK_POPOVER_INITIAL, {
      type: "open",
      title: "Docs",
      url: "example.com",
      newTab: true,
    });
    expect(state).toEqual({ title: "Docs", url: "example.com", newTab: true });
  });

  it("edits fields immutably and resets on close", () => {
    let state: LinkPopoverState = { ...LINK_POPOVER_INITIAL, url: "a" };
    state = nextLinkPopover(state, { type: "setUrl", value: "b" });
    state = nextLinkPopover(state, { type: "setNewTab", value: true });
    expect(state).toEqual({ title: "", url: "b", newTab: true });
    expect(nextLinkPopover(state, { type: "close" })).toEqual(LINK_POPOVER_INITIAL);
  });

  it("normalises typed URLs", () => {
    expect(normalizeLinkUrl("")).toBe("");
    expect(normalizeLinkUrl("   ")).toBe("");
    expect(normalizeLinkUrl("example.com")).toBe("https://example.com");
    expect(normalizeLinkUrl("  https://x.dev ")).toBe("https://x.dev");
    expect(normalizeLinkUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(normalizeLinkUrl("/docs/readme")).toBe("/docs/readme");
    expect(normalizeLinkUrl("#section")).toBe("#section");
  });

  it("derives the apply target, or null to unlink", () => {
    expect(linkPopoverTarget(LINK_POPOVER_INITIAL)).toBeNull();
    expect(
      linkPopoverTarget({ title: "", url: "example.com", newTab: false }),
    ).toEqual({ href: "https://example.com", target: null });
    expect(
      linkPopoverTarget({ title: "", url: "example.com", newTab: true }),
    ).toEqual({ href: "https://example.com", target: "_blank" });
  });
});

describe("bubbleButtonClass", () => {
  it("carries the interactive states and marks the active one with the soft accent", () => {
    const idle = bubbleButtonClass();
    expect(idle).toContain("focus-ring");
    expect(idle).toContain("u-interactive");
    expect(idle).toContain("hover:bg-surface-2");
    expect(idle).not.toContain("bg-accent-soft");
    expect(bubbleButtonClass({ active: true })).toContain("bg-accent-soft");
  });
});

/* -------------------------------------------------------------------------- */
/* Static render                                                               */
/* -------------------------------------------------------------------------- */

function createEditor(options: {
  active?: string[];
  attributes?: Record<string, Record<string, unknown>>;
} = {}): Editor {
  const active = new Set(options.active ?? []);
  const attributes = options.attributes ?? {};
  const chain: Record<string, unknown> = { run: () => true };
  for (const method of ["focus", "toggleBold", "setColor", "unsetColor", "setHighlight", "unsetHighlight", "extendMarkRange", "setLink", "unlink", "unsetLink", "insertContentAt", "unsetAllMarks", "clearNodes"]) {
    chain[method] = () => chain;
  }
  return {
    getAttributes: (name: string) => attributes[name] ?? {},
    isActive: (name: string) => active.has(name),
    chain: () => chain,
    state: { selection: { from: 0, to: 0 }, doc: { textBetween: () => "" } },
  } as unknown as Editor;
}

const render = (editor: Editor): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(BubbleToolbar, { editor, onPanelOpenChange: () => {} }),
    ),
  );

describe("BubbleToolbar render", () => {
  it("renders the idle toolbar from tokens", () => {
    const html = render(createEditor());
    expect(html).toContain("data-bubble-toolbar");
    expect(html).toContain("surface-raised");
    expect(html).toContain("focus-ring");
    expect(html).toContain("u-interactive");
    // Icon-only actions are named, and the group dividers render.
    expect(html).toContain('aria-label="Bold"');
    expect(html).toContain('aria-label="Link"');
    expect(html).toContain("w-px");
    // The overflow trigger for the rare marks.
    expect(html).toContain('aria-label="More"');
    expect(html).toContain('aria-pressed="false"');
    // No raw hex anywhere in the chrome.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("marks the active marks and the active swatch", () => {
    const html = render(
      createEditor({
        active: ["bold", "link"],
        attributes: { textStyle: { color: "var(--tag-red-fg)" } },
      }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("bg-accent-soft");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
