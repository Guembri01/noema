"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy, Globe, Link2, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  createShareLinkAction,
  getShareLinkStateAction,
  revokeShareLinkAction,
  type ShareLinkState,
  type ShareOptions,
} from "@/server/actions/share";
import { useAction } from "@/lib/actions-client";
import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
  parseCoverPosition,
  type CoverPosition,
} from "@/lib/cover-position";
import { GRADIENTS, coverCss, type GradientId } from "@/lib/page-cover";
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
  allowDuplicate?: boolean;
  indexing?: boolean;
  exportRestricted?: boolean;
};

/**
 * Additive superset of the action's `ShareOptions`. `allowEditing` is persisted
 * today; the other three flags are forwarded so the read-only action module
 * (`src/server/actions/share.ts`) can opt in to storing them without a UI
 * change. Declaring the superset locally keeps this panel additive and free of
 * `any`.
 */
type PublishOptions = ShareOptions & PublishSettings;

/* ------------------------------------------------------------------------- *
 * Pure publish-settings model
 *
 * The panel renders three switches; each one's state has to become exactly one
 * patch key on the wire. That mapping is the only logic here, so it lives as a
 * pure function the node test can pin.
 * ------------------------------------------------------------------------- */

/** The three publish settings the switches own, in render order. */
export type PublishToggleId = "allowDuplicate" | "indexing" | "exportRestricted";

/** The live switch state (what the three toggles show). */
export type PublishSettingsState = Record<PublishToggleId, boolean>;

/** Label + explanatory hint per switch. Plain English until i18n catches up. */
export const PUBLISH_TOGGLES: readonly {
  id: PublishToggleId;
  label: string;
  hint: string;
}[] = [
  {
    id: "allowDuplicate",
    label: "Allow duplicate",
    hint: "Viewers can copy the published page into their own workspace.",
  },
  {
    id: "indexing",
    label: "Search-engine indexing",
    hint: "Let crawlers index this public page in search results.",
  },
  {
    id: "exportRestricted",
    label: "Export restricted",
    hint: "Disable exporting the published page to PDF, HTML or Markdown.",
  },
];

/**
 * One toggle's state as a single-key `ShareOptions` patch — never touching the
 * link's password, expiry or edit mode. Unknown ids yield `{}` so a bad caller
 * cannot smuggle an unrelated field onto the wire.
 */
export function publishTogglePatch(id: PublishToggleId, value: boolean): PublishOptions {
  switch (id) {
    case "allowDuplicate":
      return { allowDuplicate: value };
    case "indexing":
      return { indexing: value };
    case "exportRestricted":
      return { exportRestricted: value };
    default:
      return {};
  }
}

/** How long the copy button shows its success (checkmark) state, in ms. */
export const COPY_FEEDBACK_MS = 1500;

/* ------------------------------------------------------------------------- *
 * Public share-page model
 *
 * The public page (`src/app/s/[token]/page.tsx`) is a server component and may
 * only export route symbols, so the pure decisions it makes live here and are
 * imported. They are all DOM-free and DB-free: whether a link is still
 * available, whether the document embeds a database (and so wants the wide
 * reading measure) and how a stored cover becomes a banner.
 * ------------------------------------------------------------------------- */

/** Reading measure for a prose page (§3: comfortable measure). */
export const PROSE_MEASURE = "max-w-[720px]";
/** Reading measure for a page containing databases — wide enough for tables. */
export const WIDE_MEASURE = "max-w-[1100px]";

/** The wrapper width for a page, widened when it embeds a database. */
export function readingMeasure(hasDatabase: boolean): string {
  return hasDatabase ? WIDE_MEASURE : PROSE_MEASURE;
}

/** Doc node types that make a page "contain a database". */
const DATABASE_NODE_TYPES: ReadonlySet<string> = new Set([
  "linkedDatabase",
  "database",
  "inlineDatabase",
  "inline_database",
  "databaseView",
]);

/**
 * Whether a stored document embeds a database block. Walks the ProseMirror tree
 * generically (unknown shapes are ignored) and is cycle-safe, so malformed or
 * hostile content reads as "no database" rather than hanging.
 */
