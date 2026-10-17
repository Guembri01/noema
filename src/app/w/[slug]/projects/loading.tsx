import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the projects board.
 *
 * Mirrors `ProjectsBoard`: the page header, the "new project" panel, the WIP
 * editor panel and the three-column card grid. Card geometry comes from
 * `Skeleton`'s `card` variant, so the grid swaps without a shift
 * (docs/DESIGN_SYSTEM.md §8).
 */
export default function ProjectsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      data-testid="projects-loading"
    >
      <span role="status" className="sr-only">
        Loading projects…
      </span>

      {/* Page header — eyebrow, title, intro. */}
      <Skeleton variant="block" height={16} width={80} />
      <Skeleton variant="block" height={28} width={160} className="mt-2" />
      <Skeleton variant="block" height={16} width={360} className="mt-3 mb-8" />

      {/* "New project" panel. */}
      <div aria-hidden className="mb-6 rounded-xl border border-border p-4">
        <Skeleton variant="block" height={16} width={140} className="mb-3" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton variant="block" height={36} width={224} />
          <Skeleton variant="block" height={36} width={288} />
          <Skeleton variant="block" height={36} width={140} />
          <Skeleton variant="block" height={36} width={96} />
        </div>
      </div>

      {/* WIP-limit editor panel. */}
      <div aria-hidden className="mb-6 rounded-xl border border-border p-4">
        <Skeleton variant="block" height={16} width={120} className="mb-3" />
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 4 }, (_, field) => (
            <Skeleton key={field} variant="block" height={32} width={120} />
          ))}
        </div>
      </div>

      {/* Card grid — same columns as the board. */}
      <ul aria-hidden data-testid="projects-loading-grid" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, card) => (
          <li key={card}>
            <Skeleton variant="card" />
          </li>
        ))}
      </ul>
    </div>
  );
}
