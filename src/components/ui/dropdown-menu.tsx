"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";

/* ==========================================================================
 * Shared overlay primitives
 *
 * The single source of truth for how every overlay in the app moves and
 * layers. `popover.tsx`, `context-menu.tsx` and `dialog.tsx` import these so
 * a menu, a popover, a context menu and a dialog are indistinguishable in
 * feel (docs/DESIGN_SYSTEM.md §6 motion, §7 layering). Everything here is pure
 * so the node tests can pin it without a browser.
 * ======================================================================== */

/** The overlay families the motion vocabulary knows about. */
export type OverlayKind = "menu" | "dialog" | "scrim";

/** Radix drives all three through the `data-state` attribute. */
export type OverlayState = "open" | "closed";

/** Which input device currently owns a menu highlight. */
export type NavMode = "pointer" | "keyboard";

/** Breathing room kept between a floating surface and the viewport edge. */
export const OVERLAY_COLLISION_PADDING = 8;
/** Default gap between a trigger and the surface it opens. */
export const OVERLAY_SIDE_OFFSET = 6;

/**
 * Enter/exit classes for an overlay surface.
 *
 * A menu rises + fades (`animate-rise`, 4 px), a dialog scales
 * (`animate-scale-in`, 0.98 -> 1) and a scrim just fades (`animate-fade`).
 * The exit replays the same keyframe with `animation-direction: reverse`, so
 * the motion mirrors exactly, and a dialog shortens from `--dur-2` on the way
 * in to `--dur-1` on the way out. Keyed off `data-state`, so no JavaScript
 * drives the transition and reduced-motion keeps working.
 *
 * The strings are written out in full (not interpolated) so Tailwind's
 * scanner can see every class it must emit.
 */
const OVERLAY_MOTION: Record<OverlayKind, Record<OverlayState, string>> = {
  menu: {
    open: "data-[state=open]:animate-rise data-[state=open]:[animation-duration:var(--dur-1)]",
    closed:
      "data-[state=closed]:animate-rise data-[state=closed]:[animation-duration:var(--dur-1)] data-[state=closed]:[animation-direction:reverse]",
  },
  dialog: {
    open: "data-[state=open]:animate-scale-in data-[state=open]:[animation-duration:var(--dur-2)]",
    closed:
      "data-[state=closed]:animate-scale-in data-[state=closed]:[animation-duration:var(--dur-1)] data-[state=closed]:[animation-direction:reverse]",
  },
  scrim: {
    open: "data-[state=open]:animate-fade data-[state=open]:[animation-duration:var(--dur-1)]",
    closed:
      "data-[state=closed]:animate-fade data-[state=closed]:[animation-duration:var(--dur-1)] data-[state=closed]:[animation-direction:reverse]",
  },
};

export function overlayMotionClass(kind: OverlayKind, state: OverlayState): string {
  return OVERLAY_MOTION[kind][state];
}

/** Both variants (open + closed), ready to drop on a Radix surface. */
export function overlayMotionClasses(kind: OverlayKind): string {
  return `${overlayMotionClass(kind, "open")} ${overlayMotionClass(kind, "closed")}`;
}

/* ---- Menu chrome (shared by the dropdown and the context menu) ---------- */

export const MENU_SURFACE_CLASS = "surface-raised overflow-hidden p-1 text-sm text-fg";
export const MENU_LABEL_CLASS = "px-2 py-1.5 text-xs font-medium text-muted";
export const MENU_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-border";

const MENU_ITEM_BASE =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none u-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/**
 * The two highlights are deliberately different: a pointer hover uses the
 * neutral surface, while a keyboard highlight is accent-tinted so the two are
 * never confused. The surface also drops its colour transitions while the
 * keyboard is driving (see {@link navTransitionClass}).
 */
function highlightClass(nav: NavMode): string {
  return nav === "keyboard"
    ? "data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent"
    : "data-[highlighted]:bg-surface-2";
}

/** Disable colour transitions while the user is keyboard-navigating at speed. */
export function navTransitionClass(nav: NavMode): string {
  return nav === "keyboard" ? "u-no-transition" : "";
}

export interface MenuItemClassOptions {
  nav?: NavMode;
  inset?: boolean;
  destructive?: boolean;
}

export function menuItemClass({
  nav = "pointer",
  inset,
  destructive,
}: MenuItemClassOptions = {}): string {
  return cn(
    MENU_ITEM_BASE,
    highlightClass(nav),
    destructive && "text-danger",
    inset && "pl-8",
  );
}

export function menuChoiceItemClass({ nav = "pointer" }: { nav?: NavMode } = {}): string {
  return cn(
    "relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none u-colors",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    "data-[state=checked]:text-accent",
    highlightClass(nav),
  );
}

export function menuSubTriggerClass({
  nav = "pointer",
  inset,
}: { nav?: NavMode; inset?: boolean } = {}): string {
  return cn(
    MENU_ITEM_BASE,
    highlightClass(nav),
    "data-[state=open]:bg-surface-2",
    inset && "pl-8",
  );
}

/** React context carrying the current nav mode down to menu items. */
export const MenuNavContext = React.createContext<NavMode>("pointer");

/** Track pointer-vs-keyboard navigation for one menu surface. */
export function useOverlayNav(initial: NavMode = "pointer"): {
  nav: NavMode;
  onKeyDown: () => void;
  onPointerMove: () => void;
} {
  const [nav, setNav] = React.useState<NavMode>(initial);
  const onKeyDown = React.useCallback(() => setNav("keyboard"), []);
  const onPointerMove = React.useCallback(() => setNav("pointer"), []);
  return { nav, onKeyDown, onPointerMove };
}

