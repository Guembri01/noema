import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level `loading` skeleton for a page (`/w/[slug]/[pageId]`).
 *
 * Navigating to a page runs the whole server tree (page detail, database,
 * references, versions) before it can paint, so Next streams this file first.
 * It mirrors the real page's shape — the breadcrumb/title bar, an icon +
 * 40px title, then paragraph lines — so the swap to content is a no-shift
 * refinement: the `loading` half of the states contract
 * (docs/DESIGN_SYSTEM.md §8). The `Skeleton` fill is the token gradient +
 * `animate-shimmer`, which `prefers-reduced-motion` neutralises globally.
 */
export default function PageRouteLoading() {
  return (
    <div
      className="mx-auto max-w-[820px] px-5 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Title bar: the breadcrumb trail and the actions cluster. */}
      <div className="mb-6 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton variant="block" className="h-3.5 w-24" />
          <span aria-hidden className="text-muted">
            /
          </span>
          <Skeleton variant="block" className="h-3.5 w-40" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton variant="circle" className="size-7" />
          <Skeleton variant="circle" className="size-7" />
        </div>
      </div>

      {/* Page icon + the 40px title. */}
      <Skeleton variant="circle" className="size-14" />
      <Skeleton variant="block" className="mt-3 h-10 w-2/3" />

      {/* Prose: paragraph lines of the real body. */}
      <div className="mt-8 flex flex-col gap-5">
        <Skeleton variant="text" lines={3} />
        <Skeleton variant="text" lines={3} />
        <Skeleton variant="text" lines={2} />
      </div>

      <span className="sr-only">Loading page…</span>
    </div>
  );
}
