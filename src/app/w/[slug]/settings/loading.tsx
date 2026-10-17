import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → index.
 *
 * It mirrors the real page: a page title, the General section, the settings
 * nav grid and the roster, all built from the shared `Skeleton` so nothing
 * shifts when the data lands (docs/DESIGN_SYSTEM.md §8).
 */
export default function SettingsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading workspace settings…</span>

      <Skeleton variant="block" width={240} height={28} className="mb-8" />

      <Section title={<Skeleton variant="block" width={96} height={20} />}>
        <Skeleton variant="block" width={200} height={16} />
        <Skeleton variant="block" width={140} height={12} />
      </Section>

      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
          >
            <Skeleton variant="block" width="40%" height={14} />
            <Skeleton variant="block" width="80%" height={10} />
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton variant="block" width={120} height={20} />
          <Skeleton variant="block" width={260} height={12} />
        </div>
        <Skeleton variant="table" rows={4} cols={3} />
      </div>

      <div className="mt-10 flex flex-col gap-6">
        <Skeleton variant="block" width={140} height={20} />
        <Skeleton variant="table" rows={3} cols={3} />
      </div>
    </div>
  );
}
