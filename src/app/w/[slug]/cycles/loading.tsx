import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Cycles (docs/DESIGN_SYSTEM.md §8). Matches
 * the shared container and header and the `CyclesBoard` loading column: one
 * card per cycle.
 */
export default function CyclesLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-4 w-28" />
      <Skeleton variant="block" className="mt-2 h-7 w-32" />
      <Skeleton variant="text" lines={2} className="mt-2 max-w-2xl" />

      <div className="mt-6 space-y-3">
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
    </div>
  );
}
