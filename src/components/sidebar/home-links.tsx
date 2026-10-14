"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, BookOpen, CalendarRange, CircleDot, FolderKanban } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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

type FavoritesListProps = {
  workspace: { slug: string };
  favorites: { page: { id: string; title: string; icon: string | null } }[];
  locale: string;
};

export function FavoritesList({ workspace, favorites, locale }: FavoritesListProps) {
  if (favorites.length === 0) return null;
  return (
    <div className="mt-3 px-3">
      <p className="px-1 pb-1 text-[11px] font-medium text-muted/90">
        {t(locale, "favorites")}
      </p>
      <ul className="space-y-px">
        {favorites.map(({ page }) => (
          <li key={page.id}>
            <Link
              href={`/w/${workspace.slug}/${page.id}`}
              className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-surface-2"
            >
              <span className="w-4 text-center text-sm">
                {page.icon ?? "⭐"}
              </span>
              <span className="truncate">{page.title || "Untitled"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
