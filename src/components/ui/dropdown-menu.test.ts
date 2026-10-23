import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
  OVERLAY_COLLISION_PADDING,
  OVERLAY_SIDE_OFFSET,
  OPPOSITE_SIDE,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContentImpl,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContentImpl,
  DropdownMenuSubTrigger,
  menuChoiceItemClass,
  menuItemClass,
  menuSubTriggerClass,
  navTransitionClass,
  overlayMotionClass,
  overlayMotionClasses,
  resolveFloatingPlacement,
} from "./dropdown-menu";
import {
  ContextMenu,
  ContextMenuContentImpl,
  ContextMenuItem,
} from "./context-menu";
import { Popover, PopoverContentImpl } from "./popover";

/**
 * fix10 — overlay motion + layering.
 *
 * Everything the four overlay surfaces share lives in `dropdown-menu.tsx` as
 * pure functions; this suite pins them without a browser:
 *  - enter/exit class selection (rise / scale-in / fade, mirrored on exit),
 *  - the pointer-vs-keyboard highlight split and the no-transition rule,
 *  - collision-aware placement (flip + shift) maths,
 *  - `renderToStaticMarkup` of a menu (and the popover / context menu) in
 *    each state, plus a static guard that no raw hex / magic z-index /
 *    ad-hoc duration creeps back in.
 */

describe("overlay motion classes", () => {
  it("rises menus on enter at --dur-1 and mirrors them on exit", () => {
    const open = overlayMotionClass("menu", "open");
    const closed = overlayMotionClass("menu", "closed");
    expect(open).toBe(
      "data-[state=open]:animate-rise data-[state=open]:[animation-duration:var(--dur-1)]",
    );
    expect(closed).toContain("data-[state=closed]:animate-rise");
    expect(closed).toContain("[animation-direction:reverse]");
    expect(closed).toContain("--dur-1");
  });

  it("scales dialogs in at --dur-2 and mirrors them out at --dur-1", () => {
    const open = overlayMotionClass("dialog", "open");
    const closed = overlayMotionClass("dialog", "closed");
    expect(open).toContain("animate-scale-in");
    expect(open).toContain("var(--dur-2)");
    expect(open).not.toContain("reverse");
    expect(closed).toContain("animate-scale-in");
    expect(closed).toContain("[animation-direction:reverse]");
    expect(closed).toContain("--dur-1");
    expect(closed).not.toContain("--dur-2");
  });

  it("fades scrims", () => {
    expect(overlayMotionClass("scrim", "open")).toContain("animate-fade");
    expect(overlayMotionClass("scrim", "closed")).toContain("reverse");
  });

  it("never runs a longer exit than the matching enter", () => {
    // Extract the duration token from each variant.
    const durationOf = (kind: "menu" | "dialog" | "scrim", state: "open" | "closed") =>
      Number(/--dur-(\d)/.exec(overlayMotionClass(kind, state))![1]);
    for (const kind of ["menu", "dialog", "scrim"] as const) {
      expect(durationOf(kind, "closed")).toBeLessThanOrEqual(durationOf(kind, "open"));
    }
    expect(durationOf("dialog", "closed")).toBeLessThan(durationOf("dialog", "open"));
  });

  it("bundles both variants for a surface", () => {
    const all = overlayMotionClasses("menu");
    expect(all).toContain(overlayMotionClass("menu", "open"));
    expect(all).toContain(overlayMotionClass("menu", "closed"));
  });
});

describe("item states and pointer-vs-keyboard highlight", () => {
  it("keeps a distinct keyboard highlight from the mouse hover", () => {
    const pointer = menuItemClass({ nav: "pointer" });
    const keyboard = menuItemClass({ nav: "keyboard" });
    expect(pointer).toContain("data-[highlighted]:bg-surface-2");
    expect(pointer).not.toContain("bg-selection-soft");
    expect(keyboard).toContain("data-[highlighted]:bg-selection-soft");
    expect(keyboard).not.toContain("data-[highlighted]:bg-surface-2");
    expect(keyboard).not.toBe(pointer);
  });

  it("drops transitions while the keyboard drives the highlight", () => {
    expect(navTransitionClass("keyboard")).toBe("u-no-transition");
    expect(navTransitionClass("pointer")).toBe("");
  });

  it("carries the shared hover / disabled / selected states", () => {
    const base = menuItemClass();
    expect(base).toContain("u-colors");
    expect(base).toContain("data-[highlighted]:bg-surface-2");
    expect(base).toContain("data-[disabled]:opacity-50");
    expect(base).toContain("data-[disabled]:pointer-events-none");
    expect(menuItemClass({ destructive: true })).toContain("text-danger");
    expect(menuItemClass({ inset: true })).toContain("pl-8");
    expect(menuChoiceItemClass({ nav: "keyboard" })).toContain(
      "data-[state=checked]:text-action",
    );
    expect(menuSubTriggerClass()).toContain("data-[state=open]:bg-surface-2");
  });
});

