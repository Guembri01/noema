"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Slider — single value plus a dual-thumb range variant.
 *
 * Design-system contract (docs/DESIGN_SYSTEM.md):
 * - colour/shape/motion only from tokens (`bg-surface-2`, `bg-action`,
 *   `--dur-2`, `--ease-spring`, `.focus-ring`, `shadow-1`).
 * - dragging is 1:1: the root carries `.u-no-transition` for the duration of a
 *   drag so the thumb never lags the cursor; on release it regains the spring
 *   transition and settles onto the nearest step.
 * - reduced motion is honoured globally (the spring is neutralised for free).
 *
 * All geometry lives in the pure helpers below so the maths can be pinned by
 * node tests without a DOM.
 */

/* -------------------------------------------------------------------------- */
/* Pure maths                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp `value` into `[min, max]`; NaN collapses to the low bound. */
export function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
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

/** Snap `value` onto the `min + n * step` lattice. */
export function snapToStep(value: number, min: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const snapped = min + Math.round((value - min) / step) * step;
  return roundTo(snapped, stepDecimals(step));
}

/** `value` → 0..100 track percent. A degenerate range reads as 0. */
export function percentFromValue(
  value: number,
  min: number,
  max: number,
): number {
  if (max === min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

/**
 * Track percent → value. `snap: false` keeps the raw position (used while the
 * pointer is down so the thumb tracks 1:1); the default snaps to the step.
 */
export function valueFromPercent(
  percent: number,
  min: number,
  max: number,
  step: number,
  snap = true,
): number {
  const raw = min + (clamp(percent, 0, 100) / 100) * (max - min);
  return snap ? clamp(snapToStep(raw, min, step), min, max) : clamp(raw, min, max);
}

export type KeyMove =
  | { kind: "delta"; amount: number }
  | { kind: "bound"; bound: "min" | "max" };

/**
 * Keyboard → intent. Arrows move one step, Shift multiplies by ten, PageUp /
 * PageDown move ten steps, Home / End jump to a bound.
 */
export function keyMove(key: string, shift: boolean, step: number): KeyMove | null {
  const big = shift ? 10 : 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return { kind: "delta", amount: step * big };
    case "ArrowLeft":
    case "ArrowDown":
      return { kind: "delta", amount: -step * big };
    case "PageUp":
      return { kind: "delta", amount: step * 10 };
    case "PageDown":
      return { kind: "delta", amount: -step * 10 };
    case "Home":
      return { kind: "bound", bound: "min" };
    case "End":
      return { kind: "bound", bound: "max" };
    default:
      return null;
  }
}

/** Apply a key to a value; `null` when the key is not a slider key. */
export function applyKeyMove(
  value: number,
  key: string,
  opts: { min: number; max: number; step: number; shift: boolean },
): number | null {
  const move = keyMove(key, opts.shift, opts.step);
  if (!move) return null;
  if (move.kind === "bound") return move.bound === "min" ? opts.min : opts.max;
  return clamp(snapToStep(value + move.amount, opts.min, opts.step), opts.min, opts.max);
}

export type Range = [number, number];

/** Normalise an arbitrary pair into ascending order. */
export function orderRange(a: number, b: number): Range {
  return a <= b ? [a, b] : [b, a];
}

/** Which thumb a pointer value is nearer to (ties favour the low thumb). */
export function nearestThumbIndex(value: number, range: Range): 0 | 1 {
  const [lo, hi] = orderRange(range[0], range[1]);
  return Math.abs(value - lo) <= Math.abs(value - hi) ? 0 : 1;
}

/**
 * Move one range thumb to `next`, keeping the pair ordered (the dragged thumb
 * stops against its sibling rather than crossing it on commit).
 */
export function setRangeThumb(
  range: Range,
  index: 0 | 1,
  next: number,
  opts: { min: number; max: number; step: number },
): Range {
  const [lo, hi] = orderRange(range[0], range[1]);
  const v = clamp(snapToStep(next, opts.min, opts.step), opts.min, opts.max);
  return index === 0 ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)];
}

/** A label for a value: `"30"` or `"30 px"`. */
export function formatSliderValue(value: number, unit?: string): string {
  return unit ? `${value} ${unit}` : String(value);
}

