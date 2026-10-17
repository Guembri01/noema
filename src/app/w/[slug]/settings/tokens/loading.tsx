import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → API tokens.
 *
 * Matches the back-link, title, intro and the token Section (create card +
 * token table) so the content settles without a layout shift.
 */
export default function ApiTokensLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading API tokens…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={200} height={28} className="mb-2" />
      <Skeleton variant="text" lines={2} className="mb-6" />

      <Section
        className="mt-10"
        title={<Skeleton variant="block" width={140} height={20} />}
      >
        <Skeleton variant="block" width="55%" height={12} />
        <div className="rounded-md border border-border p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Skeleton variant="block" width="60%" height={36} />
            <Skeleton variant="block" width={120} height={36} />
          </div>
          <Skeleton variant="table" rows={3} cols={2} className="mt-4" />
        </div>
        <Skeleton variant="table" rows={3} cols={3} />
      </Section>
    </div>
  );
}
