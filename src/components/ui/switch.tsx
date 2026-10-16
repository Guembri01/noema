"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SHADOW } from "@/lib/design-tokens";
import { FOCUS_RING, TOUCH_TARGET } from "./checkbox";

/**
 * Switch — an on/off toggle with an optimistic (in-flight) state.
 *
 * Contract (docs/DESIGN_SYSTEM.md §6, §8–§10):
 *  - `role="switch"` + `aria-checked`;
 *  - the thumb slides on `--dur-2` (180ms) with `--ease-spring`, and the global
 *    `prefers-reduced-motion` rule neutralises it (plus `motion-reduce:` here);
 *  - while a change is `pending` the control shows the optimistic value, marks
 *    `aria-busy`, and refuses a second activation until it settles;
 *  - one focus ring (`.focus-ring`) shared with checkbox/radio;
 *  - ≥44px touch target on coarse pointers; no layout shift on state change.
 */

export type SwitchSize = "sm" | "md";

/** `aria-checked` for an ARIA switch. */
export function switchAriaChecked(checked: boolean): "true" | "false" {
  return checked ? "true" : "false";
}

/** Canonical `data-state`. */
export function switchDataState(checked: boolean): "checked" | "unchecked" {
  return checked ? "checked" : "unchecked";
}

/** `aria-busy` while an optimistic change is in flight, otherwise omitted. */
export function switchAriaBusy(pending: boolean): true | undefined {
  return pending ? true : undefined;
}

/** A pending toggle blocks a second activation until the change settles. */
export function switchInteractive(disabled: boolean, pending: boolean): boolean {
  return !disabled && !pending;
}

const TRACK: Record<SwitchSize, string> = {
  sm: "h-5 w-9",
  md: "h-6 w-11",
};

const THUMB: Record<SwitchSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
};

const THUMB_SHIFT: Record<SwitchSize, string> = {
  sm: "translate-x-4",
  md: "translate-x-5",
};

const SPINNER: Record<SwitchSize, string> = {
  sm: "h-2.5 w-2.5",
  md: "h-3 w-3",
};

/** 180ms `--dur-2` + `--ease-spring`, from the token layer (motion rule §2). */
const THUMB_MOTION: React.CSSProperties = {
  transitionDuration: "var(--dur-2)",
  transitionTimingFunction: "var(--ease-spring)",
  boxShadow: SHADOW.raised,
};

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** An optimistic change is in flight: keep the target value, mark busy. */
  pending?: boolean;
  size?: SwitchSize;
  label?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  value?: string;
  className?: string;
  "aria-label"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  pending = false,
  size = "md",
  label,
  description,
  disabled = false,
  id,
  name,
  value,
  className,
  "aria-label": ariaLabel,
}: SwitchProps) {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  const descriptionId = description ? `${switchId}-description` : undefined;
  const interactive = switchInteractive(disabled, pending);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={switchId}
        className={cn(
          "inline-flex items-start gap-2",
          TOUCH_TARGET,
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        )}
      >
        <span className={cn("relative inline-flex shrink-0", TRACK[size])}>
          <input
            id={switchId}
            name={name}
            value={value}
            type="checkbox"
            role="switch"
            checked={checked}
            disabled={!interactive}
            data-state={switchDataState(checked)}
            aria-checked={switchAriaChecked(checked)}
            aria-busy={switchAriaBusy(pending)}
            aria-describedby={descriptionId}
            aria-label={ariaLabel}
            onChange={(event) => onCheckedChange?.(event.target.checked)}
            className={cn(
              "m-0 h-full w-full appearance-none rounded-full border u-colors outline-none",
              FOCUS_RING,
              checked
                ? "border-accent bg-accent"
                : "border-border-strong bg-surface-3",
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-center",
              "rounded-full bg-bg transition-transform motion-reduce:transition-none",
              THUMB[size],
              checked ? THUMB_SHIFT[size] : "translate-x-0",
            )}
            style={THUMB_MOTION}
          >
            {pending && (
              <Loader2
                className={cn("animate-spin text-muted", SPINNER[size])}
              />
            )}
          </span>
        </span>
        {(label || description) && (
          <span className="grid min-w-0 gap-1">
            {label && <span className="text-sm text-fg">{label}</span>}
            {description && (
              <span id={descriptionId} className="text-xs text-muted">
                {description}
              </span>
            )}
          </span>
        )}
      </label>
    </div>
  );
}
