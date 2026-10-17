"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

/* ------------------------------------------------------------------------- *
 * Pure row mappings (docs/DESIGN_SYSTEM.md §10 "node test for its pure
 * mapping"). Both the favorites list and the recents list render one page row;
 * the icon fallback and the untitled fallback are decided here, once.
 * ------------------------------------------------------------------------- */

export type SidebarPage = { id: string; title: string; icon: string | null };

/** The leading glyph when a page has no icon: favorites are starred, recents are not. */
export const FAVORITE_FALLBACK_ICON = "⭐";
export const RECENT_FALLBACK_ICON = "🕘";

export type SidebarRowLabel = {
  /** The glyph shown in the leading slot. */
  icon: string;
  /** The row's visible (and accessible) text. */
  label: string;
};

/**
 * Turn a page into a row label. A blank title falls back to `Untitled` (the
 * localized key) and a blank/absent icon falls back to the caller's glyph.
 */
export function sidebarRowLabel(
  page: SidebarPage | null | undefined,
  fallbackIcon: string,
  locale = "en",
): SidebarRowLabel {
  const icon =
    typeof page?.icon === "string" && page.icon.trim() !== ""
      ? page.icon
      : fallbackIcon;
  const label =
    typeof page?.title === "string" && page.title.trim() !== ""
      ? page.title
      : t(locale, "untitled");
  return { icon, label };
}

/** Row label for a favorite (star fallback). */
export function favoriteRowLabel(
  page: SidebarPage | null | undefined,
  locale = "en",
): SidebarRowLabel {
  return sidebarRowLabel(page, FAVORITE_FALLBACK_ICON, locale);
}

/** Row label for a recent page (clock fallback). */
export function recentRowLabel(
  page: SidebarPage | null | undefined,
  locale = "en",
): SidebarRowLabel {
  return sidebarRowLabel(page, RECENT_FALLBACK_ICON, locale);
}

/** Default number of recents the sidebar surfaces. */
export const RECENT_LIMIT = 5;

/**
 * The most recently visited pages, newest first. Assumes the input is ordered
 * oldest → newest (the shape a visit log stores); dedupes by page id and caps
 * the result, so a repeated visit never renders twice.
 */
export function recentRows(
  pages: readonly SidebarPage[],
  limit = RECENT_LIMIT,
): SidebarPage[] {
  const cap = Math.max(0, Math.trunc(limit) || 0);
  if (cap <= 0) return [];
  const seen = new Set<string>();
  const rows: SidebarPage[] = [];
  for (const page of [...pages].reverse()) {
    if (!page || typeof page.id !== "string" || page.id === "" || seen.has(page.id)) {
      continue;
    }
    seen.add(page.id);
    rows.push(page);
    if (rows.length >= cap) break;
  }
  return rows;
}

/** Whether a quick-link row is the active route. Pure so the sidebar can be pinned. */
export function quickLinkActive(pathname: string, href: string, exact = false): boolean {
  if (!href) return false;
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/* ------------------------------------------------------------------------- *
 * Home quick links
 * ------------------------------------------------------------------------- */

type QuickLink = {
  href: string;
  label: string;
  icon: typeof FolderKanban;
  exact?: boolean;
  count?: number;
  tone?: "neutral" | "accent";
};

export type QuickLinkInput = {
  workspace: { slug: string; role?: string };
  projects: { id: string; name: string; icon: string | null }[];
  openTickets: number;
  unreadCount: number;
  locale: string;
};

type HomeQuickLinksProps = QuickLinkInput;

/**
 * The quick links the sidebar offers.
 *
 * The tracker is not page-scoped: its pages refuse a `GUEST` (they answer
 * 404), so the sidebar does not offer the door in the first place. The
 * library and the inbox stay — the library is page-scoped and the inbox
 * carries the caller's own notifications.
 */
export function quickLinksFor({
  workspace,
  projects,
  openTickets,
  unreadCount,
  locale,
}: QuickLinkInput): QuickLink[] {
  const tracker = workspace.role !== "GUEST";
  return [
    ...(tracker
      ? [
          {
            href: `/w/${workspace.slug}/projects`,
            label: t(locale, "projectsHeading"),
            icon: FolderKanban,
            count: projects.length,
          },
          {
            href: `/w/${workspace.slug}/tickets`,
            label: t(locale, "tickets"),
            icon: CircleDot,
            count: openTickets,
          },
          {
            href: `/w/${workspace.slug}/cycles`,
            label: t(locale, "cycles"),
            icon: CalendarRange,
          },
        ]
      : []),
    {
      href: `/w/${workspace.slug}/library`,
      label: t(locale, "library"),
      icon: BookOpen,
      exact: true,
    },
    {
      href: `/w/${workspace.slug}/inbox`,
      label: t(locale, "inbox"),
      icon: Bell,
      exact: true,
      count: unreadCount,
      tone: "accent" as const,
    },
  ];
}

const QUICK_LINK_BASE =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted u-colors focus-ring hover:bg-surface-2 hover:text-fg";

function QuickLinkRow({ link }: { link: QuickLink }) {
  const pathname = usePathname();
  const active = quickLinkActive(pathname, link.href, link.exact);
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={cn(QUICK_LINK_BASE, active && "bg-surface-2 text-fg")}
    >
      <link.icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate text-left">{link.label}</span>
      {typeof link.count === "number" && link.count > 0 ? (
        <Badge
          size="sm"
          tone={link.tone ?? "neutral"}
          count={link.count}
          className="shrink-0"
        />
      ) : null}
    </Link>
  );
}

