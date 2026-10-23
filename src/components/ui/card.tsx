import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Card — the surface primitive for settings panels, galleries and dashboards.
 *
 * Shape/elevation/motion all come from the design system (docs/DESIGN_SYSTEM.md):
 * `rounded-card` for cards, `shadow-1` for a raised card, `.u-interactive` for the
 * press contract and `.focus-ring` for keyboard focus. No raw radius/shadow and
 * no ad-hoc transition — the variant maps below are pinned by `card.test.ts`.
 */

export type CardVariant = "raised" | "flat" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";

/**
 * `raised` = shadow-1; `flat` = border only; `interactive` = hover lift
 * (background/border/shadow only, never size) + `.u-interactive` press scale.
 * The `.u-surface` helper animates the shadow so the lift does not jump.
 */
export const CARD_VARIANTS: Record<CardVariant, string> = {
  raised: "border border-border bg-bg shadow-1",
  flat: "border border-border bg-bg",
  interactive:
    "border border-border bg-bg shadow-1 u-interactive u-surface hover:border-border-strong hover:bg-surface-2 hover:shadow-2 focus-ring",
};

/** Padding scale (4px grid), applied to the card root. */
export const CARD_PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export type CardMediaAspect = "video" | "square" | "wide" | "auto";

export const CARD_MEDIA_ASPECT: Record<CardMediaAspect, string> = {
  video: "aspect-video",
  square: "aspect-square",
  wide: "aspect-[3/1]",
  auto: "",
};

export type CardProps = {
  /** Element to render the card as. Use `"a"`/`"button"` for an interactive card. */
  as?: ElementType;
  variant?: CardVariant;
  padding?: CardPadding;
  /** Convenience for the `as="a"` case. */
  href?: string;
  type?: "button" | "submit" | "reset";
} & HTMLAttributes<HTMLElement>;

export function Card({
  as: Comp = "div",
  variant = "raised",
  padding = "md",
  className,
  ...props
}: CardProps) {
  return (
    <Comp
      className={cn(
        "rounded-card text-fg",
        CARD_VARIANTS[variant],
        CARD_PADDING[padding],
        className,
      )}
      {...props}
    />
  );
}

/** Edge-to-edge cover/media slot. Pair with `padding="none"` on the card. */
export function CardMedia({
  src,
  alt = "",
  aspect = "video",
  className,
  children,
  ...props
}: {
  aspect?: CardMediaAspect;
} & HTMLAttributes<HTMLDivElement> & { src?: string; alt?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-t-card bg-surface-2",
        CARD_MEDIA_ASPECT[aspect],
        className,
      )}
      {...props}
    >
      {children ??
        (src ? (
          // A plain <img> keeps the primitive portable (no remote-host config).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt} className="h-full w-full object-cover" />
        ) : null)}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("truncate text-sm font-semibold tracking-heading", className)}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-xs text-muted", className)} {...props}>
      {children}
    </p>
  );
}

/**
 * Card header: an icon slot, a title + subtitle stack and a right-aligned
 * actions slot. `children` render under the subtitle for rare extras.
 */
export function CardHeader({
  icon,
  title,
  subtitle,
  actions,
  className,
  children,
  ...props
}: {
  icon?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-start justify-between gap-3", className)}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        {icon ? (
          <span className="mt-0.5 flex shrink-0 items-center text-muted">{icon}</span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          {title ? <CardTitle>{title}</CardTitle> : null}
          {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
          {children}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Card body — the main content region. */
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm", className)} {...props} />;
}

/** Familiar alias for `CardBody`. */
export const CardContent = CardBody;

/** Card footer — actions/affordances, right-aligned by default. */
export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center justify-end gap-2", className)} {...props} />
  );
}
