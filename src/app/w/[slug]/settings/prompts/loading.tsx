import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → Prompt library.
 *
 * The two-column split (saved prompts / editor) with card-shaped skeletons sized
 * to the real layout.
 */
export default function PromptsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading prompts…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={200} height={28} className="mb-2" />
      <Skeleton variant="text" lines={2} className="mb-8" />

      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Section title={<Skeleton variant="block" width={140} height={20} />}>
          <Skeleton variant="block" width="100%" height={36} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton variant="block" width="100%" height={36} />
            <Skeleton variant="block" width="100%" height={36} />
          </div>
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </Section>

        <Section title={<Skeleton variant="block" width={140} height={20} />}>
          <Skeleton variant="block" width="100%" height={36} />
          <Skeleton variant="block" width="100%" height={160} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton variant="block" width="100%" height={36} />
            <Skeleton variant="block" width="100%" height={36} />
          </div>
        </Section>
      </div>
    </div>
  );
}
