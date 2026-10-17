"use client";

import { useEffect } from "react";
import {
  fingerprint,
  normalizeError,
  shouldSample,
  toBreadcrumb,
} from "@/lib/error-tracking";
import { reportClientErrorAction } from "@/server/actions/diagnostics";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

/** Context stamped on every capture; Next's boundary has no pathname here. */
const REPORT_ROUTE = "app/error";
const REPORT_ACTION = "render";

/**
 * Fraction of distinct client errors forwarded to the server sink. Deterministic
 * per fingerprint (`shouldSample`), so a noisy bug never floods the action.
 */
const SAMPLE_RATE = 1;

/**
 * Route-level error boundary. Renders inside the root layout, so the document
 * shell (html lang/dir + skip link) comes from app/layout.tsx; this component
 * contributes the main landmark, the single h1 and an accessible retry control
 * that scripts/check-a11y.mjs audits. Text is intentionally terse English for
 * now — i18n keys go through the i18n key inserter (i18n.ts is mid-edit by a
 * concurrent suite; queued as B46 blocked follow-up).
 *
 * On mount it turns the thrown value into a normalised, redacted breadcrumb and
 * forwards it to the `diagnostics` server action for fingerprint grouping. Every
 * client-side step (`normalizeError` / `fingerprint` / `shouldSample` /
 * `toBreadcrumb`) is total, so reporting can never throw over the boundary.
 */
export default function RouteError({ error, reset }: Props) {
  useEffect(() => {
    const normalized = normalizeError(error);
    const errorFingerprint = fingerprint(error, {
      route: REPORT_ROUTE,
      action: REPORT_ACTION,
    });
    if (!shouldSample(errorFingerprint, SAMPLE_RATE)) return;

    const timestamp = Date.now();
    const breadcrumb = toBreadcrumb({
      error,
      route: REPORT_ROUTE,
      action: REPORT_ACTION,
      fingerprint: errorFingerprint,
      timestamp,
    });

    void reportClientErrorAction({
      id: `${breadcrumb.data.fingerprint}:${timestamp}`,
      error: {
        name: normalized.name,
        message: normalized.message,
        ...(normalized.stack !== undefined ? { stack: normalized.stack } : {}),
        ...(normalized.code !== undefined ? { code: normalized.code } : {}),
        ...(normalized.cause !== undefined ? { cause: normalized.cause } : {}),
      },
      route: REPORT_ROUTE,
      action: REPORT_ACTION,
      timestamp,
      fingerprint: breadcrumb.data.fingerprint,
    });
  }, [error]);

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
