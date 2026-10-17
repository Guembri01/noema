import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Trash (docs/DESIGN_SYSTEM.md §8): the back
 * link, the heading and the archived-page rows, matched to the real list so
 * nothing shifts when the data lands.
 */
export default function TrashLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
    >
      <span className="sr-only">Loading…</span>
      <Skeleton variant="block" className="h-4 w-28" />
      <Skeleton variant="block" className="mt-2 h-7 w-32" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-xl" />

      <div className="mt-6">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} variant="row" />
        ))}
      </div>
    </div>
  );
}
