import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Section — the one settings-page block. Every settings screen uses it so the
 * heading, description, action slot and vertical rhythm (`gap-6`) are identical
 * everywhere (docs/DESIGN_SYSTEM.md §3–§4).
 *
 * `danger` re-colours the heading only — never the surface — so a destructive
 * block still reads as part of the page.
 */

export type SectionTone = "default" | "danger";

/** Heading colours per tone. Pinned by `section.test.ts`. */
export const SECTION_TONES: Record<SectionTone, string> = {
  default: "text-fg",
  danger: "text-danger",
};

/** The canonical section-title type ramp (see design doc §3). */
export const SECTION_HEADING_CLASS =
  "text-xl font-semibold tracking-[-0.01em]";

export type SectionProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned control(s), e.g. a "Reset" button or a switch. */
  action?: ReactNode;
  tone?: SectionTone;
  /** Semantic heading level; styling stays identical at every level. */
  level?: 2 | 3 | 4;
} & HTMLAttributes<HTMLElement>;

export function Section({
  title,
  description,
  action,
  tone = "default",
  level = 2,
  className,
  children,
  ...props
}: SectionProps) {
  const Heading = `h${level}` as ElementType;

  return (
    <section className={cn("flex flex-col gap-6", className)} {...props}>
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading className={cn(SECTION_HEADING_CLASS, SECTION_TONES[tone])}>
            {title}
          </Heading>
          {description ? (
            <p className="text-sm text-muted">{description}</p>
          ) : null}
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-2">{action}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
