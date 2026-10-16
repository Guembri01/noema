"use client";

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import {
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
  MenuNavContext,
  type NavMode,
  OVERLAY_COLLISION_PADDING,
  menuItemClass,
  menuSubTriggerClass,
  navTransitionClass,
  overlayMotionClasses,
  useOverlayNav,
} from "@/components/ui/dropdown-menu";

/**
 * Right-click menus (Radix), styled to match `dropdown-menu.tsx`.
 * Used by the sidebar so every page / teamspace / discussion row has its
 * actions on right-click, not just behind a hover "…" button.
 *
 * Motion, chrome, item states and the keyboard-vs-pointer highlight all come
 * from the shared primitives in `dropdown-menu.tsx`, so a right-click menu
 * moves exactly like a dropdown.
 */

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

/** The surface itself, without the portal (see `DropdownMenuContentImpl`). */
export function ContextMenuContentImpl({
  className,
  style,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  defaultNav = "pointer",
  onKeyDown,
  onPointerMove,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  /** Initial highlight mode; the pointer/keyboard listeners take over live. */
  defaultNav?: NavMode;
}) {
  const { nav, onKeyDown: setKeyboard, onPointerMove: setPointer } = useOverlayNav(defaultNav);
  return (
    <MenuNavContext.Provider value={nav}>
      <ContextMenuPrimitive.Content
        avoidCollisions
        collisionPadding={collisionPadding}
        className={cn(
          MENU_SURFACE_CLASS,
          "min-w-[210px]",
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

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuContentImpl className={className} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  inset,
  destructive,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  destructive?: boolean;
}) {
  const nav = React.useContext(MenuNavContext);
  return (
    <ContextMenuPrimitive.Item
      className={cn(menuItemClass({ nav, inset, destructive }), className)}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  const nav = React.useContext(MenuNavContext);
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(menuSubTriggerClass({ nav, inset }), className)}
      {...props}
    >
      {children}
      <span className="ml-auto text-muted">›</span>
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContentImpl({
  className,
  style,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const nav = React.useContext(MenuNavContext);
  return (
    <ContextMenuPrimitive.SubContent
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

export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuSubContentImpl className={className} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      className={cn(MENU_LABEL_CLASS, className)}
      {...props}
    />
  );
}
