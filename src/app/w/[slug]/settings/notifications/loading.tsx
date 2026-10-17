import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell for settings → Notifications.
 *
 * Mirrors the form: the digest card and the per-event rows, so the sections do
 * not jump once the preferences resolve.
 */
export default function NotificationsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] px-8 py-12"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading notification preferences…</span>

      <Skeleton variant="block" width={64} height={12} className="mb-3" />
      <Skeleton variant="block" width={200} height={28} className="mb-2" />
      <Skeleton variant="text" lines={2} className="mb-10" />

      <Section title={<Skeleton variant="block" width={160} height={20} />}>
        <div className="rounded-lg border border-border p-4">
          <Skeleton variant="block" width={140} height={16} className="mb-3" />
          <Skeleton variant="block" width={224} height={36} />
        </div>
        <div className="rounded-lg border border-border p-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton variant="block" width="35%" height={14} />
                <Skeleton variant="block" width="60%" height={10} />
              </span>
              <Skeleton variant="block" width={140} height={36} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
