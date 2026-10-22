import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `PeekHeader` renders a `next/link`; node has no router, so render a plain `<a>`
// (keeping every other attribute so the class assertions still see the real DOM).
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      const { href, children, ...rest } = props;
      return React.createElement("a", { href, ...rest }, children as never);
    },
  };
});

import { Z } from "@/lib/design-tokens";
import {
  OPTION_FOREGROUND,
  type DBProperty,
  type DBRow,
} from "@/components/database/database-types";
import {
  PeekHeader,
  PeekRow,
  ROW_ACCENT_RAIL,
  ROW_HOVER_TINT,
  peekPanelClass,
  peekPanelStyle,
  peekRail,
  peekRowClass,
  peekScrimClass,
  peekScrimStyle,
} from "./database-view";

/**
 * dw07 — the side peek's design-system layer.
 *
 * The drawer's *pure* mappings (scrim tokens, layering, the enter/exit motion,
 * the shared row treatment) are pinned here, then the two extracted row
 * components are rendered with `react-dom/server` so a regression that drops a
 * token class or re-inlines a raw colour fails without a browser.
 */

const noop = () => {};

const row: DBRow = {
  id: "r1",
  title: "Alpha",
  icon: null,
  propertyValues: [{ propertyId: "notes", value: { text: "hello" } }],
};

const property = (
  id: string,
  name: string,
  type: string,
  config: DBProperty["config"] = null,
): DBProperty => ({ id, name, type: type as DBProperty["type"], config });

describe("peek scrim — a token `--overlay` wash at `Z.overlay`", () => {
  it("paints the scrim from the overlay token", () => {
    expect(peekScrimClass()).toContain("bg-overlay");
    expect(peekScrimClass()).toContain("fixed inset-0");
    expect(peekScrimClass()).toContain("u-colors");
  });

  it("fades in/out on the --dur-3 token (never a jump, no layout shift)", () => {
    const open = peekScrimStyle(true);
    expect(open.zIndex).toBe(Z.overlay);
    expect(open.opacity).toBe(1);
    expect(open.transition).toContain("var(--dur-3)");
    expect(open.transition).toContain("var(--ease-smooth)");
    expect(peekScrimStyle(false).opacity).toBe(0);
  });
});

describe("peek panel — named entrance, mirrored exit, token layering", () => {
  it("enters on animate-slide-in-right", () => {
    expect(peekPanelClass(true)).toBe("animate-slide-in-right");
    expect(peekPanelClass(false)).toBe("");
  });

  it("keeps Z.modal open and closed, and mirrors the 8px slide out", () => {
    const open = peekPanelStyle(true);
    expect(open.zIndex).toBe(Z.modal);
    expect(open.transform).toBeUndefined();

    const closed = peekPanelStyle(false);
    expect(closed.zIndex).toBe(Z.modal);
    expect(closed.opacity).toBe(0);
    // `slide-in-right` enters from translateX(8px) — the exit is its mirror.
    expect(closed.transform).toBe("translateX(8px)");
    expect(closed.transition).toContain("var(--dur-3)");
    expect(closed.transition).toContain("var(--ease-smooth)");
  });
});

describe("peek row state — the table body's tint + a matching accent rail", () => {
  it("shares the table body's hover tint", () => {
    // The literal the table body carries in `view-renderers.tsx`.
    expect(ROW_HOVER_TINT).toBe("hover:bg-surface-2/60");
    expect(peekRowClass()).toContain(ROW_HOVER_TINT);
    expect(peekRowClass()).toContain("u-colors");
  });

  it("maps a row colour to the table stripe, falling back to the accent token", () => {
    expect(peekRail(null)).toBe(ROW_ACCENT_RAIL);
    expect(peekRail(undefined)).toBe(ROW_ACCENT_RAIL);
    expect(ROW_ACCENT_RAIL).toBe("3px solid var(--accent)");
    expect(peekRail("blue")).toBe(`3px solid ${OPTION_FOREGROUND.blue}`);
  });
});

describe("PeekHeader — renders the open row's tint + accent rail", () => {
  it("carries the accent rail, the shared tint and focus-ringed affordances", () => {
    const html = renderToStaticMarkup(
      createElement(PeekHeader, {
        row,
        locale: "en",
        workspaceSlug: "w",
        rowColor: null,
        onClose: noop,
      }),
    );
    expect(html).toContain('data-testid="peek-header"');
    expect(html).toContain("border-inline-start");
    expect(html).toContain("var(--accent)");
    expect(html).toContain(ROW_HOVER_TINT);
    expect(html).toContain("u-colors");
    expect(html).toContain("focus-ring");
    expect(html).toContain('href="/w/w/r1"');
  });

  it("uses the row colour for the rail when the row carries one", () => {
    const html = renderToStaticMarkup(
      createElement(PeekHeader, {
        row,
        locale: "en",
        workspaceSlug: "w",
        rowColor: "blue",
        onClose: noop,
      }),
    );
    expect(html).toContain(OPTION_FOREGROUND.blue);
  });
});

describe("PeekRow — every property row shares the row treatment", () => {
  it("renders the hover tint on a property row", () => {
    const html = renderToStaticMarkup(
      createElement(PeekRow, {
        locale: "en",
        property: property("notes", "Notes", "TEXT"),
        row,
        isPrimary: false,
        computed: undefined,
        value: { text: "hello" },
        relationOptions: [],
        peopleOptions: [],
        workspaceId: "ws",
        editable: false,
        onChange: noop,
        onRenamePrimary: noop,
      }),
    );
    expect(html).toContain('data-testid="peek-row-notes"');
    expect(html).toContain(ROW_HOVER_TINT);
    expect(html).toContain("u-colors");
  });

  it("edits the primary title in place with the focus ring", () => {
    const html = renderToStaticMarkup(
      createElement(PeekRow, {
        locale: "en",
        property: property("title", "Title", "TEXT", { primary: true }),
        row,
        isPrimary: true,
        computed: undefined,
        value: null,
        relationOptions: [],
        peopleOptions: [],
        workspaceId: "ws",
        editable: true,
        onChange: noop,
        onRenamePrimary: noop,
      }),
    );
    expect(html).toContain('data-testid="peek-row-title"');
    expect(html).toMatch(/<input[^>]*focus-ring/);
    expect(html).toContain("Alpha");
  });

  it("keeps a computed value read-only", () => {
    const html = renderToStaticMarkup(
      createElement(PeekRow, {
        locale: "en",
        property: property("total", "Total", "FORMULA"),
        row,
        isPrimary: false,
        computed: "42",
        value: null,
        relationOptions: [],
        peopleOptions: [],
        workspaceId: "ws",
        editable: true,
        onChange: noop,
        onRenamePrimary: noop,
      }),
    );
    expect(html).toContain('data-testid="peek-row-total"');
    expect(html).toContain(">42<");
    expect(html).not.toContain("<input");
  });
});
