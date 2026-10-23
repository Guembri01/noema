"use client";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import {
  PROJECT_AUTHORS,
  PROJECT_DOCS_URL,
  PROJECT_NAME,
  PROJECT_REPOSITORY,
} from "@/lib/project-info";
import { appVersion } from "@/lib/runtime-mode";

/**
 * Help → About.
 *
 * Credits belong where the person *using* the app can see them, not only where
 * someone browsing the repository can: a bundled installer has no README next to
 * it. The values come from `@/lib/project-info`, which is also what the
 * repository's `LICENSE`, `AUTHORS.md` and `package.json` describe, so the two
 * cannot disagree.
 *
 * The version is read through `appVersion()`: the shell's own value in the
 * desktop app, the build-time constant on the site. `dev` is a truthful answer
 * for a development build, and the row is hidden rather than shown empty.
 */
export function AboutDialog({
  open,
  onClose,
  locale = "en",
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}) {
  const version = appVersion();
  const link =
    "focus-ring rounded-sm underline decoration-border underline-offset-2 hover:text-fg";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        className="w-full max-w-md rounded-overlay border border-border bg-bg p-5 shadow-2xl"
        aria-label={t(locale, "about")}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-lg bg-action text-lg font-semibold text-action-fg"
          >
            {PROJECT_NAME.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{PROJECT_NAME}</h2>
            <p className="text-xs text-muted">
              {t(locale, "aboutVersion")} {version}
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm">{t(locale, "aboutTagline")}</p>

        <p className="mt-3 text-xs text-muted">{t(locale, "aboutLocalFirst")}</p>

        <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-xs text-muted">
              {t(locale, "aboutCreatedBy")}
            </dt>
            <dd>{PROJECT_AUTHORS.join(" · ")}</dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-muted">{t(locale, "aboutBuiltWith")}</p>
        <p className="mt-1 text-xs text-muted">{t(locale, "aboutLicense")}</p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-3 text-xs">
            <a href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer noopener" className={link}>
              {t(locale, "aboutSource")}
            </a>
            <a href={PROJECT_DOCS_URL} target="_blank" rel="noreferrer noopener" className={link}>
              {t(locale, "aboutDocs")}
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring u-interactive h-9 rounded-control border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "close")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
