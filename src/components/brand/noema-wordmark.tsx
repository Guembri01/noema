import Link from "next/link";
import { NoemaMark } from "@/components/brand/noema-mark";
import { cn } from "@/lib/utils";

/**
 * Noema's public lockup: the measured N mark in a filled tile plus the
 * wordmark. The mark is the product's identity, not decoration for a single
 * assistant button, so the landing, sign-in and sign-up surfaces all use this
 * one component instead of three spellings of the name.
 */
export function NoemaWordmark({
  className,
  markClassName,
  textClassName,
  href,
}: {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  /** When set, the lockup is one link with the product name as its label. */
  href?: string;
}) {
  const lockup = (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-card bg-action text-action-fg shadow-1",
          markClassName,
        )}
      >
        <NoemaMark className="h-5 w-5" />
      </span>
      <span
        className={cn(
          "truncate text-lg font-semibold tracking-title text-fg",
          textClassName,
        )}
      >
        Noema
      </span>
    </span>
  );

  return href ? (
    <Link href={href} className="focus-ring inline-flex rounded-md">
      {lockup}
    </Link>
  ) : (
    lockup
  );
}
