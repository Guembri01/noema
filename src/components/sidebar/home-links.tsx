"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  BookOpen,
  CalendarRange,
  CircleDot,
  ExternalLink,
  FolderKanban,
  StarOff,
} from "lucide-react";
import { toggleFavoriteAction } from "@/server/actions/pages";
import { useAction } from "@/lib/actions-client";
import { orderFavorites } from "@/lib/favorites";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

type HomeQuickLinksProps = {
  workspace: { slug: string };
  projects: { id: string; name: string; icon: string | null }[];
  openTickets: number;
  unreadCount: number;
  locale: string;
};

export function HomeQuickLinks({
  workspace,
  projects,
  openTickets,
  unreadCount,
  locale,
}: HomeQuickLinksProps) {
  const pathname = usePathname();
  return (
    <div className="px-2 pt-1">
      <Link
        href={`/w/${workspace.slug}/projects`}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2",
          pathname.startsWith(`/w/${workspace.slug}/projects`) && "bg-surface-2",
        )}
      >
        <FolderKanban className="h-4 w-4" />
        Projects
        {projects.length > 0 && (
          <span className="ml-auto text-[10px] text-muted">{projects.length}</span>
        )}
      </Link>
      <Link
        href={`/w/${workspace.slug}/tickets`}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2",
          pathname.startsWith(`/w/${workspace.slug}/tickets`) && "bg-surface-2",
        )}
      >
        <CircleDot className="h-4 w-4" />
        Tickets
        {openTickets > 0 && (
          <span className="ml-auto rounded bg-surface-2 px-1 text-[10px]">{openTickets}</span>
        )}
      </Link>
      <Link
        href={`/w/${workspace.slug}/cycles`}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2",
          pathname.startsWith(`/w/${workspace.slug}/cycles`) && "bg-surface-2",
        )}
      >
        <CalendarRange className="h-4 w-4" />
        {t(locale, "cycles")}
      </Link>
      <Link
        href={`/w/${workspace.slug}/library`}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2",
          pathname === `/w/${workspace.slug}/library` && "bg-surface-2",
        )}
      >
        <BookOpen className="h-4 w-4" />
        {t(locale, "library")}
      </Link>
      <Link
        href={`/w/${workspace.slug}/inbox`}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2",
          pathname === `/w/${workspace.slug}/inbox` && "bg-surface-2",
        )}
      >
        <Bell className="h-4 w-4" />
        <span className="flex-1 text-left">{t(locale, "inbox")}</span>
        {unreadCount > 0 && (
          <span className="rounded bg-accent px-1 text-[10px] text-accent-fg">
            {unreadCount}
          </span>
        )}
      </Link>
    </div>
  );
}

type FavoriteEntry = { page: { id: string; title: string; icon: string | null } };

type FavoritesListProps = {
  workspace: { id: string; slug: string };
  favorites: FavoriteEntry[];
  locale: string;
};

/**
 * Sidebar Favorites section (Notion parity).
 *
 * - Rendering order comes from `orderFavorites()` — deduped, input-stable, so
 *   the sequence the server queried (`Favorite.id asc`, insertion order) is the
 *   sequence that survives a reload.
 * - Hover (and keyboard focus) reveals the row actions: unfavorite and
 *   open-in-new-tab.
 * - Empty state renders the section with a hint instead of disappearing, so
 *   the feature stays discoverable; the count badge only shows with rows.
 */
export function FavoritesList({ workspace, favorites, locale }: FavoritesListProps) {
  const router = useRouter();
  const { run, pending } = useAction(locale);
  const items = orderFavorites(favorites);

  const unfavorite = (pageId: string) =>
    run(() => toggleFavoriteAction(workspace.id, pageId), {
      onSuccess: () => router.refresh(),
    });

  return (
    <section
      aria-label={t(locale, "favorites")}
      data-testid="favorites-section"
      className="mt-3 px-3"
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        <p className="flex-1 text-[11px] font-medium text-muted/90">
          {t(locale, "favorites")}
        </p>
        {items.length > 0 && (
          <span
            data-testid="favorites-count"
            className="rounded bg-surface-2 px-1 text-[10px] text-muted"
          >
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p
          data-testid="favorites-empty"
          className="px-1 pb-1 text-[11px] text-muted"
        >
          {t(locale, "noFavoritesHint")}
        </p>
      ) : (
        <ul data-testid="favorites-list" className="space-y-px">
          {items.map(({ page }) => (
            <li
              key={page.id}
              data-testid="favorite-item"
              data-page-id={page.id}
              className="group/fav flex items-center rounded-md hover:bg-surface-2"
            >
              <Link
                href={`/w/${workspace.slug}/${page.id}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-sm"
              >
                <span className="w-4 shrink-0 text-center text-sm">
                  {page.icon ?? "⭐"}
                </span>
                <span className="truncate">{page.title || "Untitled"}</span>
              </Link>
              <div className="flex shrink-0 items-center opacity-0 transition group-hover/fav:opacity-100 focus-within:opacity-100">
                <Tooltip label={t(locale, "openInNewTab")}>
                  <a
                    href={`/w/${workspace.slug}/${page.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t(locale, "openInNewTab")}
                    data-testid="favorite-open-new-tab"
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </Tooltip>
                <Tooltip label={t(locale, "removeFromFavorites")}>
                  <button
                    type="button"
                    aria-label={t(locale, "removeFromFavorites")}
                    data-testid="favorite-remove"
                    disabled={pending}
                    onClick={() => unfavorite(page.id)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-50"
                  >
                    <StarOff className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