export function HomeQuickLinks(props: HomeQuickLinksProps) {
  const links = quickLinksFor(props);

  return (
    <nav aria-label={t(props.locale, "home")} className="flex flex-col gap-px px-2 pt-1">
      {links.map((link) => (
        <QuickLinkRow key={link.href} link={link} />
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------------- *
 * Favorites (and the recents list that shares this row shape)
 * ------------------------------------------------------------------------- */

type FavoriteEntry = { page: { id: string; title: string; icon: string | null } };

type FavoritesListProps = {
  workspace: { id: string; slug: string };
  favorites: FavoriteEntry[];
  locale: string;
};

/** One page row: leading glyph, truncated label, hover-revealed actions. */
function PageRow({
  href,
  icon,
  label,
  children,
  testId,
  pageId,
}: {
  href: string;
  icon: string;
  label: string;
  children?: ReactNode;
  testId: string;
  pageId: string;
}) {
  return (
    <li
      data-testid={testId}
      data-page-id={pageId}
      className="group/row flex items-center rounded-md u-colors hover:bg-surface-2"
    >
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-fg focus-ring"
      >
        <span aria-hidden className="w-4 shrink-0 text-center text-sm">
          {icon}
        </span>
        <span className="truncate" title={label}>
          {label}
        </span>
      </Link>
      {children ? (
        <div className="flex shrink-0 items-center pe-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
          {children}
        </div>
      ) : null}
    </li>
  );
}

const ROW_ACTION_BASE =
  "flex h-6 w-6 items-center justify-center rounded-sm text-muted u-colors focus-ring hover:bg-surface-3 hover:text-fg";

/**
 * Sidebar Favorites section (Notion parity).
 *
 * - Rendering order comes from `orderFavorites()` — deduped, input-stable, so
 *   the sequence the server queried (`Favorite.id asc`, insertion order) is the
 *   sequence that survives a reload.
 * - Hover (and keyboard focus) reveals the row actions: unfavorite and
 *   open-in-new-tab.
 * - Empty renders an actionable `EmptyState` (search all pages) instead of
 *   disappearing, so the feature stays discoverable; the count badge only shows
 *   with rows.
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
        <p className="flex-1 text-2xs font-medium text-muted/90">
          {t(locale, "favorites")}
        </p>
        {items.length > 0 && (
          <Badge size="sm" count={items.length} data-testid="favorites-count" />
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          variant="compact"
          data-testid="favorites-empty"
          title={t(locale, "favorites")}
          description={t(locale, "noFavoritesHint")}
          primaryAction={
            <Button asChild variant="secondary" size="sm">
              <Link href={`/w/${workspace.slug}/search`}>
                {t(locale, "goToSearchPage")}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul data-testid="favorites-list" className="space-y-px">
          {items.map(({ page }) => {
            const { icon, label } = favoriteRowLabel(page, locale);
            const href = `/w/${workspace.slug}/${page.id}`;
            return (
              <PageRow
                key={page.id}
                testId="favorite-item"
                pageId={page.id}
                href={href}
                icon={icon}
                label={label}
              >
                <Tooltip label={t(locale, "openInNewTab")}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t(locale, "openInNewTab")}
                    data-testid="favorite-open-new-tab"
                    className={ROW_ACTION_BASE}
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
                    className={cn(ROW_ACTION_BASE, "disabled:cursor-not-allowed disabled:opacity-50")}
                  >
                    <StarOff className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </Tooltip>
              </PageRow>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type RecentListProps = {
  workspace: { slug: string };
  recents: SidebarPage[];
  locale: string;
};

/**
 * Sidebar Recents section.
 *
 * Wired the same way as favorites: most-recent-first, deduped, hover tint +
 * `focus-ring`, and an actionable empty state. It ships ready for the sidebar to
 * mount once a visit log is threaded through (see the task's follow-ups).
 */
export function RecentList({ workspace, recents, locale }: RecentListProps) {
  const rows = recentRows(recents);
  return (
    <section aria-label={t(locale, "recent")} data-testid="recents-section" className="mt-3 px-3">
      <div className="flex items-center gap-1 px-1 pb-1">
        <p className="flex-1 text-2xs font-medium text-muted/90">
          {t(locale, "recent")}
        </p>
        {rows.length > 0 && <Badge size="sm" count={rows.length} data-testid="recents-count" />}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          variant="compact"
          data-testid="recents-empty"
          title={t(locale, "recent")}
          description={t(locale, "noResultsDot")}
          primaryAction={
            <Button asChild variant="secondary" size="sm">
              <Link href={`/w/${workspace.slug}/search`}>
                {t(locale, "goToSearchPage")}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul data-testid="recents-list" className="space-y-px">
          {rows.map((page) => {
            const { icon, label } = recentRowLabel(page, locale);
            return (
              <PageRow
                key={page.id}
                testId="recent-item"
                pageId={page.id}
                href={`/w/${workspace.slug}/${page.id}`}
                icon={icon}
                label={label}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
