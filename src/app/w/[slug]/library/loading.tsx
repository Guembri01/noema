import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Library grid (docs/DESIGN_SYSTEM.md §8).
 * Mirrors the eyebrow + title + description header and the two card sections so
 * nothing shifts when the real tree lands.
 */
export default function LibraryLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-4 w-20" />
      <Skeleton variant="block" className="mt-2 h-7 w-40" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-sm" />

      {[0, 1].map((section) => (
        <section key={section} className="mt-8">
          <Skeleton variant="text" lines={1} className="mb-3 max-w-[10rem]" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} variant="card" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
