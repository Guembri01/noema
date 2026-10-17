"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Stepper — a clamped numeric field with − / + affordances.
 *
 * Design-system contract (docs/DESIGN_SYSTEM.md):
 * - tokens only: `bg-surface-2`, `border-border`, `text-danger`,
 *   `.focus-ring`, `.u-interactive`, `rounded-md`.
 * - states: default / hover / focus-visible / active / disabled / invalid
 *   (danger ring + message below, wired by `aria-invalid` + `aria-describedby`).
 * - long-press repeat on the buttons (hold to accelerate); a native path stays
 *   available through the field's own arrow keys and the button `click`s.
 */

/* -------------------------------------------------------------------------- */
/* Pure maths                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp `value` into `[min, max]`. `undefined` bounds are open. */
export function clampNumber(
  value: number,
  min?: number,
  max?: number,
): number {
  if (!Number.isFinite(value)) return min ?? 0;
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

/** Number of decimal places in a step, capped so float steps stay sane. */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `"42"` → 42; `""`, whitespace and junk → null. */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Is this a usable, in-range value? */
export function isValidNumber(
  value: number | null,
  min?: number,
  max?: number,
): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/** One step from `value`, rounded to the step's precision and clamped. */
export function stepNumber(
  value: number,
  direction: 1 | -1,
  opts: { min?: number; max?: number; step?: number },
): number {
  const step = opts.step ?? 1;
  const decimals = stepDecimals(step);
  const next = roundTo(value + direction * step, decimals);
  return clampNumber(next, opts.min, opts.max);
}

/** Is this value below the lower bound or above the upper one? */
export function isOutOfRange(
  value: number,
  min?: number,
  max?: number,
): boolean {
  return (
    (min !== undefined && value < min) || (max !== undefined && value > max)
  );
}

/* -------------------------------------------------------------------------- */
/* Long-press repeat                                                           */
/* -------------------------------------------------------------------------- */

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

/**
 * Hold-to-repeat for the − / + buttons. Fires once immediately, then again
 * after a short delay and every interval while the pointer stays down. The
 * callback is read from a ref so the timers never capture a stale value.
 */
function useLongPressRepeat(
  onRepeat: (direction: 1 | -1) => void,
  disabled = false,
) {
  const cbRef = React.useRef(onRepeat);

  React.useEffect(() => {
    cbRef.current = onRepeat;
  });

  const timers = React.useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    repeat: ReturnType<typeof setInterval> | null;
  }>({ delay: null, repeat: null });

  const stop = React.useCallback(() => {
    if (timers.current.delay !== null) clearTimeout(timers.current.delay);
    if (timers.current.repeat !== null) clearInterval(timers.current.repeat);
    timers.current.delay = null;
    timers.current.repeat = null;
  }, []);

  React.useEffect(() => stop, [stop]);

  const start = React.useCallback(
    (direction: 1 | -1) => {
      if (disabled) return;
      stop();
      cbRef.current(direction);
      timers.current.delay = setTimeout(() => {
        timers.current.repeat = setInterval(
          () => cbRef.current(direction),
          REPEAT_INTERVAL_MS,
        );
      }, REPEAT_DELAY_MS);
    },
    [disabled, stop],
  );

  return { start, stop };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export type StepperProps = {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  errorMessage?: string;
  className?: string;
  inputClassName?: string;
  /** Accessible name for the field when no visible `label` is supplied. */
  "aria-label"?: string;
  /** id(s) of external labelling element(s), forwarded to the input. */
  "aria-labelledby"?: string;
  /** id(s) of external description element(s), merged with the error message. */
  "aria-describedby"?: string;
};

export function Stepper({
  value,
  defaultValue = 0,
  onValueChange,
  min,
  max,
  step = 1,
  unit,
  label,
  id,
  name,
  placeholder,
  disabled = false,
  invalid = false,
  errorMessage,
  className,
  inputClassName,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: StepperProps) {
  const clampWithBounds = React.useCallback(
    (n: number) => clampNumber(n, min, max),
    [min, max],
  );

  const [internal, setInternal] = React.useState(() =>
    clampNumber(defaultValue, min, max),
  );
  const current = value === undefined ? internal : clampNumber(value, min, max);

  const [text, setText] = React.useState(() => String(current));
  const [blurInvalid, setBlurInvalid] = React.useState(false);

  // Keep the field in sync when the value changes from the outside.
  React.useEffect(() => {
    setText(String(current));
  }, [current]);

  const showInvalid = invalid || blurInvalid;
  const message = errorMessage ?? "Enter a value within the allowed range.";

  const inputId = React.useId();
  const fieldId = id ?? inputId;
  const messageId = `${fieldId}-error`;
  const labelId = `${fieldId}-label`;

  const commit = React.useCallback(
    (next: number) => {
      const bounded = clampWithBounds(roundTo(next, stepDecimals(step)));
      if (value === undefined) setInternal(bounded);
      onValueChange?.(bounded);
    },
    [value, onValueChange, clampWithBounds, step],
  );

  const nudge = React.useCallback(
    (direction: 1 | -1) => {
      commit(stepNumber(current, direction, { min, max, step }));
    },
    [commit, current, min, max, step],
  );

  const { start, stop } = useLongPressRepeat(nudge, disabled);

  const atMin = min !== undefined && current <= min;
  const atMax = max !== undefined && current >= max;

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextText = e.target.value;
    setText(nextText);
    setBlurInvalid(false);
    const next = parseNumberInput(nextText);
    if (isValidNumber(next, min, max)) {
      const bounded = clampWithBounds(next as number);
      if (value === undefined) setInternal(bounded);
      onValueChange?.(bounded);
    }
  };

  const onInputBlur = () => {
    const next = parseNumberInput(text);
    if (isValidNumber(next, min, max)) {
      commit(next as number);
      setBlurInvalid(false);
    } else {
      // Keep the offending text so the user can correct it, but flag it.
      setBlurInvalid(true);
    }
  };

  const buttonClass = cn(
    "focus-ring u-interactive flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-fg",
    "hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50",
  );

  const pressHandlers = (direction: 1 | -1) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      start(direction);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // A keyboard activation arrives as a click with `detail === 0`; pointer
    // taps already stepped on pointerdown, so their click (detail >= 1) is left
    // alone to avoid a double step.
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0 && !disabled) nudge(direction);
    },
  });

  return (
    <div className={cn("w-full", className)} data-testid="stepper">
      {label && (
        <label
          id={labelId}
          htmlFor={fieldId}
          className="mb-1 block text-sm text-muted"
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-stretch gap-1",
          disabled && "opacity-50",
        )}
      >
        <button
          type="button"
          aria-label="Decrease"
          disabled={disabled || atMin}
          className={buttonClass}
          {...pressHandlers(-1)}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="relative flex-1">
          <input
            id={fieldId}
            name={name}
            type="text"
            inputMode="decimal"
            role="spinbutton"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={current}
            aria-label={ariaLabel ?? (label ? undefined : "Value")}
            aria-labelledby={ariaLabelledby ?? (label ? labelId : undefined)}
            aria-invalid={showInvalid || undefined}
            aria-describedby={
              [showInvalid ? messageId : undefined, ariaDescribedby]
                .filter(Boolean)
                .join(" ") || undefined
            }
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            onChange={onInputChange}
            onBlur={onInputBlur}
            className={cn(
              "focus-ring h-9 w-full rounded-md border bg-bg px-3 text-center text-sm tabular-nums text-fg outline-none",
              "placeholder:text-muted",
              showInvalid
                ? "border-danger focus:border-danger"
                : "border-border focus:border-accent",
              unit ? "pe-10" : undefined,
              inputClassName,
            )}
          />
          {unit && (
            <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted">
              {unit}
            </span>
          )}
        </div>

        <button
          type="button"
          aria-label="Increase"
          disabled={disabled || atMax}
          className={buttonClass}
          {...pressHandlers(1)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {showInvalid && (
        <p
          id={messageId}
          role="alert"
          className="mt-1 text-xs text-danger"
        >
          {message}
        </p>
      )}
    </div>
  );
}
