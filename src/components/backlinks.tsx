"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { AtSign, Link2, RefreshCw } from "lucide-react";
import { linkUnlinkedMentionAction } from "@/server/actions/backlinks";
import { tagClass, type TagHue } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A source page as either reference list renders it. */
export type BacklinkItem = { id: string; title: string; icon: string | null };

/** Which reference list a section is. */
export type BacklinkKind = "linked" | "unlinked";

/** Tag-palette hue per section — linked references are blue, mentions orange. */
export const BACKLINK_SECTION_HUE: Record<BacklinkKind, TagHue> = {
  linked: "blue",
  unlinked: "orange",
};

/** One rendered section: its kind, chip hue and rows. */
export type BacklinkSection = {
  kind: BacklinkKind;
  hue: TagHue;
  items: BacklinkItem[];
};

/**
 * Pure: split the two reference lists into the sections that actually render.
 * An empty section is dropped (so the panel never shows a bare heading), order
 * is `linked` then `unlinked`, and the returned item arrays are fresh copies so
 * the panel never mutates the route's data.
 */
export function backlinkSections(
  linked: readonly BacklinkItem[] = [],
  unlinked: readonly BacklinkItem[] = [],
): BacklinkSection[] {
  const sections: BacklinkSection[] = [];
  if (linked.length > 0) {
    sections.push({ kind: "linked", hue: BACKLINK_SECTION_HUE.linked, items: [...linked] });
  }
  if (unlinked.length > 0) {
    sections.push({
      kind: "unlinked",
      hue: BACKLINK_SECTION_HUE.unlinked,
      items: [...unlinked],
    });
  }
  return sections;
}

/** Pure: total references across both lists. */
export function backlinkTotal(
  linked: readonly BacklinkItem[] = [],
  unlinked: readonly BacklinkItem[] = [],
): number {
  return linked.length + unlinked.length;
}

/**
 * Form handlers must resolve to `void`; the server action resolves to its
 * result union, so wrap it and let revalidation refresh the panel on success.
 */
async function linkMention(sourcePageId: string, targetPageId: string): Promise<void> {
  await linkUnlinkedMentionAction(sourcePageId, targetPageId);
}

/**
 * The "Link" submit control. `useFormStatus` reads the enclosing `<form>`'s
 * pending state, so the button disables and pulses while the mention is being
 * promoted to a real page link — no layout shift, the label stays put.
 */
function LinkMentionButton({ locale }: { locale: string }) {
  const { pending } = useFormStatus();
  const label = t(locale, "link");
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        "focus-ring u-interactive rounded-xs px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        pending && "animate-pulse-soft",
      )}
    >
      {pending ? `${label}…` : label}
    </button>
  );
}

/**
 * One row: the source-page link, plus — for unlinked mentions — a "Link" action
 * that rewrites the plain-text mention in that source page into a real page
 * link (see `linkUnlinkedMentionAction`). `targetPageId` is the page being
 * viewed (the mention's destination); when it is absent the row is exactly the
 * read-only link it has always been.
 */
function ReferenceRow({
  item,
  workspaceSlug,
  locale,
  targetPageId,
}: {
  item: BacklinkItem;
  workspaceSlug: string;
  locale: string;
  targetPageId?: string;
}) {
  const label = item.title || t(locale, "untitled");
  const body = (
    <>
      <span aria-hidden className="w-4 shrink-0 text-center">
        {item.icon ?? "📄"}
      </span>
      <span className="truncate" title={label}>
        {label}
      </span>
    </>
  );

  if (!targetPageId) {
    return (
      <Link
        href={`/w/${workspaceSlug}/${item.id}`}
        className="focus-ring u-colors flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2 pr-2">
      <Link
        href={`/w/${workspaceSlug}/${item.id}`}
        className="focus-ring u-colors flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
      >
        {body}
      </Link>
      <form action={linkMention.bind(null, item.id, targetPageId)}>
        <LinkMentionButton locale={locale} />
      </form>
    </div>
  );
}

/** One source page per row; shared by both reference lists. */
function ReferenceList({
  items,
  workspaceSlug,
  locale,
  targetPageId,
}: {
  items: BacklinkItem[];
  workspaceSlug: string;
  locale: string;
  targetPageId?: string;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {items.map((item) => (
        <li key={item.id}>
          <ReferenceRow
            item={item}
            workspaceSlug={workspaceSlug}
            locale={locale}
            targetPageId={targetPageId}
          />
        </li>
      ))}
    </ul>
  );
}

/** Section header: icon + label + a tag-palette count chip. */
function SectionHeading({ section, locale }: { section: BacklinkSection; locale: string }) {
  const Icon = section.kind === "linked" ? Link2 : AtSign;
  const label = t(locale, section.kind === "linked" ? "linkedReferences" : "unlinkedMentions");
  return (
    <h2 className="mb-3 flex items-center gap-2 text-sm font-medium tracking-wide text-muted uppercase">
      <Icon className="h-4 w-4" aria-hidden />
      {label}
      <span className={tagClass(section.hue)} title={`${section.items.length}`}>
        <span aria-hidden>{section.items.length}</span>
        <span className="sr-only">
          {" "}
          {section.items.length === 1 ? "reference" : "references"}
        </span>
      </span>
    </h2>
  );
}

/** Skeleton that matches the final two-column layout (no shift when it loads). */
function BacklinksSkeleton() {
  return (
    <section className="mt-12 border-t border-border pt-6" aria-busy="true" aria-live="polite">
      <div className="notion-skeleton mb-3 h-4 w-40 rounded-sm" />
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((row) => (
          <div key={row} className="notion-skeleton h-9 w-full rounded-sm" />
        ))}
      </div>
      <span className="sr-only">{t("en", "loading")}</span>
    </section>
  );
}

