"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded bg-fg px-2 py-1 text-xs font-medium text-bg shadow-md",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** Convenience wrapper: <Tooltip label="Bold"><button/></Tooltip> */
export function Tooltip({
  label,
  children,
  side = "bottom",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const text = typeof label === "string" ? label : undefined;
  const child =
    text && React.isValidElement(children) &&
    !(children as React.ReactElement<Record<string, unknown>>).props["aria-label"]
      ? React.cloneElement(
          children as React.ReactElement<{ "aria-label"?: string }>,
          { "aria-label": text },
        )
      : children;
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{child}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </TooltipRoot>
  );
}
