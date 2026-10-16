"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import {
  OVERLAY_COLLISION_PADDING,
  OVERLAY_SIDE_OFFSET,
  overlayMotionClasses,
} from "@/components/ui/dropdown-menu";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContentImpl({
  className,
  style,
  align = "start",
  sideOffset = OVERLAY_SIDE_OFFSET,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      avoidCollisions
      collisionPadding={collisionPadding}
      className={cn(
        "surface-raised w-72 p-3 text-sm text-fg outline-none",
        overlayMotionClasses("menu"),
        className,
      )}
      style={{ zIndex: Z.popover, ...style }}
      {...props}
    />
  );
}

export function PopoverContent({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverContentImpl className={className} {...props} />
    </PopoverPrimitive.Portal>
  );
}
