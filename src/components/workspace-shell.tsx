"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Database, FileText, Menu, PanelLeftOpen, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { OPEN_CHAT_EVENT } from "@/components/sidebar-chat";
import { ChatPanel, type PanelThread } from "@/components/chat-panel";
import type { CalendarFeedView, MeetingEventView } from "@/components/sidebar-meetings";
import { CommandPalette } from "@/components/command-palette";
import { QuickFind } from "@/components/quick-find";
import { safeAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  MAX_RECENT_PAGES,
  recentPages,
  recordVisit,
  removePage,
  type RecentPage,
} from "@/lib/recent-pages";
import { createPageAction } from "@/server/actions/pages";
import type { PageTreeNode } from "@/server/queries";

/** localStorage key holding one workspace's open page tabs (recent-first). */
function tabsStorageKey(workspaceId: string): string {
  return `notion:page-tabs:${workspaceId}`;
}

import {
  SIDEBAR_HIDDEN_STORAGE_KEY,
} from "@/lib/sidebar-layout";

/** Narrow one parsed storage entry to a {@link RecentPage} without trusting disk. */
function isTabEntry(value: unknown): value is RecentPage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.pageId === "string" && typeof entry.visitedAt === "number"
  );
}

/**
 * Load a workspace's persisted tab list. Absent, blocked (private mode) or
 * corrupt storage falls back to an empty strip; {@link recentPages} then
 * dedupes the survivors and orders them most-recently-opened first.
 */
function readTabs(workspaceId: string): RecentPage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(tabsStorageKey(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: unknown[] = parsed;
    return recentPages(entries.filter(isTabEntry), {
      limit: MAX_RECENT_PAGES,
      now: 0,
    });
  } catch {
    return [];
  }
}

