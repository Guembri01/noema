"use client";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Route-level error boundary. Renders inside the root layout, so the document
 * shell (html lang/dir + skip link) comes from app/layout.tsx; this component
 * contributes the main landmark, the single h1 and an accessible retry control
 * that scripts/check-a11y.mjs audits. Text is intentionally terse English for
 * now — i18n keys go through scripts/i18n-insert.mjs (i18n.ts is mid-edit by a
 * sibling batch; queued as B46 blocked follow-up).
 */
export default function RouteError({ reset }: Props) {
  return (
    <main id="main" className="mx-auto min-h-[60vh] max-w-[720px] px-12 py-12">
      <h1 className="text-3xl font-semibold text-fg">Something went wrong</h1>
      <p className="mt-3 text-sm text-muted">
        This page hit an unexpected error. You can try again, or head back to
        your workspace.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Try again
      </button>
    </main>
  );
}
