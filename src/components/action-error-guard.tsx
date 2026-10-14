"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { describeActionError } from "@/lib/actions-client";

/**
 * Safety net for Server Action failures.
 *
 * Individual call sites are wrapped, but a missed one used to fail silently:
 * the transition never settled and the UI hung on "Saving…". Any unhandled
 * rejection that looks like a failed action now surfaces a toast instead.
 */
export function ActionErrorGuard({ locale = "en" }: { locale?: string }) {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "");
      if (!/server action|failed to fetch|load failed|unexpected response|network/i.test(message)) {
        return;
      }
      event.preventDefault();
      toast.error(describeActionError(reason, locale));
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [locale]);
  return null;
}
