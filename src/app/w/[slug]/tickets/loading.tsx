import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the tickets workspace.
 *
 * The workspace defaults to the board view, so the placeholder draws the same
 * toolbar → rollup bar → four board columns sequence the real page renders
 * (docs/DESIGN_SYSTEM.md §8: a list/panel's `loading` state must match the final
 * layout so nothing shifts when the data lands). Column, header and card
 * geometry mirror `TicketBoardView`/`TicketComposer` so the swap is seamless.
 */
export default function TicketsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      data-testid="tickets-loading"
    >
      <span role="status" className="sr-only">
        Loading tickets…
      </span>

      {/* Page header — eyebrow, title, intro. */}
      <Skeleton variant="block" height={16} width={80} />
      <Skeleton variant="block" height={28} width={140} className="mt-2" />
      <Skeleton variant="block" height={16} width={320} className="mt-3 mb-6" />

      {/* Toolbar — view switcher, archive, search, five filters, sort, views. */}
      <div aria-hidden className="mb-4 flex flex-wrap items-center gap-2">
        <Skeleton variant="block" height={32} width={132} />
        <Skeleton variant="block" height={32} width={92} />
        <Skeleton variant="block" height={32} width={192} />
        <Skeleton variant="block" height={32} width={144} />
        <Skeleton variant="block" height={32} width={144} />
        <Skeleton variant="block" height={32} width={160} />
        <Skeleton variant="block" height={32} width={160} />
        <Skeleton variant="block" height={32} width={160} />
        <Skeleton variant="block" height={24} width={110} />
        <Skeleton variant="block" height={32} width={168} />
        <Skeleton variant="block" height={32} width={120} />
        <Skeleton variant="block" height={32} width={112} />
        <Skeleton variant="block" height={32} width={110} className="ml-auto" />
      </div>

      {/* Rollup bar — filter count, estimate, remaining, closed. */}
      <div aria-hidden className="mb-4 flex flex-wrap items-center gap-2">
        <Skeleton variant="block" height={22} width={140} />
        <Skeleton variant="block" height={22} width={180} />
        <Skeleton variant="block" height={22} width={200} />
        <Skeleton variant="block" height={22} width={160} />
      </div>

      {/* Board — four status columns of three cards each, matching `w-64`. */}
      <div aria-hidden className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: 4 }, (_, column) => (
          <div
            key={column}
            className="flex w-64 shrink-0 flex-col rounded-lg border border-border"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Skeleton variant="block" height={12} width="55%" />
            </div>
            <div className="flex-1 space-y-2 p-2">
              {Array.from({ length: 3 }, (_, card) => (
                <Skeleton key={card} variant="card" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
