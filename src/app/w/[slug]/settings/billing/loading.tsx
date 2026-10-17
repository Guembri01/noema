import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → Plan & billing.
 *
 * Current-plan card, limits table, feature chips and the proration table — the
 * four sections the page renders, in order.
 */
export default function BillingLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading plan and billing…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={220} height={28} className="mb-2" />
      <Skeleton variant="text" lines={2} className="mb-8" />

      <Section className="mb-10" title={<Skeleton variant="block" width={140} height={20} />}>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-baseline justify-between gap-3">
            <Skeleton variant="block" width={120} height={18} />
            <Skeleton variant="block" width={64} height={12} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Skeleton variant="block" width="80%" height={16} />
            <Skeleton variant="block" width="80%" height={16} />
          </div>
        </div>
      </Section>

      <Section className="mb-10" title={<Skeleton variant="block" width={80} height={20} />}>
        <Skeleton variant="table" rows={4} cols={2} />
      </Section>

      <Section className="mb-10" title={<Skeleton variant="block" width={140} height={20} />}>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} variant="block" width={96} height={28} />
          ))}
        </div>
      </Section>

      <Section title={<Skeleton variant="block" width={180} height={20} />}>
        <Skeleton variant="text" lines={2} className="mb-3" />
        <Skeleton variant="table" rows={3} cols={4} />
      </Section>
    </div>
  );
}
