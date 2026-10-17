import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the archived-tickets view.
 *
 * Matches `TicketArchiveView`: a narrow container, a back link, the header, a
 * search/refresh row and a bordered list of rows — so the placeholder occupies
 * the same box the real list lands in (docs/DESIGN_SYSTEM.md §8).
 */
export default function TicketArchiveLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[900px] px-8 py-12"
      aria-busy="true"
      data-testid="tickets-archive-loading"
    >
      <span role="status" className="sr-only">
        Loading archived tickets…
      </span>

      {/* "Back to tickets" link. */}
      <Skeleton variant="block" height={14} width={132} />
      {/* Title with its leading icon. */}
      <div className="mt-3 flex items-center gap-2">
        <Skeleton variant="circle" width={24} />
        <Skeleton variant="block" height={28} width={260} />
      </div>
      <Skeleton variant="block" height={16} width="70%" className="mt-3 mb-6" />

      {/* Search field + count badge. */}
      <div aria-hidden className="mb-4 flex flex-wrap items-center gap-2">
        <Skeleton variant="block" height={36} width={320} />
        <Skeleton variant="block" height={22} width={40} />
      </div>

      {/* Archival rows. */}
      <ul aria-hidden className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {Array.from({ length: 6 }, (_, row) => (
          <li key={row}>
            <Skeleton variant="row" className="border-b-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}
