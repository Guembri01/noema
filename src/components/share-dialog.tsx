"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Globe, Link2, Lock } from "lucide-react";
import { toast } from "sonner";
import { createShareLinkAction, revokeShareLinkAction } from "@/server/actions/share";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/**
 * Publish a page to the web. Replaces the two `window.prompt` calls that used to
 * ask for the password and expiry: accessible, styled, and it shows the finished
 * link with a copy button instead of silently copying it.
 */
export function ShareDialog({
  open,
  locale = "en",
  pageId,
  token,
  onTokenChange,
  onClose,
}: {
  open: boolean;
  pageId: string;
  token: string | null;
  onTokenChange: (token: string | null) => void;
  onClose: () => void;
  locale?: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  const link = (value: string) =>
    typeof window === "undefined" ? `/s/${value}` : `${window.location.origin}/s/${value}`;

  const publish = () =>
    run(
      () =>
        createShareLinkAction(pageId, {
          password: password.trim() || undefined,
          expiresInDays: days.trim() ? Number(days) : undefined,
        }),
      {
        onSuccess: (result) => {
          if (!("url" in result)) return;
          const value = result.url.replace("/s/", "");
          setCreated(value);
          onTokenChange(value);
          router.refresh();
        },
      },
    );

  const unpublish = () =>
    run(() => revokeShareLinkAction(pageId), {
      success: "Unpublished",
      onSuccess: () => {
        setCreated(null);
        onTokenChange(null);
        router.refresh();
      },
    });

  const active = created ?? token;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Globe className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "shareTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t(locale, "shareIntro")}
        </p>

        {active ? (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              {t(locale, "publicLink")}
              <span className="mt-1 flex gap-2">
                <input
                  readOnly
                  value={link(active)}
                  aria-label={t(locale, "publicLink")}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link(active));
                    toast.success(t(locale, "copied"));
                  }}
                  className="flex h-9 shrink-0 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2"
                >
                  <Copy className="h-3.5 w-3.5" /> {t(locale, "copy")}
                </button>
              </span>
            </label>
            <div className="flex items-center justify-between">
              <button
                type="button"
                disabled={pending}
                onClick={unpublish}
                className="h-9 rounded border border-border px-3 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              >
                {t(locale, "unpublish")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded border border-border px-3 text-sm hover:bg-surface-2"
              >
                {t(locale, "done")}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void publish();
            }}
          >
            <label className="block text-sm">
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-muted" aria-hidden /> {t(locale, "passwordLabel")}
                <span className="text-[11px] text-muted">{t(locale, "optional")}</span>
              </span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t(locale, "passwordHint")}
                className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block text-sm">
              {t(locale, "expiresLabel")} <span className="text-[11px] text-muted">{t(locale, "optional")}</span>
              <input
                type="number"
                min="1"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                placeholder={t(locale, "never")}
                className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
              />
            </label>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
              >
                {t(locale, "cancel")}
              </button>
              <button
                type="submit"
                disabled={pending}
                className="flex h-9 items-center gap-1.5 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-40"
              >
                <Link2 className="h-3.5 w-3.5" /> {pending ? t(locale, "publishing") : t(locale, "publish")}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
