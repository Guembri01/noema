"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING, TOUCH_TARGET } from "./checkbox";

/**
 * Radio + RadioGroup — a single-choice group with `role="radiogroup"` and the
 * roving-tabindex keyboard pattern (Arrow keys move the selection, Home/End jump
 * to the ends).
 *
 * Contract (docs/DESIGN_SYSTEM.md §8–§10):
 *  - `role="radio"` + `aria-checked`; the group exposes `role="radiogroup"`;
 *  - exactly one radio is tabbable at a time (`tabIndex` 0 / -1);
 *  - one focus ring (`.focus-ring`) shared with checkbox/switch;
 *  - ≥44px touch target on coarse pointers; the dot scales, so no layout shift.
 */

export type RadioSize = "sm" | "md";

export type RadioNavKey =
  | "ArrowDown"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowLeft"
  | "Home"
  | "End";

/** `aria-checked` for a radio. */
export function radioAriaChecked(selected: boolean): "true" | "false" {
  return selected ? "true" : "false";
}

/** Roving tabindex: only the active radio is a Tab stop. */
export function radioTabIndex(active: boolean): 0 | -1 {
  return active ? 0 : -1;
}

/** Whether a key is one the group handles itself. */
export function isRadioNavKey(key: string): key is RadioNavKey {
  return (
    key === "ArrowDown" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowLeft" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * Next index for a roving-tabindex group. Arrow keys wrap; Home/End jump to the
 * ends. Returns -1 for an empty group so callers can bail out cleanly.
 */
export function nextRadioIndex(
  current: number,
  count: number,
  key: RadioNavKey,
): number {
  if (count <= 0) return -1;
  const index = ((current % count) + count) % count;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}

const CIRCLE: Record<RadioSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
};

const DOT: Record<RadioSize, string> = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
};

interface RadioGroupContextValue {
  value: string | undefined;
  activeValue: string | undefined;
  name: string | undefined;
  size: RadioSize;
  disabled: boolean;
  onValueChange: ((value: string) => void) | undefined;
  register: (value: string) => void;
  unregister: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(
  null,
);

export interface RadioGroupProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  size?: RadioSize;
  disabled?: boolean;
  label?: React.ReactNode;
  orientation?: "vertical" | "horizontal";
}

export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  name,
  size = "md",
  disabled = false,
  label,
  orientation = "vertical",
  className,
  children,
  ...rest
}: RadioGroupProps) {
  const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(
    defaultValue,
  );
  // Registration order lets an unselected group still expose one Tab stop.
  const [order, setOrder] = React.useState<string[]>(() => {
    const seed = value ?? defaultValue;
    return seed === undefined ? [] : [seed];
  });

  const current = value ?? uncontrolled;

  const register = React.useCallback((item: string) => {
    setOrder((prev) => (prev.includes(item) ? prev : [...prev, item]));
  }, []);
  const unregister = React.useCallback((item: string) => {
    setOrder((prev) => prev.filter((existing) => existing !== item));
  }, []);

  const handleChange = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const activeValue = current ?? order[0];

  const context = React.useMemo<RadioGroupContextValue>(
    () => ({
      value: current,
      activeValue,
      name,
      size,
      disabled,
      onValueChange: handleChange,
      register,
      unregister,
    }),
    [
      current,
      activeValue,
      name,
      size,
      disabled,
      handleChange,
      register,
      unregister,
    ],
  );

  const labelId = React.useId();

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isRadioNavKey(event.key)) return;
    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]:not([disabled])',
      ),
    );
    if (radios.length === 0) return;
    const target = event.target as HTMLElement | null;
    const source = target?.closest<HTMLButtonElement>('[role="radio"]') ?? null;
    const index = source ? radios.indexOf(source) : -1;
    if (index === -1) return;
    event.preventDefault();
    const next = radios[nextRadioIndex(index, radios.length, event.key)];
    if (!next) return;
    next.focus();
    const nextValue = next.dataset.value;
    if (nextValue !== undefined) handleChange(nextValue);
  };

  return (
    <div
      role="radiogroup"
      aria-orientation={orientation}
      aria-label={label ? undefined : rest["aria-label"]}
      aria-labelledby={label ? labelId : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "flex gap-2",
        orientation === "vertical" ? "flex-col" : "flex-row flex-wrap",
        className,
      )}
      {...rest}
    >
      {label && (
        <span id={labelId} className="text-sm font-medium text-fg">
          {label}
        </span>
      )}
      <RadioGroupContext.Provider value={context}>
        {children}
      </RadioGroupContext.Provider>
    </div>
  );
}

export interface RadioProps {
  value: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  size?: RadioSize;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function Radio({
  value,
  label,
  description,
  size,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
}: RadioProps) {
  const context = React.useContext(RadioGroupContext);
  const generatedId = React.useId();
  const radioId = id ?? generatedId;
  const descriptionId = description ? `${radioId}-description` : undefined;

  const selected = context?.value === value;
  const active = context ? context.activeValue === value : true;
  const resolvedSize = size ?? context?.size ?? "md";
  const isDisabled = disabled || (context?.disabled ?? false);

  const { register, unregister } = context ?? {};
  React.useEffect(() => {
    if (!register || !unregister) return;
    register(value);
    return () => unregister(value);
  }, [register, unregister, value]);

  return (
    <div className={cn("inline-flex items-start gap-2", className)}>
      <button
        type="button"
        role="radio"
        id={radioId}
        data-value={value}
        aria-checked={radioAriaChecked(selected)}
        aria-describedby={descriptionId}
        aria-label={ariaLabel}
        tabIndex={isDisabled ? -1 : radioTabIndex(active)}
        disabled={isDisabled}
        onClick={() => {
          if (!isDisabled) context?.onValueChange?.(value);
        }}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full u-colors outline-none",
          FOCUS_RING,
          TOUCH_TARGET,
          isDisabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center rounded-full border bg-bg u-colors",
            CIRCLE[resolvedSize],
            selected ? "border-action" : "border-control",
          )}
        >
          <span
            className={cn(
              "rounded-full bg-action transition-transform motion-reduce:transition-none",
              DOT[resolvedSize],
              selected ? "scale-100" : "scale-0",
            )}
          />
        </span>
      </button>
      {(label || description) && (
        <label
          htmlFor={radioId}
          className={cn(
            "grid gap-1",
            isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          )}
        >
          <span className="text-sm text-fg">{label}</span>
          {description && (
            <span id={descriptionId} className="text-xs text-muted">
              {description}
            </span>
          )}
        </label>
      )}
    </div>
  );
}