/* ---- Collision-aware placement ----------------------------------------- *
 * Radix's popper performs the runtime flip (`avoidCollisions`), using the
 * same thresholds pinned here. `resolveFloatingPlacement` is the DOM-free
 * spec of that behaviour: prefer a side, flip to the opposite one when the
 * preferred side cannot fit and the opposite side is roomier, then shift
 * along the cross axis to stay inside the collision padding.
 * ------------------------------------------------------------------------ */

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface PlacementInput {
  anchor: RectLike;
  content: SizeLike;
  viewport: SizeLike;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
}

export interface Placement {
  side: Side;
  align: Align;
  /** The surface was moved to the opposite side of the anchor. */
  flipped: boolean;
  /** The surface was nudged along the cross axis to stay in view. */
  shifted: boolean;
  x: number;
  y: number;
}

export const OPPOSITE_SIDE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function spaceOn(
  side: Side,
  anchor: RectLike,
  viewport: SizeLike,
  sideOffset: number,
  padding: number,
): number {
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  switch (side) {
    case "bottom":
      return viewport.height - bottom - sideOffset - padding;
    case "top":
      return anchor.top - sideOffset - padding;
    case "right":
      return viewport.width - right - sideOffset - padding;
    case "left":
      return anchor.left - sideOffset - padding;
  }
}

export function resolveFloatingPlacement(input: PlacementInput): Placement {
  const pad = input.collisionPadding ?? OVERLAY_COLLISION_PADDING;
  const sideOffset = input.sideOffset ?? OVERLAY_SIDE_OFFSET;
  const alignOffset = input.alignOffset ?? 0;
  const align = input.align ?? "start";
  const preferredSide = input.side ?? "bottom";
  const right = input.anchor.left + input.anchor.width;
  const bottom = input.anchor.top + input.anchor.height;
  const vertical = preferredSide === "top" || preferredSide === "bottom";

  let side = preferredSide;
  const contentMain = vertical ? input.content.height : input.content.width;
  const opposite = OPPOSITE_SIDE[side];
  const preferredSpace = spaceOn(side, input.anchor, input.viewport, sideOffset, pad);
  const oppositeSpace = spaceOn(opposite, input.anchor, input.viewport, sideOffset, pad);
  let flipped = false;
  if (contentMain > preferredSpace && oppositeSpace > preferredSpace) {
    side = opposite;
    flipped = true;
  }

  let x: number;
  let y: number;
  if (side === "bottom" || side === "top") {
    if (align === "start") x = input.anchor.left;
    else if (align === "end") x = right - input.content.width;
    else x = input.anchor.left + (input.anchor.width - input.content.width) / 2;
    x += alignOffset;
    y = side === "bottom" ? bottom + sideOffset : input.anchor.top - sideOffset - input.content.height;
  } else {
    if (align === "start") y = input.anchor.top;
    else if (align === "end") y = bottom - input.content.height;
    else y = input.anchor.top + (input.anchor.height - input.content.height) / 2;
    y += alignOffset;
    x = side === "right" ? right + sideOffset : input.anchor.left - sideOffset - input.content.width;
  }

  const rawX = x;
  const rawY = y;
  x = clamp(x, pad, input.viewport.width - pad - input.content.width);
  y = clamp(y, pad, input.viewport.height - pad - input.content.height);
  return { side, align, flipped, shifted: x !== rawX || y !== rawY, x, y };
}

/* ==========================================================================
 * Dropdown menu
 * ======================================================================== */

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * The surface itself, without the portal. Exported so tests (and non-portal
 * surfaces) can render it with `renderToStaticMarkup`.
 */
export function DropdownMenuContentImpl({
  className,
  style,
  sideOffset = OVERLAY_SIDE_OFFSET,
  align = "start",
  collisionPadding = OVERLAY_COLLISION_PADDING,
  defaultNav = "pointer",
  onKeyDown,
  onPointerMove,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /** Initial highlight mode; the pointer/keyboard listeners take over live. */
  defaultNav?: NavMode;
}) {
  const { nav, onKeyDown: setKeyboard, onPointerMove: setPointer } = useOverlayNav(defaultNav);
  return (
    <MenuNavContext.Provider value={nav}>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        avoidCollisions
        collisionPadding={collisionPadding}
        className={cn(
          MENU_SURFACE_CLASS,
          "min-w-[200px]",
          overlayMotionClasses("menu"),
          navTransitionClass(nav),
          className,
        )}
        style={{ zIndex: Z.popover, ...style }}
        onKeyDown={(event) => {
          setKeyboard();
          onKeyDown?.(event);
        }}
        onPointerMove={(event) => {
          setPointer();
          onPointerMove?.(event);
        }}
        {...props}
      />
    </MenuNavContext.Provider>
  );
}

export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuContentImpl className={className} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  const nav = React.useContext(MenuNavContext);
  return (
    <DropdownMenuPrimitive.Item
      className={cn(menuItemClass({ nav, inset }), className)}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  const nav = React.useContext(MenuNavContext);
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(menuChoiceItemClass({ nav }), className)}
      {...props}
    >
      <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
        {checked ? <Check className="h-3.5 w-3.5" /> : null}
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(MENU_LABEL_CLASS, className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  const nav = React.useContext(MenuNavContext);
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(menuSubTriggerClass({ nav, inset }), className)}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContentImpl({
  className,
  style,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const nav = React.useContext(MenuNavContext);
  return (
    <DropdownMenuPrimitive.SubContent
      avoidCollisions
      collisionPadding={collisionPadding}
      className={cn(
        MENU_SURFACE_CLASS,
        "min-w-[180px]",
        overlayMotionClasses("menu"),
        navTransitionClass(nav),
        className,
      )}
      style={{ zIndex: Z.popover, ...style }}
      {...props}
    />
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuSubContentImpl className={className} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}
