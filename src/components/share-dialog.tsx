"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Globe, Link2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  createShareLinkAction,
  getShareLinkStateAction,
  revokeShareLinkAction,
} from "@/server/actions/share";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { AccessList } from "@/components/who-has-access";

/**
 * Notion-like share panel: "Who has access" (per-person levels) plus
 * "General access" (the public link with password, expiry and the
 * view/edit choice). Replaces the two `window.prompt` calls that used to
 * ask for the password and expiry.
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
  const [allowEditing, setAllowEditing] = useState(false);

  // The stored link choice (view vs edit) travels with the link, so re-read it
  // every time the panel opens. A plain read (same pattern as AccessList) —
  // deliberately NOT routed through run(), so a slow roundtrip never pins the
  // dialog's `pending` flag and never disables the controls.
  useEffect(() => {
    if (!open) return;
    let live = true;
    getShareLinkStateAction(pageId)
      .then((state) => {
        if (live) setAllowEditing(state.allowEditing);
      })
      .catch(() => {
        // Fail closed: keep the default read-only choice on any error.
      });
    return () => {
      live = false;
    };
  }, [open, pageId]);

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
          // A fresh link is read-only until the publisher opts into editing.
          setAllowEditing(false);
          onTokenChange(value);
          router.refresh();
        },
      },
    );

  /** The allow-editing toggle: persists READ/EDIT on the share record. */
  const chooseMode = (mode: "READ" | "EDIT") =>
    run(() => createShareLinkAction(pageId, { allowEditing: mode === "EDIT" }), {
      onSuccess: () => setAllowEditing(mode === "EDIT"),
    });

  const unpublish = () =>
    run(() => revokeShareLinkAction(pageId), {
      success: "Unpublished",
      onSuccess: () => {
        setCreated(null);
        setAllowEditing(false);
        onTokenChange(null);
        router.refresh();
      },
    });

  const active = created ?? token;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-full max-w-xl rounded-xl border border-border bg-bg p-4 shadow-2xl">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Globe className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "shareTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t(locale, "shareIntro")}
        </p>

        <section className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            {t(locale, "whoHasAccess")}
          </h3>
          <div className="mt-1">
            <AccessList pageId={pageId} locale={locale} />
          </div>
        </section>

        <section className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            {t(locale, "generalAccess")}
          </h3>

          {active ? (
            <div className="mt-2 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{t(locale, "anyoneWithLink")}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {allowEditing ? t(locale, "canEdit") : t(locale, "canView")}
                    </span>
                  </span>
                </span>
                <select
                  value={allowEditing ? "EDIT" : "READ"}
                  aria-label={t(locale, "anyoneWithLink")}
                  disabled={pending}
                  onChange={(event) => chooseMode(event.target.value as "READ" | "EDIT")}
                  className="h-8 shrink-0 rounded border border-border bg-bg px-2 text-xs disabled:opacity-50"
                >
                  <option value="READ">{t(locale, "canView")}</option>
                  <option value="EDIT">{t(locale, "canEdit")}</option>
                </select>
              </div>

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
              className="mt-2 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void publish();
              }}
            >
              <p className="text-xs text-muted">{t(locale, "linkRestricted")}</p>
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
        </section>

        {active && error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
