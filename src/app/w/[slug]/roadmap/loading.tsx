import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Roadmap (docs/DESIGN_SYSTEM.md §8): the
 * header, the zoom controls, the timeline lanes and the rollup columns.
 */
export default function RoadmapLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-4 w-20" />
      <Skeleton variant="block" className="mt-2 h-7 w-40" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-lg" />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {[0, 1, 2, 3].map((chip) => (
          <Skeleton key={chip} variant="block" className="h-7 w-16" />
        ))}
      </div>

      <div className="mt-6 space-y-6">
        {[0, 1].map((lane) => (
          <section key={lane} className="rounded-lg border border-border p-4">
            <Skeleton variant="text" lines={1} className="mb-3 max-w-[12rem]" />
            <div className="space-y-2">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} variant="block" className="h-4" />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {[0, 1].map((column) => (
          <div key={column}>
            <Skeleton variant="text" lines={1} className="mb-3 max-w-[8rem]" />
            <Skeleton variant="text" lines={3} />
          </div>
        ))}
      </div>
    </div>
  );
}
