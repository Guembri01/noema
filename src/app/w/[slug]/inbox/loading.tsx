import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Inbox (docs/DESIGN_SYSTEM.md §8): the
 * header and the day-grouped notification rows.
 */
export default function InboxLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-7 w-36" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-md" />

      <div className="mt-6 space-y-6">
        {[0, 1].map((group) => (
          <section key={group}>
            <Skeleton variant="text" lines={1} className="mb-2 max-w-[8rem]" />
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} variant="row" />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
