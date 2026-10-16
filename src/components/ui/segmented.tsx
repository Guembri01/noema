"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Segmented control — a 2–6 way switch (equal-width segments, optional icons).
 *
 * Design-system contract (docs/DESIGN_SYSTEM.md):
 * - tokens only: `bg-surface-2`, `bg-bg`, `text-fg`, `text-muted`,
 *   `.focus-ring`, `shadow-1`.
 * - the selected indicator is an absolutely positioned pill that slides between
 *   segments with `--dur-2` + `--ease-spring` — it is out of flow, so the track
 *   never shifts; reduced motion neutralises the slide globally.
 * - roving tabindex: exactly one segment is a tab stop; arrows rotate the
 *   selection (skipping disabled segments), Home/End jump to the ends.
 */

export const SEGMENTED_MIN = 2;
export const SEGMENTED_MAX = 6;

export type SegmentedOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Accessible name when the label is not descriptive enough on its own. */
  ariaLabel?: string;
  disabled?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Pure maths                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp an index into `[0, count - 1]`. */
export function clampSegmentIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Rotate `delta` segments from `index`, wrapping around the ends. This is the
 * "roving" core: it is what makes `End → start` and `start → End` reachable.
 */
export function nextSegmentIndex(
  index: number,
  count: number,
  delta: number,
  wrap = true,
): number {
  if (count <= 0) return 0;
  if (count === 1) return 0;
  const start = clampSegmentIndex(index, count);
  const raw = start + delta;
  if (!wrap) return clampSegmentIndex(raw, count);
  return ((raw % count) + count) % count;
}

/** Guard the documented 2–6 option contract. */
export function isValidSegmentCount(count: number): boolean {
  return Number.isInteger(count) && count >= SEGMENTED_MIN && count <= SEGMENTED_MAX;
}

/**
 * Map a key to the next selected index, skipping disabled segments.
 * Returns `null` for keys the control does not handle.
 */
export function resolveSegmentKey(
  count: number,
  index: number,
  key: string,
  isDisabled: (i: number) => boolean = () => false,
): number | null {
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;

  if (step !== 0 && count > 0) {
    let next = clampSegmentIndex(index, count);
    for (let i = 0; i < count; i += 1) {
      next = nextSegmentIndex(next, count, step);
      if (!isDisabled(next)) return next;
    }
    return clampSegmentIndex(index, count);
  }

  if (key === "Home") {
    for (let i = 0; i < count; i += 1) if (!isDisabled(i)) return i;
    return 0;
  }

  if (key === "End") {
    for (let i = count - 1; i >= 0; i -= 1) if (!isDisabled(i)) return i;
    return Math.max(0, count - 1);
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export type SegmentedProps<T extends string = string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  size?: "sm" | "md";
  className?: string;
};

export function Segmented<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  ariaLabel,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const count = options.length;
  const firstEnabled = options.findIndex((o) => !o.disabled);

  const [internal, setInternal] = React.useState<T | undefined>(
    () =>
      defaultValue ??
      (firstEnabled >= 0 ? options[firstEnabled].value : options[0]?.value),
  );
  const selected = value ?? internal;

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === selected),
  );

  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const select = React.useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled || disabled) return;
      if (value === undefined) setInternal(option.value);
      onValueChange?.(option.value);
    },
    [options, value, onValueChange, disabled],
  );

  const onKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (disabled) return;
    const next = resolveSegmentKey(
      count,
      index,
      e.key,
      (i) => Boolean(options[i]?.disabled),
    );
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    select(next);
  };

  const sizeClass =
    size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm";

  const segmentWidth = count > 0 ? 100 / count : 100;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-testid="segmented"
      data-count={count}
      className={cn(
        "relative inline-flex rounded-md bg-surface-2 p-0.5",
        disabled && "opacity-50",
        className,
      )}
    >
      <div className="relative flex w-full">
        <span
          aria-hidden="true"
          data-testid="segmented-indicator"
          className="absolute inset-y-0 rounded-sm border border-border bg-bg shadow-1"
          style={{
            insetInlineStart: `${selectedIndex * segmentWidth}%`,
            inlineSize: `${segmentWidth}%`,
            transitionProperty: "inset-inline-start",
            transitionDuration: "var(--dur-2)",
            transitionTimingFunction: "var(--ease-spring)",
          }}
        />
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={option.ariaLabel ?? option.label}
              tabIndex={isSelected && !option.disabled ? 0 : -1}
              disabled={disabled || option.disabled}
              data-testid={`segmented-option-${option.value}`}
              data-index={index}
              onClick={() => select(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                "focus-ring relative z-10 inline-flex flex-1 basis-0 items-center justify-center gap-1.5 rounded-sm font-medium",
                "min-w-0 whitespace-nowrap",
                sizeClass,
                isSelected ? "text-fg" : "text-muted hover:text-fg",
                (disabled || option.disabled) &&
                  "cursor-not-allowed opacity-50",
              )}
            >
              {option.icon && (
                <span aria-hidden="true" className="inline-flex shrink-0">
                  {option.icon}
                </span>
              )}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