/** Tick values for `min..max` by `step`; empty when it would be absurd. */
export function tickValues(
  min: number,
  max: number,
  step: number,
  limit = 51,
): number[] {
  if (!Number.isFinite(step) || step <= 0 || max <= min) return [];
  const count = Math.floor((max - min) / step + 1e-9) + 1;
  if (count > limit) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(roundTo(min + i * step, stepDecimals(step)));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** Pointer x → 0..100, respecting the element's writing direction. */
function percentFromClientX(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const rtl = window.getComputedStyle(el).direction === "rtl";
  const ratio = rtl
    ? (rect.right - clientX) / rect.width
    : (clientX - rect.left) / rect.width;
  return clamp(ratio * 100, 0, 100);
}

/** Presentational thumb. Keyboard handling stays with the owning component. */
function Thumb({
  value,
  min,
  max,
  step,
  label,
  valueText,
  disabled,
  onKeyDown,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  valueText: string;
  disabled: boolean;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const pct = percentFromValue(value, min, max);
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      data-testid="slider-thumb"
      onKeyDown={onKeyDown}
      className={cn(
        "focus-ring absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-border-strong bg-bg shadow-1",
        !disabled && "hover:border-action",
      )}
      style={{
        // Logical offset: `inset-inline-start` flips for RTL on its own, and
        // subtracting half the thumb keeps its centre on the value.
        insetInlineStart: `calc(${pct}% - 0.5rem)`,
        transitionProperty: "inset-inline-start",
        transitionDuration: "var(--dur-2)",
        transitionTimingFunction: "var(--ease-spring)",
      }}
      data-step={step}
    />
  );
}

/** Shared track chrome: rail, fill, ticks. Thumbs are passed as children. */
function Track({
  fillStart,
  fillSize,
  ticks,
  disabled,
  children,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  fillStart: number;
  fillSize: number;
  ticks: number[];
  disabled: boolean;
  children: React.ReactNode;
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onPointerMove: React.PointerEventHandler<HTMLDivElement>;
  onPointerUp: React.PointerEventHandler<HTMLDivElement>;
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <div className="px-2">
      <div
        data-testid="slider-track"
        className={cn(
          "relative h-1.5 w-full touch-none rounded-full bg-surface-2",
          !disabled && "cursor-pointer",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          aria-hidden="true"
          className="absolute inset-y-0 rounded-full bg-action"
          style={{ insetInlineStart: `${fillStart}%`, inlineSize: `${fillSize}%` }}
        />
        {ticks.map((tick) => (
          <span
            key={tick}
            aria-hidden="true"
            className="absolute top-1/2 h-1 w-1 rounded-full bg-border-strong"
            style={{
              insetInlineStart: `calc(${tick}% - 0.125rem)`,
              marginTop: "-0.125rem",
            }}
          />
        ))}
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider (single value)                                                       */
/* -------------------------------------------------------------------------- */

export type SliderProps = {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  ariaLabel?: string;
  unit?: string;
  showBubble?: boolean;
  showTicks?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  formatValue?: (value: number) => string;
};

export function Slider({
  value,
  defaultValue = 0,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  ariaLabel,
  unit,
  showBubble = false,
  showTicks = false,
  disabled = false,
  id,
  className,
  formatValue,
}: SliderProps) {
  const [internal, setInternal] = React.useState(() =>
    clamp(snapToStep(defaultValue, min, step), min, max),
  );
  const current =
    value === undefined ? internal : clamp(snapToStep(value, min, step), min, max);
  const [drag, setDrag] = React.useState<number | null>(null);
  const dragging = drag !== null;

  const display = drag ?? current;
  const fmt = formatValue ?? ((v: number) => formatSliderValue(v, unit));
  const labelId = React.useId();

  const commit = React.useCallback(
    (next: number, final: boolean) => {
      const snapped = clamp(snapToStep(next, min, step), min, max);
      if (value === undefined) setInternal(snapped);
      onValueChange?.(snapped);
      if (final) onValueCommit?.(snapped);
      return snapped;
    },
    [value, min, max, step, onValueChange, onValueCommit],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    setDrag(valueFromPercent(percentFromClientX(e.currentTarget, e.clientX), min, max, step, false));
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !dragging) return;
    setDrag(valueFromPercent(percentFromClientX(e.currentTarget, e.clientX), min, max, step, false));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    commit(drag as number, true);
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = applyKeyMove(current, e.key, { min, max, step, shift: e.shiftKey });
    if (next === null) return;
    e.preventDefault();
    commit(next, true);
  };

  const ticks = showTicks ? tickValues(min, max, step) : [];

  return (
    <div
      id={id}
      data-testid="slider"
      className={cn(
        "w-full select-none",
        dragging && "u-no-transition",
        disabled && "opacity-50",
        className,
      )}
    >
      {(label || showBubble) && (
        <div className="mb-2 flex items-center justify-between gap-2 text-sm">
          {label ? (
            <span id={labelId} className="text-muted">
              {label}
            </span>
          ) : (
            <span />
          )}
          {showBubble && (
            <output
              aria-hidden="true"
              className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs tabular-nums text-fg"
            >
              {fmt(display)}
            </output>
          )}
        </div>
      )}
      <Track
        fillStart={0}
        fillSize={percentFromValue(display, min, max)}
        ticks={ticks}
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Thumb
          value={current}
          min={min}
          max={max}
          step={step}
          label={ariaLabel ?? label ?? "Value"}
          valueText={fmt(current)}
          disabled={disabled}
          onKeyDown={handleKeyDown}
        />
      </Track>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* RangeSlider (dual thumb)                                                    */
/* -------------------------------------------------------------------------- */

export type RangeSliderProps = {
  value?: Range;
  defaultValue?: Range;
  onValueChange?: (value: Range) => void;
  onValueCommit?: (value: Range) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  ariaLabel?: string;
  unit?: string;
  showBubble?: boolean;
  showTicks?: boolean;
  minLabel?: string;
  maxLabel?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  formatValue?: (value: number) => string;
};

export function RangeSlider({
  value,
  defaultValue = [0, 100],
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  ariaLabel,
  unit,
  showBubble = false,
  showTicks = false,
  minLabel = "Minimum",
  maxLabel = "Maximum",
  disabled = false,
  id,
  className,
  formatValue,
}: RangeSliderProps) {
  const normalize = (range: Range): Range =>
    orderRange(
      clamp(snapToStep(range[0], min, step), min, max),
      clamp(snapToStep(range[1], min, step), min, max),
    );

  const [internal, setInternal] = React.useState<Range>(() => normalize(defaultValue));
  const current: Range = value === undefined ? internal : normalize(value);
  const [drag, setDrag] = React.useState<{ index: 0 | 1; value: number } | null>(
    null,
  );
  const dragging = drag !== null;

  const display: Range = [
    drag?.index === 0 ? drag.value : current[0],
    drag?.index === 1 ? drag.value : current[1],
  ];

  const fmt = formatValue ?? ((v: number) => formatSliderValue(v, unit));
  const groupLabel = ariaLabel ?? label ?? "Range";

  const commit = React.useCallback(
    (next: Range, final: boolean) => {
      const ordered = orderRange(next[0], next[1]);
      if (value === undefined) setInternal(ordered);
      onValueChange?.(ordered);
      if (final) onValueCommit?.(ordered);
    },
    [value, onValueChange, onValueCommit],
  );

  const opts = { min, max, step };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    const raw = valueFromPercent(percentFromClientX(e.currentTarget, e.clientX), min, max, step, false);
    setDrag({ index: nearestThumbIndex(raw, current), value: raw });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !dragging) return;
    const raw = valueFromPercent(percentFromClientX(e.currentTarget, e.clientX), min, max, step, false);
    setDrag((prev) => (prev ? { ...prev, value: raw } : prev));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !drag) return;
    commit(setRangeThumb(current, drag.index, drag.value, opts), true);
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onThumbKeyDown =
    (index: 0 | 1): React.KeyboardEventHandler<HTMLDivElement> =>
    (e) => {
      if (disabled) return;
      const next = applyKeyMove(current[index], e.key, {
        min,
        max,
        step,
        shift: e.shiftKey,
      });
      if (next === null) return;
      e.preventDefault();
      commit(setRangeThumb(current, index, next, opts), true);
    };

  const lo = percentFromValue(display[0], min, max);
  const hi = percentFromValue(display[1], min, max);
  const ticks = showTicks ? tickValues(min, max, step) : [];

  return (
    <div
      id={id}
      data-testid="range-slider"
      className={cn(
        "w-full select-none",
        dragging && "u-no-transition",
        disabled && "opacity-50",
        className,
      )}
    >
      {(label || showBubble) && (
        <div className="mb-2 flex items-center justify-between gap-2 text-sm">
          {label ? <span className="text-muted">{label}</span> : <span />}
          {showBubble && (
            <output
              aria-hidden="true"
              className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs tabular-nums text-fg"
            >
              {`${fmt(display[0])} – ${fmt(display[1])}`}
            </output>
          )}
        </div>
      )}
      <Track
        fillStart={lo}
        fillSize={hi - lo}
        ticks={ticks}
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Thumb
          value={current[0]}
          min={min}
          max={max}
          step={step}
          label={`${groupLabel} ${minLabel.toLowerCase()}`}
          valueText={fmt(current[0])}
          disabled={disabled}
          onKeyDown={onThumbKeyDown(0)}
        />
        <Thumb
          value={current[1]}
          min={min}
          max={max}
          step={step}
          label={`${groupLabel} ${maxLabel.toLowerCase()}`}
          valueText={fmt(current[1])}
          disabled={disabled}
          onKeyDown={onThumbKeyDown(1)}
        />
      </Track>
    </div>
  );
}