export function WorkspaceShell({
  workspace,
  workspaces,
  tree,
  teamspaces,
  chatThreads,
  meetingEvents,
  calendarFeeds,
  projects,
  openTickets,
  aiModel,
  favorites,
  user,
  unreadCount,
  locale,
  children,
}: {
  workspace: {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
    role: string;
  };
  workspaces: { id: string; name: string; slug: string; icon: string | null }[];
  tree: PageTreeNode[];
  teamspaces: { id: string; name: string; icon: string | null }[];
  chatThreads: PanelThread[];
  aiModel: string;
  meetingEvents: MeetingEventView[];
  calendarFeeds: CalendarFeedView[];
  projects: { id: string; name: string; icon: string | null }[];
  openTickets: number;
  favorites: { page: { id: string; title: string; icon: string | null } }[];
  user: { name: string; email: string };
  unreadCount: number;
  locale: string;
  children: React.ReactNode;
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop collapse for the sidebar (Ctrl/Cmd+\, the sidebar's own button and
  // the palette action). Persisted so the choice survives a reload.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // In-session page tabs (most-recently-opened first), hydrated from
  // localStorage after mount so SSR and the first client paint agree.
  const [tabs, setTabs] = useState<RecentPage[]>([]);
  // The workspace whose strip is currently in `tabs`; `null` until hydrated.
  // Persistence is gated on it so switching workspace never writes the old
  // strip to the new workspace's key.
  const [tabsWorkspaceId, setTabsWorkspaceId] = useState<string | null>(null);

  /** id → node, so a tab can show its title/icon and only live pages stay open. */
  const pagesById = useMemo(
    () => new Map(tree.map((node) => [node.id, node])),
    [tree],
  );

  /** The page open in a bare `/w/<slug>/<pageId>` URL, else null. */
  const pagePrefix = `/w/${workspace.slug}/`;
  const activePageId =
    pathname.startsWith(pagePrefix) &&
    !pathname.slice(pagePrefix.length).includes("/")
      ? pathname.slice(pagePrefix.length)
      : null;

  // Hydrate the strip once per workspace. Declared before the persist and
  // record effects so a fresh load can never overwrite stored tabs with `[]`.
  useEffect(() => {
    setTabs(readTabs(workspace.id));
    setTabsWorkspaceId(workspace.id);
  }, [workspace.id]);

  // Restore the persisted desktop-sidebar state after mount so SSR and the
  // first client paint agree.
  useEffect(() => {
    try {
      setSidebarHidden(window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === "1");
    } catch {
      /* private mode / storage blocked: keep it visible */
    }
  }, []);

  // Persist every change so tabs survive reloads; storage being unavailable
  // (private mode / quota) leaves the in-memory strip intact.
  useEffect(() => {
    if (tabsWorkspaceId !== workspace.id) return;
    try {
      window.localStorage.setItem(
        tabsStorageKey(workspace.id),
        JSON.stringify(tabs),
      );
    } catch {
      // Ignore — the session keeps rendering from state.
    }
  }, [tabsWorkspaceId, workspace.id, tabs]);

  // Opening a page (a link or browser history) moves it to the front of the
  // strip. Only pages present in the tree become tabs, so reserved routes
  // (`/search`, `/trash`, …) are never recorded.
  useEffect(() => {
    if (!activePageId || !pagesById.has(activePageId)) return;
    setTabs((prev) => recordVisit(prev, activePageId, Date.now()));
  }, [activePageId, pagesById]);

  /** Tabs ordered most-recently-opened first, resolved to live pages. */
  const openTabs = useMemo(
    () =>
      recentPages(tabs, { limit: MAX_RECENT_PAGES, now: Date.now() })
        .map((entry) => ({ entry, node: pagesById.get(entry.pageId) }))
        .filter(
          (tab): tab is { entry: RecentPage; node: PageTreeNode } =>
            tab.node !== undefined,
        ),
    [tabs, pagesById],
  );

  const switchTab = useCallback(
    (pageId: string) => {
      router.push(`/w/${workspace.slug}/${pageId}`);
    },
    [router, workspace.slug],
  );

  const closeTab = useCallback((pageId: string) => {
    setTabs((prev) => removePage(prev, pageId));
  }, []);

  const toggleSidebar = useCallback(
    () =>
      setSidebarHidden((hidden) => {
        const next = !hidden;
        try {
          window.localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, next ? "1" : "0");
        } catch {
          /* private mode / storage blocked */
        }
        return next;
      }),
    [],
  );

  const createNewPage = useCallback(async () => {
    const outcome = await safeAction(() =>
      createPageAction({ workspaceId: workspace.id, parentId: null }),
    );
    if (!outcome.ok) return;
    const result = outcome.value;
    if ("ok" in result) {
      setPaletteOpen(false);
      setQuickOpen(false);
      router.push(`/w/${workspace.slug}/${result.id}`);
      router.refresh();
    }
  }, [router, workspace.id, workspace.slug]);

  // `?chat=<threadId>` deep-links a conversation: it opens on load (and on
  // navigation, e.g. from a shared link), so a discussion is addressable.
  const requestedThread = searchParams.get("chat");
  useEffect(() => {
    if (requestedThread) {
      setChatThreadId(requestedThread);
      setChatOpen(true);
    }
  }, [requestedThread]);

  // Any surface can open a conversation by dispatching OPEN_CHAT_EVENT.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      setChatThreadId(detail?.threadId ?? null);
      setChatOpen(true);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, []);

  // B43 shortcuts: Ctrl/Cmd+K and Ctrl/Cmd+P open the command palette,
  // Ctrl/Cmd+N creates a page, Ctrl/Cmd+\ toggles the sidebar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "k" || key === "p") {
        event.preventDefault();
        setQuickOpen(false);
        setPaletteOpen((open) => !open);
      } else if (key === "n") {
        event.preventDefault();
        void createNewPage();
      } else if (event.key === "\\" || event.code === "Backslash") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createNewPage, toggleSidebar]);

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="fixed inset-x-0 top-0 z-30 flex items-center gap-2 border-b border-border bg-bg px-3 py-2 md:hidden">
        <button
          type="button"
          aria-label={t(locale, "openNavigation")}
          onClick={() => setSidebarOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-medium">{workspace.name}</span>
      </div>

      <div
        data-testid="workspace-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 md:static md:z-auto",
          sidebarOpen
            ? sidebarHidden
              ? "block md:hidden"
              : "block"
            : sidebarHidden
              ? "hidden"
              : "hidden md:block",
        )}
      >
        <Sidebar
          workspace={workspace}
          workspaces={workspaces}
          tree={tree}
          teamspaces={teamspaces}
          chatThreads={chatThreads}
          meetingEvents={meetingEvents}
          calendarFeeds={calendarFeeds}
          projects={projects}
          openTickets={openTickets}
          favorites={favorites}
          user={user}
          unreadCount={unreadCount}
          locale={locale}
          onOpenQuickFind={() => setQuickOpen(true)}
          onHideSidebar={toggleSidebar}
        />
      </div>

      {/* Always-visible way back when the desktop sidebar is collapsed. */}
      {sidebarHidden ? (
        <button
          type="button"
          onClick={toggleSidebar}
          title="Show sidebar (Ctrl+\)"
          aria-label="Show sidebar"
          data-testid="sidebar-show"
          className="fixed left-3 top-3 z-40 hidden h-8 w-8 items-center justify-center rounded-md border border-border bg-bg text-muted shadow-sm transition-colors hover:bg-surface-2 hover:text-fg md:flex"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      ) : null}

      {sidebarOpen && (
        <button
          type="button"
          aria-label={t(locale, "closeNavigation")}
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1">
        <main id="main" className="min-w-0 flex-1 overflow-y-auto pt-12 md:pt-0">
          {openTabs.length > 0 && (
            <nav
              data-testid="workspace-tabs"
              aria-label={t(locale, "recent")}
              className="sticky top-12 z-20 flex items-stretch gap-1 overflow-x-auto border-b border-border bg-bg px-2 md:top-0"
            >
              {openTabs.map(({ entry, node }) => {
                const active = entry.pageId === activePageId;
                const title = node.title.trim() || t(locale, "untitled");
                return (
                  <div
                    key={entry.pageId}
                    className={cn(
                      "flex max-w-[12rem] shrink-0 items-center gap-0.5 rounded-t-md border border-b-0 px-2 py-1.5 text-sm",
                      active
                        ? "border-border bg-surface-2 text-fg"
                        : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <button
                      type="button"
                      data-page-id={entry.pageId}
                      aria-current={active ? "page" : undefined}
                      onClick={() => switchTab(entry.pageId)}
                      title={title}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      {node.icon ? (
                        <span aria-hidden className="shrink-0">
                          {node.icon}
                        </span>
                      ) : node.type === "DATABASE" ? (
                        <Database
                          aria-hidden
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      ) : (
                        <FileText
                          aria-hidden
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      )}
                      <span className="truncate">{title}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${t(locale, "close")} ${title}`}
                      onClick={() => closeTab(entry.pageId)}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:bg-border hover:text-fg"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </nav>
          )}
          {children}
        </main>
        {chatOpen && (
          <ChatPanel
            workspaceId={workspace.id}
            slug={workspace.slug}
            thread={
              chatThreads.find((thread) => thread.id === chatThreadId) ?? null
            }
            threads={chatThreads}
            modelLabel={aiModel}
            locale={locale}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
      <QuickFind
        open={quickOpen}
        onOpenChange={setQuickOpen}
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        locale={locale}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspaceSlug={workspace.slug}
        locale={locale}
        pages={tree}
        onCreatePage={() => void createNewPage()}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  );
}
