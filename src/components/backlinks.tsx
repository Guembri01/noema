"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { AtSign, Link2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { linkUnlinkedMentionAction } from "@/server/actions/backlinks";

/** A source page as either reference list renders it. */
type ReferenceItem = { id: string; title: string; icon: string | null };

/**
 * Form handlers must resolve to `void`; the server action resolves to its
 * result union, so wrap it and let revalidation refresh the panel on success.
 */
async function linkMention(sourcePageId: string, targetPageId: string): Promise<void> {
  await linkUnlinkedMentionAction(sourcePageId, targetPageId);
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
  item: ReferenceItem;
  workspaceSlug: string;
  locale: string;
  targetPageId?: string;
}) {
  const body = (
    <>
      <span className="w-4 text-center">{item.icon ?? "📄"}</span>
      <span className="truncate">{item.title || t(locale, "untitled")}</span>
    </>
  );

  if (!targetPageId) {
    return (
      <Link
        href={`/w/${workspaceSlug}/${item.id}`}
        className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2 pr-2">
      <Link
        href={`/w/${workspaceSlug}/${item.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
      >
        {body}
      </Link>
      <form action={linkMention.bind(null, item.id, targetPageId)}>
        <button
          type="submit"
          className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          {t(locale, "link")}
        </button>
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
  items: ReferenceItem[];
  workspaceSlug: string;
  locale: string;
  targetPageId?: string;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
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

/**
 * "Linked references" — pages that link the current page — plus an
 * "Unlinked mentions" section when the engine found pages that only spell its
 * title out as plain text (nothing renders when both lists are empty).
 *
 * `unlinked` is optional so existing callers that only pass `items` keep
 * rendering exactly the linked references as before. Unlinked rows carry a
 * "Link" action that promotes the plain-text mention to a page link in the
 * source page; the destination id comes from the current route, so no caller
 * change is required.
 */
export function Backlinks({
  items,
  unlinked = [],
  workspaceSlug,
  locale,
}: {
  items: ReferenceItem[];
  /** Pages that mention the title without linking it (additive). */
  unlinked?: ReferenceItem[];
  workspaceSlug: string;
  locale: string;
}) {
  // The destination of an unlinked mention is the page being viewed; the route
  // is `/w/<slug>/<pageId>` (`src/lib/deep-links.ts`), so `pageId` is the
  // target the action links to. A route without one simply renders read-only.
  const params = useParams();
  const targetPageId = typeof params.pageId === "string" ? params.pageId : undefined;

  if (items.length === 0 && unlinked.length === 0) return null;

  const heading =
    "mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted";
  const listProps = { workspaceSlug, locale } as const;

  return (
    <section className="mt-12 border-t border-border pt-6">
      {items.length > 0 && (
        <div>
          <h2 className={heading}>
            <Link2 className="h-4 w-4" />
            {t(locale, "linkedReferences")} ({items.length})
          </h2>
          <ReferenceList items={items} {...listProps} />
        </div>
      )}
      {unlinked.length > 0 && (
        <div className={items.length > 0 ? "mt-6" : undefined}>
          <h2 className={heading}>
            <AtSign className="h-4 w-4" />
            {t(locale, "unlinkedMentions")} ({unlinked.length})
          </h2>
          <ReferenceList items={unlinked} {...listProps} targetPageId={targetPageId} />
        </div>
      )}
    </section>
  );
}
