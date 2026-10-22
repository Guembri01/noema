import { describe, expect, it, vi } from "vitest";
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Editor } from "@tiptap/react";
import {
  DropdownMenu,
  DropdownMenuContentImpl,
  DropdownMenuSub,
  DropdownMenuSubContentImpl,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { BLOCK_COLOR_CATALOGUE } from "@/components/editor/extensions/block-colors";
import { BlockColorMenu, BlockContextMenu } from "./block-context-menu";

/**
 * ds04 — block context menu. The editor facade and the AI transport pull in
 * Next/React tree code, so both are mocked (same pattern as `bubble-toolbar`).
 * Everything under test is the colour grid's token-only chrome plus a static
 * render of the menu; Radix portals do not render under `renderToStaticMarkup`,
 * so the grid is rendered inside the exported `*ContentImpl` surfaces.
 */

vi.mock("@/components/comment-panel", () => ({ COMMENT_EVENT: "noema:comment" }));
vi.mock("@/components/editor/equation-editor", () => ({ EQUATION_EVENT: "noema:equation" }));
vi.mock("@/lib/ai-client", () => ({ runAiSkill: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const noop = () => {};

/** Render the colour submenu body on the real (non-portal) menu surfaces. */
function renderColorMenu({ locale = "en" }: { locale?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(
      DropdownMenu,
      { open: true },
      createElement(
        DropdownMenuContentImpl,
        { forceMount: true },
        createElement(
          DropdownMenuSub,
          null,
          createElement(DropdownMenuSubTrigger, null, "Color"),
          createElement(
            DropdownMenuSubContentImpl,
            { forceMount: true },
            createElement(BlockColorMenu, {
              locale,
              onPickText: noop,
              onPickBackground: noop,
              onClearHighlight: noop,
            }),
          ),
        ),
      ),
    ),
  );
}

describe("BlockColorMenu — static render", () => {
  const html = renderColorMenu();

  it("shows no raw hex for any swatch", () => {
    expect(html).not.toMatch(HEX);
  });

  it("paints every text colour with a tag foreground token", () => {
    for (const hue of ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]) {
      expect(html).toContain(`var(--tag-${hue}-fg)`);
    }
  });

  it("paints every block tint with the catalogue's token", () => {
    for (const entry of BLOCK_COLOR_CATALOGUE) {
      expect(html).toContain(entry.tint);
    }
  });

  it("renders on the shared raised + rising + popover surface", () => {
    expect(html).toContain("surface-raised");
    expect(html).toContain("data-[state=open]:animate-rise");
    expect(html).toContain("z-index:50");
  });

  it("gives every row hover / focus-visible / disabled hooks", () => {
    // Hover + keyboard highlight and disabled come from the shared menu item…
    expect(html).toContain("data-[highlighted]:bg-surface-2");
    expect(html).toContain("data-[disabled]:opacity-50");
    // …and the row adds the focus-visible ring.
    expect(html).toContain("focus-ring");
    // One swatch row per palette entry (Default + nine) + background rows +
    // the clear row, each carrying the ring class.
    const rows = html.match(/focus-ring/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(BLOCK_COLOR_CATALOGUE.length + 10);
  });
});

describe("BlockContextMenu — static render", () => {
  // `children` is required on the real component; a plain FC view of it keeps
  // the child in `createElement`'s var-args slot (eslint's preferred form).
  const Menu = BlockContextMenu as unknown as FC<{
    editor: Editor;
    editable: boolean;
    locale?: string;
  }>;

  it("renders its chrome without a raw hex", () => {
    const html = renderToStaticMarkup(
      createElement(
        Menu,
        { editor: {} as Editor, editable: true, locale: "en" },
        createElement("span", null, "child"),
      ),
    );
    expect(html).toContain("child");
    expect(html).not.toMatch(HEX);
  });
});
