import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Spinner — the compact `loading` indicator for buttons, drawers and async
 * panels (docs/DESIGN_SYSTEM.md §8).
 *
 * It paints in `currentColor` so it inherits the surrounding text token, and it
 * is `aria-hidden` by default: a spinner is decoration unless the parent gives
 * it a `label`, which promotes it to a `role="status"` live region.
 */

/** Rendered size in px per step (all on the 4px grid). */
export const SPINNER_SIZES = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
} as const;

export type SpinnerSize = keyof typeof SPINNER_SIZES;

/** size → square utility. Kept as a map so the node tests pin the contract. */
export const SPINNER_SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: "size-3",
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

/**
 * The accessibility contract, as data: no label ⇒ hidden from assistive tech;
 * a label ⇒ an exposed `status` region. Pure, so it is unit-testable without a
 * DOM.
 */
export function spinnerA11y(label?: string):
  | { role: "status"; "aria-label": string; "aria-hidden"?: undefined }
  | { role?: undefined; "aria-label"?: undefined; "aria-hidden": true } {
  return label
    ? { role: "status", "aria-label": label }
    : { "aria-hidden": true };
}

export interface SpinnerProps extends SVGProps<SVGSVGElement> {
  size?: SpinnerSize;
  /** Expose the spinner to assistive tech with this label. */
  label?: string;
}

/**
 * A two-arc ring, spinning with the framework motion primitive (neutralised
 * under `prefers-reduced-motion`).
 */
export function Spinner({
  size = "md",
  label,
  className,
  ...rest
}: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animate-spin shrink-0", SPINNER_SIZE_CLASS[size], className)}
      {...spinnerA11y(label)}
      {...rest}
    >
      <circle cx="12" cy="12" r="9" strokeWidth="3" className="stroke-current opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-current"
      />
    </svg>
  );
}