describe("collision-aware placement maths", () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { top: 100, left: 100, width: 120, height: 32 };
  const content = { width: 180, height: 200 };

  it("sits below the anchor when there is room", () => {
    const placed = resolveFloatingPlacement({ anchor, content, viewport });
    expect(placed).toMatchObject({ side: "bottom", align: "start", flipped: false, shifted: false });
    expect(placed.x).toBe(100);
    expect(placed.y).toBe(100 + 32 + OVERLAY_SIDE_OFFSET);
  });

  it("flips to the top when the bottom edge is near", () => {
    const nearBottom = { ...anchor, top: 740 };
    const placed = resolveFloatingPlacement({ anchor: nearBottom, content, viewport });
    expect(placed.side).toBe("top");
    expect(placed.flipped).toBe(true);
    expect(placed.y).toBe(740 - OVERLAY_SIDE_OFFSET - content.height);
  });

  it("flips right -> left near the right edge", () => {
    const nearRight = { top: 100, left: 900, width: 80, height: 32 };
    const placed = resolveFloatingPlacement({
      anchor: nearRight,
      content,
      viewport,
      side: "right",
    });
    expect(placed.side).toBe("left");
    expect(placed.flipped).toBe(true);
    expect(placed.x).toBe(900 - OVERLAY_SIDE_OFFSET - content.width);
  });

  it("stays put (and clamps) when neither side fits", () => {
    const tiny = { width: 1000, height: 100 };
    const placed = resolveFloatingPlacement({
      anchor: { top: 10, left: 100, width: 120, height: 32 },
      content,
      viewport: tiny,
    });
    expect(placed.side).toBe("bottom");
    expect(placed.flipped).toBe(false);
    expect(placed.shifted).toBe(true);
    expect(placed.y).toBe(OVERLAY_COLLISION_PADDING);
  });

  it("counts the collision padding when deciding to flip", () => {
    const anchor2 = { top: 700, left: 100, width: 120, height: 32 };
    const small = { width: 180, height: 60 };
    expect(
      resolveFloatingPlacement({ anchor: anchor2, content: small, viewport, collisionPadding: 0 })
        .flipped,
    ).toBe(false);
    expect(
      resolveFloatingPlacement({
        anchor: anchor2,
        content: small,
        viewport,
        collisionPadding: OVERLAY_COLLISION_PADDING,
      }).flipped,
    ).toBe(true);
  });

  it("aligns on the cross axis and shifts back into view", () => {
    const small = { width: 100, height: 40 };
    expect(resolveFloatingPlacement({ anchor, content: small, viewport, align: "center" }).x).toBe(
      100 + (120 - 100) / 2,
    );
    expect(resolveFloatingPlacement({ anchor, content: small, viewport, align: "end" }).x).toBe(
      220 - 100,
    );
    const shoved = resolveFloatingPlacement({
      anchor: { top: 100, left: 950, width: 40, height: 32 },
      content,
      viewport,
    });
    expect(shoved.x).toBe(viewport.width - OVERLAY_COLLISION_PADDING - content.width);
    expect(shoved.shifted).toBe(true);
  });

  it("opposes every side", () => {
    expect(OPPOSITE_SIDE).toEqual({
      top: "bottom",
      bottom: "top",
      left: "right",
      right: "left",
    });
  });
});

/* ------------------------------------------------------------------ render */

function renderDropdown({
  open,
  defaultNav = "pointer",
}: {
  open: boolean;
  defaultNav?: "pointer" | "keyboard";
}) {
  const tree = React.createElement(
    DropdownMenu,
    { open },
    React.createElement(
      DropdownMenuContentImpl,
      { forceMount: true, defaultNav },
      React.createElement(DropdownMenuLabel, null, "Actions"),
      React.createElement(DropdownMenuItem, null, "Copy link"),
      React.createElement(DropdownMenuItem, { disabled: true }, "Disabled"),
      React.createElement(DropdownMenuCheckboxItem, { checked: true }, "Selected"),
      React.createElement(DropdownMenuSeparator),
      React.createElement(
        DropdownMenuSub,
        null,
        React.createElement(DropdownMenuSubTrigger, null, "More"),
        React.createElement(
          DropdownMenuSubContentImpl,
          { forceMount: true },
          React.createElement(DropdownMenuItem, null, "Nested"),
        ),
      ),
    ),
  );
  return renderToStaticMarkup(tree);
}

