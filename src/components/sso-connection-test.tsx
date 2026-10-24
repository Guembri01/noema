"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAction } from "@/lib/actions-client";
import type { SsoConnectionTestReport } from "@/lib/sso/test-connection-types";
import { testSsoConnectionAction } from "@/server/actions/sso-connections";

/**
 * Admin-facing dry run. The result is always the action's report — a click is
 * pending until the server answers, and "passed" appears only when every check
 * passed. A failed request or a rejected report is rendered inline, never as a
 * success toast.
 */
export function SsoConnectionTestPanel({
  workspaceId,
  connectionId,
  locale,
}: {
  workspaceId: string;
  connectionId: string;
  locale: string;
}) {
  const { run, pending, error } = useAction(locale);
  const [report, setReport] = useState<SsoConnectionTestReport | null>(null);

  const test = () => {
    setReport(null);
    run(() => testSsoConnectionAction(workspaceId, connectionId), {
      silentError: true,
      onSuccess: (value) => {
        if ("ok" in value && value.ok) setReport(value.report);
      },
    });
  };

  const failed = report ? report.checks.filter((entry) => entry.status === "fail").length : 0;

  return (
    <Card variant="flat" padding="md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Test connection</h2>
          <p className="mt-1 text-sm text-muted">
            Checks the stored configuration without changing it or sending a sign-in request.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={test}
          leftIcon={
            pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )
          }
        >
          {pending ? "Testing…" : "Test connection"}
        </Button>
      </div>

      <div aria-live="polite" className="mt-4">
        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {report && (
          <div>
            <p
              className={
                report.passed
                  ? "flex items-center gap-2 text-sm font-medium text-success"
                  : "flex items-center gap-2 text-sm font-medium text-danger"
              }
            >
              {report.passed ? (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4" aria-hidden="true" />
              )}
              {report.passed
                ? "All checks passed."
                : `Connection check failed — ${failed} of ${report.checks.length} checks failed.`}
            </p>
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
              {report.checks.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                  {entry.status === "pass" ? (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-danger"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{entry.label}</span>
                    <span className="block text-xs text-muted">{entry.detail}</span>
                  </span>
                  <span
                    className={
                      entry.status === "pass"
                        ? "shrink-0 text-xs font-medium text-success"
                        : "shrink-0 text-xs font-medium text-danger"
                    }
                  >
                    {entry.status === "pass" ? "Pass" : "Fail"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
