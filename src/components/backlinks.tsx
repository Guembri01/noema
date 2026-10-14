import Link from "next/link";
import { AtSign, Link2 } from "lucide-react";
import { t } from "@/lib/i18n";

/** A source page as either reference list renders it. */
type ReferenceItem = { id: string; title: string; icon: string | null };

/** One linked page per row; shared by both reference lists. */
function ReferenceList({
  items,
  workspaceSlug,
  locale,
}: {
  items: ReferenceItem[];
  workspaceSlug: string;
  locale: string;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/w/${workspaceSlug}/${item.id}`}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2"
          >
            <span className="w-4 text-center">{item.icon ?? "📄"}</span>
            <span className="truncate">{item.title || t(locale, "untitled")}</span>
          </Link>
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
 * rendering exactly the linked references as before.
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
            {t(locale, "mentionHeading")} ({unlinked.length})
          </h2>
          <ReferenceList items={unlinked} {...listProps} />
        </div>
      )}
    </section>
  );
}