export function documentHasDatabase(content: unknown): boolean {
  const root =
    content && typeof content === "object" ? (content as { content?: unknown }) : null;
  const stack: unknown[] = Array.isArray(root?.content) ? [...root.content] : [];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const record = node as { type?: unknown; content?: unknown };
    if (typeof record.type === "string" && DATABASE_NODE_TYPES.has(record.type)) return true;
    if (Array.isArray(record.content)) {
      for (const child of record.content) stack.push(child);
    }
  }
  return false;
}

/** A page wants the wide measure when it is a database or embeds one. */
export function usesWideMeasure(page: {
  type?: string | null;
  content?: unknown;
}): boolean {
  return page.type === "DATABASE" || documentHasDatabase(page.content);
}

/** Coerce a Date or ISO string to epoch millis, or `null` when unusable. */
function toEpoch(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Whether a shared page should show the "no longer available" state: a missing
 * link, a soft-deleted page, or a link whose expiry has passed. The expiry
 * instant itself counts as expired (matching the guest-grant engine), and a
 * corrupt/absent expiry never hides a live page.
 */
export function isSharedPageUnavailable(
  link: { expiresAt?: Date | string | null } | null | undefined,
  page: { deletedAt?: Date | string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!link || !page) return true;
  if (page.deletedAt) return true;
  const expiresAt = toEpoch(link.expiresAt);
  return expiresAt !== null && expiresAt <= now.getTime();
}

/** Renderable banner: the `background-image` plus its focal point. */
export type CoverBanner = { backgroundImage: string; backgroundPosition: string };

/** Reverse lookup `coverCss` output → gradient preset id (mirrors the editor). */
const GRADIENT_ID_BY_CSS: ReadonlyMap<string, GradientId> = new Map(
  (Object.keys(GRADIENTS) as GradientId[]).map((id) => [GRADIENTS[id], id] as const),
);

/**
 * Split a stored cover string into its CSS value and the focal point encoded
 * after it (`"<css> <x>% <y>%"`). A cover without a position decodes centred.
 */
function splitStoredCover(raw: string): { css: string; position: CoverPosition } {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/**
 * Decode a persisted cover into a safe banner, or `null` for an absent or
 * unrecognised value. Gradients match the catalog by CSS value; an image URL is
 * re-validated through `coverCss`, so a hostile string never becomes a banner.
 * The stored position is threaded into `background-position`.
 */
export function coverBannerStyle(raw: string | null | undefined): CoverBanner | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const { css, position } = splitStoredCover(raw.trim());
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) {
    return {
      backgroundImage: coverCss({ type: "gradient", gradientId }),
      backgroundPosition: formatObjectPosition(position),
    };
  }
  // Accept both a bare URL and the `url("…")` form the cover encoder writes,
  // then re-validate the URL through `coverCss` so nothing unsafe paints.
  const wrapped = css.match(/^url\(\s*"([^"]*)"\s*\)$/);
  const backgroundImage = coverCss({ type: "image", url: wrapped ? wrapped[1] : css });
  if (backgroundImage === "") return null;
  return {
    backgroundImage,
    backgroundPosition: formatObjectPosition(position),
  };
}

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
    <section className={cn("rounded-md border border-border bg-surface p-3", className)}>
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
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3",
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
 * The three publish switches with their explanatory hints. A single-field patch
 * per toggle is produced by {@link publishTogglePatch}.
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
        "focus-ring u-interactive u-colors inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-sm border px-3 text-sm",
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
          className="focus-ring h-9 w-full rounded-sm border border-border bg-bg px-2 text-sm"
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
  const [allowEditing, setAllowEditing] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [exportRestricted, setExportRestricted] = useState(false);
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
        setAllowEditing(state.allowEditing);
        // Forward-compatible read-back: the action currently returns only
        // `allowEditing`, so the extra settings stay at their defaults until
        // `getShareLinkStateAction` opts in (named follow-up).
        const extra: ShareLinkState & Partial<PublishSettings> = state;
        setAllowDuplicate(extra.allowDuplicate ?? false);
        setIndexing(extra.indexing ?? false);
        setExportRestricted(extra.exportRestricted ?? false);
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
    // Additive payload: the publish settings travel with the link. The action
    // persists `allowEditing` today; the other keys are forwarded so it can
    // store them once `ShareOptions` (and the share model) opt in.
    const options: PublishOptions = {
      password: password.trim() || undefined,
      expiresInDays: days.trim() ? Number(days) : undefined,
      allowEditing,
      ...publishTogglePatch("allowDuplicate", allowDuplicate),
      ...publishTogglePatch("indexing", indexing),
      ...publishTogglePatch("exportRestricted", exportRestricted),
    };
    return run(() => createShareLinkAction(pageId, options), {
      onSuccess: (result) => {
        if (!("url" in result)) return;
        const value = result.url.replace("/s/", "");
        setCreated(value);
        // A fresh link is read-only until the publisher opts into editing.
        setAllowEditing(false);
        onTokenChange(value);
        router.refresh();
      },
    });
  };

  /**
   * Persist one publish setting on the share link, mirroring it locally only
   * once the server accepts the change (same contract as `chooseMode`).
   */
  const saveSetting = (patch: PublishOptions, apply: () => void) =>
    run(() => createShareLinkAction(pageId, patch), { onSuccess: apply });

  /** The allow-editing choice: persists READ/EDIT on the share record. */
  const chooseMode = (mode: "READ" | "EDIT") =>
    saveSetting({ allowEditing: mode === "EDIT" }, () => setAllowEditing(mode === "EDIT"));

  /** One switch → one single-field patch, mirrored locally on success. */
  const toggleSetting = (id: PublishToggleId, value: boolean) => {
    const apply = () => {
      if (id === "allowDuplicate") setAllowDuplicate(value);
      else if (id === "indexing") setIndexing(value);
      else setExportRestricted(value);
    };
    saveSetting(publishTogglePatch(id, value), apply);
  };

  const unpublish = () => {
    setConfirmUnpublish(false);
    run(() => revokeShareLinkAction(pageId), {
      success: "Unpublished",
      onSuccess: () => {
        setCreated(null);
        setAllowEditing(false);
        setAllowDuplicate(false);
        setIndexing(false);
        setExportRestricted(false);
        onTokenChange(null);
        router.refresh();
      },
    });
  };

  const active = created ?? token;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="animate-scale-in max-h-[85vh] w-full max-w-xl overflow-y-auto scrollbar-thin rounded-xl border border-border bg-bg p-4 shadow-2xl">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Globe className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "shareTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted">{t(locale, "shareIntro")}</p>

        <div className="mt-4 space-y-6">
          <ShareSection title={t(locale, "invite")} hint={t(locale, "whoHasAccessIntro")}>
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
                        {allowEditing ? t(locale, "canEdit") : t(locale, "canView")}
                      </span>
                    </span>
                  </span>
                  <select
                    value={allowEditing ? "EDIT" : "READ"}
                    aria-label={t(locale, "anyoneWithLink")}
                    disabled={pending}
                    onChange={(event) => chooseMode(event.target.value as "READ" | "EDIT")}
                    className="focus-ring h-8 shrink-0 rounded-sm border border-border bg-bg px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="READ">{t(locale, "canView")}</option>
                    <option value="EDIT">{t(locale, "canEdit")}</option>
                  </select>
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
                    className="focus-ring mt-1 h-9 w-full rounded-sm border border-border bg-bg px-2 text-sm"
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
                    className="focus-ring mt-1 h-9 w-full rounded-sm border border-border bg-bg px-2 text-sm"
                  />
                </label>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={t(locale, "cancel")}
                    className="focus-ring u-colors h-9 rounded-sm border border-border px-3 text-sm text-muted hover:bg-surface-2"
                  >
                    {t(locale, "cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="focus-ring u-interactive u-colors flex h-9 items-center gap-1.5 rounded-sm bg-accent px-3 text-sm text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
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
                  settings={{ allowDuplicate, indexing, exportRestricted }}
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
                  className="focus-ring u-interactive flex h-9 items-center gap-1.5 rounded-sm bg-danger px-3 text-sm font-medium text-danger-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  {t(locale, "unpublish")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmUnpublish(false)}
                  className="focus-ring u-colors h-9 rounded-sm border border-border px-3 text-sm hover:bg-surface-2"
                >
                  {t(locale, "cancel")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmUnpublish(true)}
                className="focus-ring u-colors h-9 rounded-sm border border-border px-3 text-sm text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
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
            className="focus-ring u-colors h-9 rounded-sm border border-border px-3 text-sm hover:bg-surface-2"
          >
            {t(locale, "done")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
