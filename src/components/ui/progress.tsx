import type { HTMLAttributes, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Progress — the determinate/indeterminate vocabulary for uploads, imports and
 * AI runs (docs/DESIGN_SYSTEM.md §8).
 *
 * `Progress` is the bar (determinate fill, or an `animate-shimmer` pulse when
 * indeterminate); `ProgressRing` is the compact circle used for AI/upload where
 * a full-width bar will not fit. Both are reduced-motion safe and token-only.
 */

export type ProgressTone = "accent" | "success" | "danger";
export type ProgressSize = "xs" | "sm" | "md" | "lg";

/** Bar height per size (4px grid). */
export const PROGRESS_SIZE_CLASS: Record<ProgressSize, string> = {
  xs: "h-1",
  sm: "h-1.5",
  md: "h-2",
  lg: "h-3",
};

/** Bar track fill — one token for every tone. */
export const PROGRESS_TRACK_CLASS = "bg-surface-2";

/** Ring track stroke — the SVG twin of {@link PROGRESS_TRACK_CLASS}. */
export const PROGRESS_TRACK_STROKE = "stroke-surface-2";

/** Bar fill per tone. */
export const PROGRESS_TONE_CLASS: Record<ProgressTone, string> = {
  accent: "bg-action",
  success: "bg-success",
  danger: "bg-danger",
};

/** Ring stroke / label colour per tone (paired with `stroke-current`). */
export const PROGRESS_TONE_TEXT: Record<ProgressTone, string> = {
  accent: "text-action",
  success: "text-success",
  danger: "text-danger",
};

/** Clamp any input to a 0–100 percentage (null/NaN safe). */
export function clampPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Percentage of `value` within `max` (default 100), clamped to 0–100. */
export function progressPercent(
  value: number | null | undefined,
  max = 100,
): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return clampPercent(((value ?? 0) / max) * 100);
}

export interface RingGeometry {
  radius: number;
  circumference: number;
  /** `stroke-dashoffset` for the given percentage. */
  offset: number;
  center: number;
}

/** Geometry for {@link ProgressRing}: radius, circumference and dash offset. */
export function ringGeometry(
  size: number,
  stroke: number,
  percent: number,
): RingGeometry {
  const radius = Math.max(0, (size - stroke) / 2);
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clampPercent(percent) / 100);
  return { radius, circumference, offset, center: size / 2 };
}

/** A determinate value is a finite number; anything else is indeterminate. */
function isDeterminate(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–`max`. Omit (or `undefined`) for an indeterminate bar. */
  value?: number;
  max?: number;
  size?: ProgressSize;
  tone?: ProgressTone;
  /** Visible label above the bar; a string also names the progressbar. */
  label?: ReactNode;
  /** Show the rounded percentage beside the label. */
  showValue?: boolean;
  /** Override the accessible value text (defaults to `"NN%"`). */
  valueText?: string;
}

/** The horizontal progress bar. */
export function Progress({
  value,
  max = 100,
  size = "sm",
  tone = "accent",
  label,
  showValue = false,
  valueText,
  className,
  ...rest
}: ProgressProps) {
  const determinate = isDeterminate(value);
  const percent = determinate ? progressPercent(value, max) : 0;
  const rounded = Math.round(percent);
  const hasHeader = Boolean(label) || (showValue && determinate);

  return (
    <div className={cn("w-full", className)} {...rest}>
      {hasHeader ? (
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          {label ? <span className="text-muted">{label}</span> : <span />}
          {showValue && determinate ? (
            <span className="tabular-nums text-fg-subtle">{rounded}%</span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={determinate ? Math.round(value) : undefined}
        aria-valuetext={valueText ?? (determinate ? `${rounded}%` : undefined)}
        className={cn(
          "relative w-full overflow-hidden rounded-full",
          PROGRESS_TRACK_CLASS,
          PROGRESS_SIZE_CLASS[size],
        )}
      >
        <div
          className={cn(
            "h-full rounded-full",
            PROGRESS_TONE_CLASS[tone],
            determinate ? "u-colors" : "w-full animate-shimmer",
          )}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

export interface ProgressRingProps
  extends Omit<SVGProps<SVGSVGElement>, "stroke"> {
  /** 0–`max`. Omit for an indeterminate (spinning) ring. */
  value?: number;
  max?: number;
  /** Ring diameter in px. */
  size?: number;
  /** Stroke width in px. */
  stroke?: number;
  tone?: ProgressTone;
  /** Centre label; a string also names the progressbar. */
  label?: ReactNode;
  /** Show the rounded percentage in the centre. */
  showValue?: boolean;
}

/** The circular progress indicator (AI runs, uploads). */
export function ProgressRing({
  value,
  max = 100,
  size = 48,
  stroke = 4,
  tone = "accent",
  label,
  showValue = false,
  className,
  ...rest
}: ProgressRingProps) {
  const determinate = isDeterminate(value);
  const percent = determinate ? progressPercent(value, max) : 0;
  const rounded = Math.round(percent);
  const { radius, circumference, offset, center } = ringGeometry(
    size,
    stroke,
    percent,
  );

  return (
    <span className={cn("relative inline-grid place-items-center", className)}>
      <svg
        role="progressbar"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={determinate ? Math.round(value) : undefined}
        aria-valuetext={determinate ? `${rounded}%` : undefined}
        className={cn("block -rotate-90", determinate ? undefined : "animate-spin")}
        {...rest}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
          className={cn("fill-none", PROGRESS_TRACK_STROKE)}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={determinate ? offset : circumference * 0.75}
          className={cn("fill-none stroke-current", PROGRESS_TONE_TEXT[tone])}
          style={{
            transition: "stroke-dashoffset var(--dur-2) var(--ease-smooth)",
          }}
        />
      </svg>
      {label || (showValue && determinate) ? (
        <span className="absolute inset-0 grid place-items-center text-xs tabular-nums text-fg-subtle">
          {showValue && determinate ? `${rounded}%` : label}
        </span>
      ) : null}
    </span>
  );
}
