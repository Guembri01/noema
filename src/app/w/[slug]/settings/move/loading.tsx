import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → Move pages.
 *
 * The selection form (two selects + preview button) and the bordered move
 * preview card.
 */
export default function MoveLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading move pages…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={280} height={28} className="mb-2" />
      <Skeleton variant="text" lines={3} className="mb-6" />

      <div className="flex flex-wrap items-end gap-3">
        <Skeleton variant="block" width={224} height={36} />
        <Skeleton variant="block" width={224} height={36} />
        <Skeleton variant="block" width={96} height={36} />
      </div>

      <Section
        className="mt-8 rounded-lg border border-border p-4"
        title={<Skeleton variant="block" width={200} height={18} />}
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton variant="block" width="60%" height={10} />
              <Skeleton variant="block" width={40} height={16} />
            </div>
          ))}
        </div>
        <Skeleton variant="block" width={200} height={36} />
      </Section>
    </div>
  );
}
