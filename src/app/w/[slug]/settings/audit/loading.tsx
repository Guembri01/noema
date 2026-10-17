import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for settings → Audit log
 * (docs/DESIGN_SYSTEM.md §8): the header, the filter form and the activity
 * feed. The page runs a permission gate and a cursor query before it paints.
 */
export default function AuditLogLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
    >
      <span className="sr-only">Loading…</span>
      <Skeleton variant="block" className="h-4 w-20" />
      <Skeleton variant="block" className="mt-3 h-7 w-40" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-xl" />

      <div className="mt-6 flex flex-wrap gap-3">
        {[0, 1, 2, 3].map((field) => (
          <Skeleton key={field} variant="block" className="h-9 w-40" />
        ))}
      </div>

      <Skeleton variant="table" rows={8} cols={3} className="mt-8" />
    </div>
  );
}
