import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Separator — a subtle divider built from the `--border` token.
 *
 * `default` for normal spacing, `hairline` for dense lists (a lighter,
 * translucent line). Decorative by default: hidden from the accessibility tree
 * and never focusable. Pass `decorative={false}` for a semantic `separator`.
 */

export type SeparatorOrientation = "horizontal" | "vertical";
export type SeparatorVariant = "default" | "hairline";

/** Line colours per variant. Pinned by `separator.test.ts`. */
export const SEPARATOR_VARIANTS: Record<SeparatorVariant, string> = {
  default: "bg-border",
  hairline: "bg-border/60",
};

export type SeparatorProps = {
  orientation?: SeparatorOrientation;
  variant?: SeparatorVariant;
  /** Optional centred label, e.g. "or". Horizontal only. */
  label?: ReactNode;
  /** `true` (default) hides the line from assistive tech. */
  decorative?: boolean;
} & HTMLAttributes<HTMLDivElement>;

export function Separator({
  orientation = "horizontal",
  variant = "default",
  label,
  decorative = true,
  className,
  ...props
}: SeparatorProps) {
  const a11y: HTMLAttributes<HTMLDivElement> = decorative
    ? { "aria-hidden": true }
    : {
        role: "separator",
        "aria-orientation": orientation,
        ...(typeof label === "string" ? { "aria-label": label } : null),
      };

  if (orientation === "horizontal" && label !== undefined && label !== null) {
    return (
      <div
        className={cn("flex w-full items-center gap-3", className)}
        {...a11y}
        {...props}
      >
        <span className={cn("h-px flex-1", SEPARATOR_VARIANTS[variant])} />
        <span className="shrink-0 text-xs text-muted">{label}</span>
        <span className={cn("h-px flex-1", SEPARATOR_VARIANTS[variant])} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        orientation === "vertical" ? "w-px self-stretch" : "h-px w-full",
        SEPARATOR_VARIANTS[variant],
        className,
      )}
      {...a11y}
      {...props}
    />
  );
}
