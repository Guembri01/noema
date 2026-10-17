import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the workspace home
 * (docs/DESIGN_SYSTEM.md §8): the greeting header and the template gallery.
 * The page waits on the page tree, the trash list and the gallery before it can
 * paint, so a skeleton keeps navigation from flashing an empty frame.
 */
export default function WorkspaceHomeLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Skeleton variant="block" className="h-7 w-64" />
          <Skeleton variant="block" className="h-4 w-40" />
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((card) => (
            <Skeleton key={card} variant="card" />
          ))}
        </div>
      </div>
    </div>
  );
}
