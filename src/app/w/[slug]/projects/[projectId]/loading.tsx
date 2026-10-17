import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for one project.
 *
 * Follows the detail page's sequence: back link, title, the action row, the
 * Gantt block and the stacked `Section`s (Overview, Milestones, Tickets), so the
 * placeholder and the real page share the same container and vertical rhythm
 * (docs/DESIGN_SYSTEM.md §4, §8).
 */
export default function ProjectDetailLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      data-testid="project-detail-loading"
    >
      <span role="status" className="sr-only">
        Loading project…
      </span>

      {/* "All projects" back link + project title. */}
      <Skeleton variant="block" height={12} width={96} />
      <Skeleton variant="block" height={28} width={220} className="mt-2 mb-8" />

      {/* Action row. */}
      <div aria-hidden className="flex flex-wrap items-center gap-2">
        <Skeleton variant="block" height={36} width={112} />
        <Skeleton variant="block" height={36} width={112} />
        <Skeleton variant="block" height={36} width={96} />
      </div>

      {/* Gantt block. */}
      <Skeleton variant="block" height={128} className="mt-6 rounded-xl" />

      {/* Overview section. */}
      <div className="mt-10 space-y-3">
        <Skeleton variant="block" height={20} width={140} />
        <div aria-hidden className="flex flex-wrap items-center gap-2">
          <Skeleton variant="block" height={36} width={280} />
          <Skeleton variant="block" height={36} width={140} />
          <Skeleton variant="block" height={36} width={140} />
        </div>
        <Skeleton variant="block" height={56} />
        <Skeleton variant="block" height={16} width="40%" />
      </div>

      {/* Milestones section. */}
      <div className="mt-10 space-y-3">
        <Skeleton variant="block" height={20} width={160} />
        <ul aria-hidden className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 4 }, (_, row) => (
            <li key={row}>
              <Skeleton variant="row" className="border-b-0" />
            </li>
          ))}
        </ul>
      </div>

      {/* Tickets section. */}
      <div className="mt-10 space-y-3">
        <Skeleton variant="block" height={20} width={120} />
        <ul aria-hidden className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 5 }, (_, row) => (
            <li key={row}>
              <Skeleton variant="row" className="border-b-0" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
