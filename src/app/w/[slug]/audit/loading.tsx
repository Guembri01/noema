import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Audit log (docs/DESIGN_SYSTEM.md §8):
 * the header, the filter controls and the events table.
 */
export default function AuditLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Skeleton variant="block" className="h-4 w-20" />
      <Skeleton variant="block" className="mt-3 h-7 w-40" />
      <Skeleton variant="text" lines={1} className="mt-2 max-w-xl" />

      <div className="mt-6 flex flex-wrap gap-3">
        {[0, 1, 2, 3].map((chip) => (
          <Skeleton key={chip} variant="block" className="h-7 w-24" />
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        {[0, 1, 2, 3, 4, 5].map((control) => (
          <Skeleton key={control} variant="block" className="h-14 w-40" />
        ))}
      </div>

      <Skeleton variant="table" rows={8} cols={5} className="mt-8" />
    </div>
  );
}