/**
 * "Linked references" — pages that link the current page — plus an
 * "Unlinked mentions" section when the engine found pages that only spell its
 * title out as plain text.
 *
 * States: `loading` (a skeleton matching the final layout), `error` (message +
 * retry), `empty` (icon + title + hint + primary action, shown only when the
 * caller opts in via `showEmpty`) and the populated panel. `items`/`unlinked`
 * keep the original shape, so every existing caller is unchanged.
 */
export function Backlinks({
  items,
  unlinked = [],
  workspaceSlug,
  locale,
  loading = false,
  error = null,
  showEmpty = false,
  truncated = false,
  onRetry,
}: {
  items: BacklinkItem[];
  /** Pages that mention the title without linking it (additive). */
  unlinked?: BacklinkItem[];
  workspaceSlug: string;
  locale: string;
  /** Renders the skeleton instead of the panel (additive). */
  loading?: boolean;
  /** Renders the error + retry state when set (additive). */
  error?: string | null;
  /** Render the actionable empty state instead of nothing (additive). */
  showEmpty?: boolean;
  /** The scan hit its 1000-page bound and says so (R80.13, D7). */
  truncated?: boolean;
  /** Retry/refresh handler; defaults to a route refresh. */
  onRetry?: () => void;
}) {
  const router = useRouter();
  // The destination of an unlinked mention is the page being viewed; the route
  // is `/w/<slug>/<pageId>` (`src/lib/deep-links.ts`), so `pageId` is the
  // target the action links to. A route without one simply renders read-only.
  const params = useParams();
  const targetPageId = typeof params.pageId === "string" ? params.pageId : undefined;
  const retry = onRetry ?? (() => router.refresh());

  if (loading) return <BacklinksSkeleton />;

  if (error) {
    return (
      <section className="mt-12 border-t border-border pt-6" role="alert">
        <div className="notion-empty">
          <div className="notion-empty-icon" aria-hidden>
            <AtSign className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-danger">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="focus-ring u-interactive mt-1 flex items-center gap-1 rounded-control border border-border px-2.5 py-1 text-xs text-fg hover:bg-surface-2"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </button>
        </div>
      </section>
    );
  }

  const sections = backlinkSections(items, unlinked);

  if (sections.length === 0) {
    if (!showEmpty) return null;
    return (
      <section className="mt-12 border-t border-border pt-6">
        <div className="notion-empty">
          {truncated ? <TruncationNote locale={locale} /> : null}
          <div className="notion-empty-icon" aria-hidden>
            <AtSign className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-fg">{t(locale, "linkedReferences")}</p>
          <p>
            Mention this page with @, or link it from another page, to collect
            its references here.
          </p>
          <button
            type="button"
            onClick={retry}
            className="focus-ring u-interactive mt-1 flex items-center gap-1 rounded-control bg-action px-2.5 py-1 text-xs text-action-fg hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-12 border-t border-border pt-6">
      {sections.map((section, index) => (
        <div key={section.kind} className={index > 0 ? "mt-6" : undefined}>
          <SectionHeading section={section} locale={locale} />
          <ReferenceList
            items={section.items}
            workspaceSlug={workspaceSlug}
            locale={locale}
            targetPageId={section.kind === "unlinked" ? targetPageId : undefined}
          />
        </div>
      ))}
      {truncated ? <TruncationNote locale={locale} /> : null}
    </section>
  );
}

/**
 * R80.13 (D7): the scan reads at most the 1000 most recently edited pages,
 * which used to be silent — a large workspace could hide references without
 * any signal. Rendered whenever the scan reports truncation.
 */
function TruncationNote({ locale }: { locale: string }) {
  return (
    <p className="mt-3 text-xs text-muted" role="note">
      {t(locale, "backlinksTruncated")}
    </p>
  );
}
