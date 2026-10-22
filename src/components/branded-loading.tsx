import { NoemaWordmark } from "@/components/brand/noema-wordmark";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Branded skeleton for public, server-fetched surfaces (shared pages and
 * invitations). The app shell has its own route skeletons; these pages render
 * outside it, so without this a guest sees a blank document while the token is
 * resolved.
 */
export function BrandedLoading({
  label,
  compact = false,
}: {
  label: string;
  /** Invitations are forms, not documents: one card is enough. */
  compact?: boolean;
}) {
  return (
    <main id="main" className="mx-auto min-h-screen max-w-3xl px-6 py-10">
      <NoemaWordmark href="/" />
      <div
        className="mt-14 space-y-4"
        aria-busy="true"
        aria-label={label}
      >
        <Skeleton className={compact ? "h-8 w-1/2" : "h-9 w-2/3"} />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        {compact ? (
          <Skeleton className="mt-6 h-56 w-full rounded-lg" />
        ) : (
          <>
            <Skeleton className="h-4 w-4/5" />
            <div className="pt-6">
              <Skeleton className="h-40 w-full rounded-lg" />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
