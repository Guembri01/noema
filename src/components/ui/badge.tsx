import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Badge (§9). A small count/label pill for status and metadata.
 *
 * Tones map to the `--*-soft` backgrounds with the matching solid ink, so light,
 * dark and high-contrast all inherit from the token layer. Counts over `max`
 * truncate to `N+` (`99+` by default) with the exact value kept in `title`. An
 * icon slot can precede the text without shifting the baseline.
 */

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeSize = "sm" | "md";

export const BADGE_TONES: readonly BadgeTone[] = [
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
];

/** Type guard for a tone coming from untrusted data. */
export function isBadgeTone(value: unknown): value is BadgeTone {
  return typeof value === "string" && (BADGE_TONES as readonly string[]).includes(value);
}

/** Any tone, defaulting to `neutral`. */
export function badgeTone(tone: string | null | undefined): BadgeTone {
  return isBadgeTone(tone) ? tone : "neutral";
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
};

/** Tone classes: `--*-soft` background + solid token ink. */
export function badgeToneClass(tone: string | null | undefined): string {
  return TONE_CLASS[badgeTone(tone)];
}

const SIZE_CLASS: Record<BadgeSize, string> = {
  sm: "h-4 min-w-4 gap-1 px-1 text-[10px]",
  md: "h-5 min-w-5 gap-1 px-1.5 text-xs",
};

/** Size classes, defaulting to `md`. */
export function badgeSizeClass(size: BadgeSize | null | undefined): string {
  return SIZE_CLASS[size === "sm" ? "sm" : "md"];
}

/**
 * Format a count for a badge. Clamps to a non-negative integer (non-finite and
 * negative inputs read `0`) and truncates anything above `max` to `N+`.
 */
export function formatCount(
  value: number | null | undefined,
  max = 99,
): string {
  const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : 99));
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n);
  return whole > cap ? `${cap}+` : String(whole);
}

export type BadgeProps = {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** When set, renders `formatCount(count, max)` instead of `children`. */
  count?: number | null;
  /** Truncation ceiling (default 99). */
  max?: number;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

export function Badge({
  tone = "neutral",
  size = "md",
  count,
  max = 99,
  icon,
  className,
  children,
  title,
  ...rest
}: BadgeProps) {
  const hasCount = count !== undefined && count !== null;
  const resolvedTone = badgeTone(tone);
  const display = hasCount ? formatCount(count, max) : children;
  const truncated = hasCount && String(Math.floor(Number(count))) !== display;

  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center justify-center rounded-sm border align-middle font-medium tabular-nums whitespace-nowrap",
        badgeToneClass(resolvedTone),
        badgeSizeClass(size),
        className,
      )}
      data-tone={resolvedTone}
      data-size={size}
      data-truncated={truncated ? "true" : undefined}
      title={title ?? (hasCount ? String(count) : undefined)}
    >
      {icon !== undefined && icon !== null ? (
        <span aria-hidden className="inline-flex shrink-0 [&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      {display !== undefined && display !== null && display !== "" ? (
        <span className="truncate">{display}</span>
      ) : null}
    </span>
  );
}
