import Link from "next/link";
import { Link2 } from "lucide-react";
import { t } from "@/lib/i18n";

/** "Linked references" — pages that @-mention the current page. */
export function Backlinks({
  items,
  workspaceSlug,
  locale,
}: {
  items: { id: string; title: string; icon: string | null }[];
  workspaceSlug: string;
  locale: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-12 border-t border-border pt-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Link2 className="h-4 w-4" />
        {t(locale, "linkedReferences")} ({items.length})
      </h2>
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
    </section>
  );
}
