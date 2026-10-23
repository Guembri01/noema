"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy, Globe, Link2, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  createShareLinkAction,
  getShareLinkStateAction,
  revokeShareLinkAction,
  type ShareOptions,
} from "@/server/actions/share";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { generateShortCode, isValidShortCode, shortUrl } from "@/lib/short-link";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { AccessList } from "@/components/who-has-access";

/**
 * Publish settings this panel owns. Every field is optional so a toggle can
 * send a single-field patch without disturbing the link's password or expiry.
 */
type PublishSettings = {
  allowEditing?: boolean;
  indexing?: boolean;
};

/**
 * Additive superset of the action's `ShareOptions`. `allowEditing` is persisted
 * today; `indexing` is forwarded so the read-only action module
 * (`src/server/actions/share.ts`) can opt in to storing it without a UI
 * change. Declaring the superset locally keeps this panel additive and free of
 * `any`.
 */
type PublishOptions = ShareOptions & PublishSettings;

/* ------------------------------------------------------------------------- *
 * Pure publish-settings model
 *
 * The panel renders its switches; each one's state has to become exactly one
 * patch key on the wire. That mapping is the only logic here, so it lives as a
 * pure function the node test can pin.
 * ------------------------------------------------------------------------- */

/** The publish settings the switches own, in render order. */
export type PublishToggleId = "indexing";

/** The live switch state (what the switches show). */
export type PublishSettingsState = Record<PublishToggleId, boolean>;

/** Label + explanatory hint per switch. Plain English until i18n catches up. */
export const PUBLISH_TOGGLES: readonly {
  id: PublishToggleId;
  label: string;
  hint: string;
}[] = [
  {
    id: "indexing",
    label: "Search-engine indexing",
    hint: "Let crawlers index this public page in search results.",
  },
];

/**
 * One toggle's state as a single-key `ShareOptions` patch — never touching the
 * link's password, expiry or edit mode. Unknown ids yield `{}` so a bad caller
 * cannot smuggle an unrelated field onto the wire.
 *
 * Only the settings the public share page can actually honour are offered: the
 * page has no export and no "copy into my workspace", so the switches that
 * promised them were removed instead of lying (B36).
 */
export function publishTogglePatch(id: PublishToggleId, value: boolean): PublishOptions {
  switch (id) {
    case "indexing":
      return { indexing: value };
    default:
      return {};
  }
}

/** How long the copy button shows its success (checkmark) state, in ms. */
export const COPY_FEEDBACK_MS = 1500;

/* ------------------------------------------------------------------------- *
 * Public share-page model
 *
 * The pure decisions the public page makes — whether a link is available,
 * whether the document embeds a database, how a stored cover becomes a banner —
 * live in `@/lib/share-page` and are re-used here. They are *not* defined in this
 * file: it is a client module, so a non-component export would become a client
 * reference and the server component could not call it. See that module's header.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * Presentational pieces (exported so the share sections can be rendered and
 * asserted without a live dialog — Radix's portal renders nothing on the
 * server, so the sections must be reachable on their own).
 * ------------------------------------------------------------------------- */

