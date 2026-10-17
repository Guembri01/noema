import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the template gallery
 * (docs/DESIGN_SYSTEM.md §8): the header, the search/sort controls and the
 * template card grid.
 */
export default function TemplatesLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-4 w-20" />
      <Skeleton variant="block" className="mt-2 h-7 w-40" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-sm" />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Skeleton variant="block" className="h-9 w-56 rounded-md" />
        <Skeleton variant="block" className="h-9 w-32 rounded-md" />
        <Skeleton variant="block" className="h-9 w-24 rounded-md" />
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((card) => (
          <Skeleton key={card} variant="card" />
        ))}
      </div>
    </div>
  );
}
