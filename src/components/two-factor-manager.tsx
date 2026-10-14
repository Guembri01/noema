"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  disableTwoFactorAction,
  enableTwoFactorAction,
  startTwoFactorAction,
} from "@/server/actions/two-factor";
import { t } from "@/lib/i18n";


export function TwoFactorManager({ enabled, locale }: { enabled: boolean; locale: string }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <ShieldCheck className="h-4 w-4" />
        {t(locale, "tfHeading")}
      </h2>

      {enabled ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm">
            {t(locale, "tfIs")} <strong>{t(locale, "tfEnabledWord")}</strong>.
          </p>
          <div className="flex items-center gap-2">
            <input
              aria-label={t(locale, "tfAuthCode")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              placeholder={t(locale, "tfEnterToDisable")}
              className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={pending || !code.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await disableTwoFactorAction(code);
                  if ("ok" in result) {
                    setCode("");
                    toast.success(t(locale, "tfDisabledToast"));
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                })
              }
              className="h-9 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
            >
              {t(locale, "tfDisable")}
            </button>
          </div>
        </div>
      ) : setup ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm text-muted">
            {t(locale, "tfSetupIntro")}
          </p>
          <code className="block select-all break-all rounded bg-surface px-2 py-1 text-xs">
            {setup.secret}
          </code>
          <p className="break-all text-xs text-muted">{setup.otpauth}</p>
          <div className="flex items-center gap-2">
            <input
              aria-label={t(locale, "tfAuthCode")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              placeholder="123456"
              className="h-9 w-40 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={pending || !code.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await enableTwoFactorAction(code);
                  if ("ok" in result) {
                    setSetup(null);
                    setCode("");
                    toast.success(t(locale, "tfEnabledToast"));
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                })
              }
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
            >
              {t(locale, "tfVerifyEnable")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await startTwoFactorAction();
              if ("secret" in result) setSetup(result);
              else toast.error(result.error);
            })
          }
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "tfEnable")}
        </button>
      )}
    </section>
  );
}