/** A titled card section — the Card/Section rhythm inside the share panel. */
export function ShareSection({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-card border border-border bg-surface p-3", className)}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** A token-styled switch (`role="switch"`), keyboard reachable and disabled-aware. */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "focus-ring u-colors relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border",
        checked ? "border-action bg-action" : "border-border-strong bg-surface-3",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "u-transform pointer-events-none block h-3.5 w-3.5 rounded-full bg-bg",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/**
 * The publish switches with their explanatory hints. A single-field patch
 * per switch is produced by {@link publishTogglePatch}.
 */
export function PublishSettingsSection({
  settings,
  pending = false,
  onToggle,
}: {
  settings: PublishSettingsState;
  pending?: boolean;
  onToggle: (id: PublishToggleId, value: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {PUBLISH_TOGGLES.map((toggle) => (
        <div key={toggle.id} className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm">{toggle.label}</span>
            <span className="block text-xs text-muted">{toggle.hint}</span>
          </span>
          <Switch
            checked={settings[toggle.id]}
            disabled={pending}
            label={toggle.label}
            onCheckedChange={(value) => onToggle(toggle.id, value)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * A read-only link field with a copy button. Copying swaps the icon to a
 * checkmark for {@link COPY_FEEDBACK_MS} and never changes the control's size
 * (the label text stays constant, so there is no layout shift).
 */
export function CopyLinkButton({
  value,
  label,
  locale = "en",
  iconOnly = false,
  className,
}: {
  value: string;
  label?: string;
  locale?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    const absolute =
      value.startsWith("/") && typeof window !== "undefined"
        ? `${window.location.origin}${value}`
        : value;
    void navigator?.clipboard?.writeText(absolute).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    toast.success(t(locale, "copied"));
  };

  const announced = copied ? t(locale, "copied") : (label ?? t(locale, "copy"));
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={announced}
      title={announced}
      className={cn(
        "focus-ring u-interactive u-colors inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 text-sm",
        copied ? "border-success text-success" : "border-border hover:bg-surface-2",
        iconOnly && "w-9 px-0",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {!iconOnly && <span>{t(locale, "copy")}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? t(locale, "copied") : ""}
      </span>
    </button>
  );
}

/** One labelled read-only link row (public link / short link). */
function LinkField({
  label,
  value,
  locale,
}: {
  label: string;
  value: string;
  locale: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="mt-1 flex gap-2">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="focus-ring h-9 w-full rounded-control border-control bg-bg px-2 text-sm"
        />
        <CopyLinkButton value={value} locale={locale} />
      </span>
    </label>
  );
}

/** The published links: the canonical public link plus the session short link. */
export function LinkSection({
  url,
  shortUrl: shortHref,
  shortCode,
  locale = "en",
}: {
  url: string;
  shortUrl?: string | null;
  shortCode?: string | null;
  locale?: string;
}) {
  return (
    <div className="space-y-3">
      <LinkField label={t(locale, "publicLink")} value={url} locale={locale} />
      {shortHref ? (
        <div>
          <LinkField label={t(locale, "link")} value={shortHref} locale={locale} />
          {shortCode ? (
            <span className="mt-1 block font-mono text-2xs text-muted">{shortCode}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Notion-like share panel: "Invite" (who has access), "General access" (the
 * public link's view/edit choice), "Publish settings" (the three switches) and
 * "Link" (the copyable URLs). Replaces the two `window.prompt` calls that used
 * to ask for the password and expiry.
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
  const [indexing, setIndexing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  // The stored link choices travel with the link, so re-read them every time
  // the panel opens. A plain read (same pattern as AccessList) —
  // deliberately NOT routed through run(), so a slow roundtrip never pins the
  // dialog's `pending` flag and never disables the controls.
  useEffect(() => {
    if (!open) return;
    let live = true;
    getShareLinkStateAction(pageId)
      .then((state) => {
        if (!live) return;
        setIndexing(state.indexing);
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

  // Session-only short code for this page: seeded by the page id so it is
  // stable across re-renders and never reshuffles. Nothing is persisted — the
  // generated code lives only in this dialog. `isValidShortCode` is a defensive
  // guard (generateShortCode already avoids RESERVED_CODES), so a bad draw
  // simply hides the row instead of advertising a broken link.
  const shortCode = useMemo(() => {
    const code = generateShortCode({ seed: pageId });
    return isValidShortCode(code) ? code : null;
  }, [pageId]);

  const shortHref =
    shortCode === null
      ? null
      : shortUrl(typeof window === "undefined" ? "/s" : `${window.location.origin}/s`, shortCode);

  const publish = () => {
    // Additive payload: the publish settings travel with the link. Public
    // share links are read-only (there is no anonymous editing surface), so
    // `allowEditing` is deliberately not offered here — a new or republished
    // link is always READ. The other keys are forwarded so the action can
    // store them once `ShareOptions` (and the share model) opt in.
    const options: PublishOptions = {
      password: password.trim() || undefined,
      expiresInDays: days.trim() ? Number(days) : undefined,
      allowEditing: false,
      ...publishTogglePatch("indexing", indexing),
    };
    return run(() => createShareLinkAction(pageId, options), {
      onSuccess: (result) => {
        if (!("url" in result)) return;
        const value = result.url.replace("/s/", "");
        setCreated(value);
        onTokenChange(value);
        router.refresh();
      },
    });
  };

  /**
   * Persist one publish setting on the share link, mirroring it locally only
   * once the server accepts the change.
   */
  const saveSetting = (patch: PublishOptions, apply: () => void) =>
    run(() => createShareLinkAction(pageId, patch), { onSuccess: apply });

  /** One switch → one single-field patch, mirrored locally on success. */
  const toggleSetting = (id: PublishToggleId, value: boolean) => {
    const apply = () => {
      if (id === "indexing") setIndexing(value);
    };
    saveSetting(publishTogglePatch(id, value), apply);
  };

  const unpublish = () => {
    setConfirmUnpublish(false);
    run(() => revokeShareLinkAction(pageId), {
      success: "Unpublished",
      onSuccess: () => {
        setCreated(null);
        setIndexing(false);
        onTokenChange(null);
        router.refresh();
      },
    });
  };

  const active = created ?? token;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="animate-scale-in max-h-[85vh] w-full max-w-xl overflow-y-auto scrollbar-thin rounded-overlay border border-border bg-bg p-4 shadow-2xl">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Globe className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "shareTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted">{t(locale, "shareIntro")}</p>

        <div className="mt-4 space-y-6">
          <ShareSection title={t(locale, "whoHasAccess")} hint={t(locale, "whoHasAccessIntro")}>
            <AccessList pageId={pageId} locale={locale} />
          </ShareSection>

          <ShareSection title={t(locale, "generalAccess")}>
            {active ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{t(locale, "anyoneWithLink")}</span>
                      <span className="block truncate text-2xs text-muted">
                        {t(locale, "canView")} ·{" "}
                        <a href="/login" className="underline">
                          {t(locale, "signIn")}
                        </a>{" "}
                        to edit in Noema
                      </span>
                    </span>
                  </span>
                </div>
              </div>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void publish();
                }}
              >
                <p className="text-xs text-muted">{t(locale, "linkRestricted")}</p>
                <label className="block text-sm">
                  <span className="flex items-center gap-1.5">
                    <Lock className="h-3.5 w-3.5 text-muted" aria-hidden />{" "}
                    {t(locale, "passwordLabel")}
                    <span className="text-2xs text-muted">{t(locale, "optional")}</span>
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t(locale, "passwordHint")}
                    className="focus-ring mt-1 h-9 w-full rounded-control border-control bg-bg px-2 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  {t(locale, "expiresLabel")}{" "}
                  <span className="text-2xs text-muted">{t(locale, "optional")}</span>
                  <input
                    type="number"
                    min="1"
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    placeholder={t(locale, "never")}
                    className="focus-ring mt-1 h-9 w-full rounded-control border-control bg-bg px-2 text-sm"
                  />
                </label>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={t(locale, "cancel")}
                    className="focus-ring u-colors h-9 rounded-control border border-border px-3 text-sm text-muted hover:bg-surface-2"
                  >
                    {t(locale, "cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="focus-ring u-interactive u-colors flex h-9 items-center gap-1.5 rounded-control bg-action px-3 text-sm text-action-fg disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Link2 className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {pending ? t(locale, "publishing") : t(locale, "publish")}
                  </button>
                </div>
              </form>
            )}
          </ShareSection>

          {active && (
            <>
              <ShareSection title="Publish settings">
                <PublishSettingsSection
                  settings={{ indexing }}
                  pending={pending}
                  onToggle={toggleSetting}
                />
              </ShareSection>

              <ShareSection title={t(locale, "link")}>
                <LinkSection
                  url={link(active)}
                  shortUrl={shortHref}
                  shortCode={shortCode}
                  locale={locale}
                />
              </ShareSection>
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          {active ? (
            confirmUnpublish ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Unpublish this page?
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={unpublish}
                  aria-label={t(locale, "unpublish")}
                  className="focus-ring u-interactive flex h-9 items-center gap-1.5 rounded-control bg-danger px-3 text-sm font-medium text-danger-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  {t(locale, "unpublish")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmUnpublish(false)}
                  className="focus-ring u-colors h-9 rounded-control border border-border px-3 text-sm hover:bg-surface-2"
                >
                  {t(locale, "cancel")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmUnpublish(true)}
                className="focus-ring u-colors h-9 rounded-control border border-border px-3 text-sm text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(locale, "unpublish")}
              </button>
            )
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t(locale, "done")}
            className="focus-ring u-colors h-9 rounded-control border border-border px-3 text-sm hover:bg-surface-2"
          >
            {t(locale, "done")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
