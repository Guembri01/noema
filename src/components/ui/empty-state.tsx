import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";

/**
 * EmptyState — the `empty` half of the states contract in
 * docs/DESIGN_SYSTEM.md §8: icon + title + hint + primary action.
 *
 * Three densities share one shape: `full` for a page or a large panel, `compact`
 * for a table body, a board column or a drawer, and `inline` for a narrow
 * sidebar section where an empty state is a hint, not a destination. Everything
 * is token-only and `min-w-0` so a narrow column never overflows.
 */

export type EmptyStateVariant = "full" | "compact" | "inline";

/** Per-variant layout tokens. Pure, so the node tests pin every density. */
export const EMPTY_STATE_VARIANTS = {
  full: {
    root: "flex-col items-center justify-center gap-3 px-6 py-12 text-center",
    icon: "size-10 bg-surface",
    title: "text-sm font-medium",
    description: "text-sm text-muted",
    actions: "flex flex-wrap items-center justify-center gap-2",
    tip: "flex flex-wrap items-center justify-center gap-1.5 text-xs text-fg-subtle",
  },
  compact: {
    root: "flex-col items-center justify-center gap-2 px-3 py-6 text-center",
    icon: "size-8 bg-surface",
    title: "text-sm font-medium",
    description: "text-xs text-muted",
    actions: "flex flex-wrap items-center justify-center gap-2",
    tip: "flex flex-wrap items-center justify-center gap-1.5 text-xs text-fg-subtle",
  },
  inline: {
    root: "flex-row flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1.5 text-left",
    icon: "size-6",
    title: "text-xs text-muted",
    description: "text-2xs text-muted",
    actions: "flex flex-wrap items-center justify-start gap-2",
    tip: "flex flex-wrap items-center justify-start gap-1.5 text-2xs text-fg-subtle",
  },
} as const;

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** `full` (page/panel) or `compact` (table/board column/drawer). */
  variant?: EmptyStateVariant;
  /** Decorative glyph or small illustration. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  /** Footer hint, e.g. a keyboard shortcut sentence. */
  tip?: ReactNode;
  /** Convenience: a single key rendered as a `<Kbd>` inside the tip row. */
  shortcut?: string;
}

/**
 * The shared empty/zero-state block.
 *
 * ```tsx
 * <EmptyState
 *   variant="compact"
 *   icon={<Inbox />}
 *   title="No tickets"
 *   description="Nothing matches this filter."
 *   primaryAction={<Button>New ticket</Button>}
 *   tip="Press"
 *   shortcut="C"
 * />
 * ```
 */
export function EmptyState({
  variant = "full",
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  tip,
  shortcut,
  className,
  ...rest
}: EmptyStateProps) {
  const v = EMPTY_STATE_VARIANTS[variant];
  const hasActions = Boolean(primaryAction || secondaryAction);
  const hasTip = Boolean(tip || shortcut);

  return (
    <div
      data-empty-state={variant}
      className={cn("flex min-w-0", v.root, className)}
      {...rest}
    >
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "grid shrink-0 place-items-center rounded-md text-muted",
            v.icon,
          )}
        >
          {icon}
        </span>
      ) : null}

      <div
        className={cn(
          "flex min-w-0 flex-col gap-1",
          variant === "inline" ? "items-start" : "items-center",
        )}
      >
        <p className={cn("m-0 max-w-full break-words", v.title)}>{title}</p>
        {description ? (
          <p className={cn("m-0 max-w-md break-words", v.description)}>
            {description}
          </p>
        ) : null}
      </div>

      {hasActions ? (
        <div className={v.actions}>
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}

      {hasTip ? (
        <div className={v.tip}>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          {tip}
        </div>
      ) : null}
    </div>
  );
}
