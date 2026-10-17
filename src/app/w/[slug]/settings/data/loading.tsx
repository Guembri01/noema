import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → Data & privacy.
 *
 * Two section cards (export bundle, erasure plan) each sized to the real card
 * so the client shell's own loading state has a stable frame.
 */
export default function DataLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading data controls…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={180} height={28} className="mb-2" />
      <Skeleton variant="text" lines={3} className="mb-8" />

      <Section title={<Skeleton variant="block" width={140} height={20} />}>
        <div className="rounded-lg border border-border p-4">
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="block" width={180} height={36} className="mt-4" />
        </div>
      </Section>

      <Section className="mt-10" title={<Skeleton variant="block" width={180} height={20} />}>
        <Skeleton variant="table" rows={4} cols={2} />
      </Section>
    </div>
  );
}