describe("renderToStaticMarkup — dropdown menu in each state", () => {
  it("renders an open menu with the shared chrome, layering and rise", () => {
    const html = renderDropdown({ open: true });
    expect(html).toContain('data-state="open"');
    expect(html).toContain("surface-raised");
    expect(html).toContain("data-[state=open]:animate-rise");
    expect(html).toContain("data-[state=closed]:animate-rise");
    expect(html).toContain("[animation-direction:reverse]");
    expect(html).toContain(`z-index:${50}`);
    expect(html).toContain(MENU_SURFACE_CLASS.split(" ")[1]);
  });

  it("renders the closed state Radix flips to before unmounting", () => {
    const html = renderDropdown({ open: false });
    expect(html).toContain('data-state="closed"');
    expect(html).toContain("data-[state=closed]:animate-rise");
  });

  it("marks the pointer hover and never disables transitions for it", () => {
    const html = renderDropdown({ open: true, defaultNav: "pointer" });
    expect(html).toContain("data-[highlighted]:bg-surface-2");
    expect(html).not.toContain("u-no-transition");
  });

  it("marks the keyboard highlight and suppresses the transition", () => {
    const html = renderDropdown({ open: true, defaultNav: "keyboard" });
    expect(html).toContain("u-no-transition");
    expect(html).toContain("data-[highlighted]:bg-selection-soft");
    expect(html).not.toContain("data-[highlighted]:bg-surface-2");
  });

  it("renders disabled and selected items with their state hooks", () => {
    const html = renderDropdown({ open: true });
    expect(html).toContain("data-disabled");
    expect(html).toContain("data-[disabled]:opacity-50");
    expect(html).toContain('data-state="checked"');
    expect(html).toContain("data-[state=checked]:text-action");
    expect(html).toContain("<svg"); // the Check marker
    expect(html).toContain(MENU_LABEL_CLASS);
    expect(html).toContain(MENU_SEPARATOR_CLASS);
  });

  it("animates a submenu with the same rise", () => {
    const html = renderDropdown({ open: true });
    // Two surfaces (main + nested) both carry the rise.
    expect(html.match(/data-\[state=open\]:animate-rise/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("min-w-[180px]");
  });
});

describe("renderToStaticMarkup — popover and context menu share the chrome", () => {
  it("popover rises at the popover layer on a raised surface", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Popover,
        { open: true },
        React.createElement(
          PopoverContentImpl,
          { forceMount: true },
          React.createElement("div", null, "body"),
        ),
      ),
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain("surface-raised");
    expect(html).toContain("data-[state=open]:animate-rise");
    expect(html).toContain(`z-index:${50}`);
    expect(html).toContain("w-72");
  });

  it("context menu rises at the popover layer and uses the danger token", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ContextMenu,
        { open: true },
        React.createElement(
          ContextMenuContentImpl,
          { forceMount: true },
          React.createElement(ContextMenuItem, { destructive: true }, "Delete"),
        ),
      ),
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain("surface-raised");
    expect(html).toContain("data-[state=open]:animate-rise");
    expect(html).toContain(`z-index:${50}`);
    expect(html).toContain("text-danger");
    expect(html).not.toContain("text-red-500");
  });
});

/* ------------------------------------------------------------------- guard */

describe("tokens-only guard across the four overlays", () => {
  const files = ["dropdown-menu.tsx", "popover.tsx", "dialog.tsx", "context-menu.tsx"] as const;
  const source = (file: (typeof files)[number]) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  it.each(files)("%s has no raw hex, magic z-index or ad-hoc motion", (file) => {
    const src = source(file);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\bz-50\b|\bz-\[\d/);
    expect(src).not.toContain("animate-in");
    expect(src).not.toContain("animate-out");
    expect(src).not.toMatch(/transition[^;]*\d+ms/);
  });

  it("layers each overlay from the Z token", () => {
    expect(source("dropdown-menu.tsx")).toContain("Z.popover");
    expect(source("context-menu.tsx")).toContain("Z.popover");
    expect(source("popover.tsx")).toContain("Z.popover");
    expect(source("dialog.tsx")).toContain("Z.overlay");
    expect(source("dialog.tsx")).toContain("Z.modal");
  });

  it("uses the shared raised surfaces and the overlay scrim token", () => {
    expect(source("dropdown-menu.tsx")).toContain("surface-raised");
    // The context menu reuses the shared chrome class rather than re-styling.
    expect(source("context-menu.tsx")).toContain("MENU_SURFACE_CLASS");
    expect(source("popover.tsx")).toContain("surface-raised");
    expect(source("dialog.tsx")).toContain("surface-raised-strong");
    expect(source("dialog.tsx")).toContain("bg-overlay");
  });
});
