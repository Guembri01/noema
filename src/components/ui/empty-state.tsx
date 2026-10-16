import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";

/**
 * EmptyState — the `empty` half of the states contract in
 * docs/DESIGN_SYSTEM.md §8: icon + title + hint + primary action.
 *
 * Two densities share one shape: `full` for a page or a large panel, `compact`
 * for a table body, a board column or a drawer, where vertical room is tight.
 * Everything is token-only and centred with `min-w-0` so a narrow column never
 * overflows.
 */

export type EmptyStateVariant = "full" | "compact";

/** Per-variant layout tokens. Pure, so the node tests pin both densities. */
export const EMPTY_STATE_VARIANTS = {
  full: {
    root: "gap-3 px-6 py-12",
    icon: "size-10",
    title: "text-sm font-medium",
    description: "text-sm text-muted",
    actions: "flex flex-wrap items-center justify-center gap-2",
    tip: "flex flex-wrap items-center justify-center gap-1.5 text-xs text-fg-subtle",
  },
  compact: {
    root: "gap-2 px-3 py-6",
    icon: "size-8",
    title: "text-sm font-medium",
    description: "text-xs text-muted",
    actions: "flex flex-wrap items-center justify-center gap-2",
    tip: "flex flex-wrap items-center justify-center gap-1.5 text-xs text-fg-subtle",
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
      className={cn(
        "flex min-w-0 flex-col items-center justify-center text-center",
        v.root,
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "grid place-items-center rounded-md bg-surface text-muted",
            v.icon,
          )}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex min-w-0 flex-col items-center gap-1">
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
