"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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
    <main id="main" className="mx-auto min-h-dvh max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-title text-fg">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        This page hit an unexpected error. You can try again, or head back to
        your workspace. Nothing you had already saved was discarded.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/app">Back to workspace</Link>
        </Button>
      </div>
    </main>
  );
}
