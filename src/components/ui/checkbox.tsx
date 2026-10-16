"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Checkbox — the tri-state control used by settings rows, filters and cells.
 *
 * Contract (docs/DESIGN_SYSTEM.md §8–§10):
 *  - token-only colour/motion/shape (no raw hex, no ad-hoc duration/radius);
 *  - every state: default · hover · focus-visible · active · disabled · error;
 *  - `role="checkbox"` + `aria-checked="mixed"` for the indeterminate state, and
 *    Space toggles it (a native input inside the <label>);
 *  - one focus ring (`.focus-ring`) shared with switch/radio;
 *  - ≥44px touch target on coarse pointers, without growing the visual box;
 *  - no layout shift when the state changes (the glyph is an absolute overlay).
 */

export type CheckboxSize = "sm" | "md";

/**
 * `true` checked, `false` unchecked, `"indeterminate"` mixed — the same
 * vocabulary as the DOM `HTMLInputElement.indeterminate` flag.
 */
export type CheckboxState = boolean | "indeterminate";

/** The one focus ring (docs/DESIGN_SYSTEM.md §6, §8). Shared with switch/radio. */
export const FOCUS_RING = "focus-ring";

/**
 * 44px minimum hit area (docs/DESIGN_SYSTEM.md §9), scoped to coarse pointers so
 * dense desktop rows keep their compact height.
 */
export const TOUCH_TARGET =
  "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

/** `aria-checked` for the tri-state (`"mixed"` is the indeterminate value). */
export function checkboxAriaChecked(
  state: CheckboxState,
): "true" | "false" | "mixed" {
  if (state === "indeterminate") return "mixed";
  return state ? "true" : "false";
}

/** Canonical `data-state`, so tests and CSS read one name per state. */
export function checkboxDataState(
  state: CheckboxState,
): "checked" | "unchecked" | "indeterminate" {
  if (state === "indeterminate") return "indeterminate";
  return state ? "checked" : "unchecked";
}

export function isIndeterminate(state: CheckboxState): boolean {
  return state === "indeterminate";
}

/**
 * Space/click toggle. A mixed box becomes checked, never unchecked — native
 * checkboxes and Radix both clear the indeterminate flag on activation.
 */
export function nextCheckboxState(state: CheckboxState): boolean {
  return state !== true;
}

const BOX: Record<CheckboxSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
};

const GLYPH: Record<CheckboxSize, string> = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
};

export interface CheckboxProps {
  checked: CheckboxState;
  onCheckedChange?: (checked: boolean) => void;
  size?: CheckboxSize;
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** When set, the control is flagged invalid and the message renders below. */
  error?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  value?: string;
  className?: string;
  "aria-label"?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  size = "md",
  label,
  description,
  error,
  disabled = false,
  id,
  name,
  value,
  className,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  const generatedId = React.useId();
  const boxId = id ?? generatedId;
  const descriptionId = description ? `${boxId}-description` : undefined;
  const errorId = error ? `${boxId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") ||
    undefined;

  const mixed = isIndeterminate(checked);
  const on = checked === true;
  const filled = on || mixed;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={boxId}
        className={cn(
          "inline-flex items-start gap-2",
          TOUCH_TARGET,
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        )}
      >
        <span className={cn("relative inline-flex shrink-0", BOX[size])}>
          <input
            id={boxId}
            name={name}
            value={value}
            type="checkbox"
            role="checkbox"
            checked={on}
            disabled={disabled}
            data-state={checkboxDataState(checked)}
            aria-checked={checkboxAriaChecked(checked)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            aria-label={ariaLabel}
            onChange={(event) => onCheckedChange?.(event.target.checked)}
            className={cn(
              "m-0 h-full w-full appearance-none rounded-sm border u-colors outline-none",
              FOCUS_RING,
              filled ? "bg-accent" : "bg-bg",
              error
                ? "border-danger"
                : filled
                  ? "border-accent"
                  : "border-border-strong",
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 flex items-center justify-center text-accent-fg u-transform",
              filled ? "opacity-100" : "opacity-0",
            )}
          >
            {mixed ? (
              <Minus className={GLYPH[size]} strokeWidth={3} />
            ) : (
              <Check className={GLYPH[size]} strokeWidth={3} />
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
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
