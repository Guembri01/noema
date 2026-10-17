import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Search (docs/DESIGN_SYSTEM.md §8): the page
 * header, the search field and the result rows.
 */
export default function SearchLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-7 w-32" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-md" />
      <Skeleton variant="block" className="mt-5 h-11 w-full rounded-lg" />

      <div className="mt-4">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} variant="row" />
        ))}
      </div>
    </div>
  );
}
