"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import {
  CalendarDays,
  Home,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { PageTreeNode } from "@/server/queries";
import { SidebarChat, OPEN_CHAT_EVENT } from "@/components/sidebar-chat";
import {
  SidebarMeetings,
  type CalendarFeedView,
  type MeetingEventView,
} from "@/components/sidebar-meetings";
import { createPageAction } from "@/server/actions/pages";
import { discussPageAction } from "@/server/actions/chat";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { safeAction } from "@/lib/actions-client";
import { NotionImportDialog } from "@/components/notion-import-dialog";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { Kbd } from "@/components/ui/kbd";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { useIsMac } from "@/lib/use-is-mac";
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher";
import { HomeQuickLinks, FavoritesList } from "@/components/sidebar/home-links";
import { PageTree } from "@/components/sidebar/page-tree";
import { ImportSection } from "@/components/sidebar/importers";
import { SidebarFooter } from "@/components/sidebar/sidebar-footer";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STEP,
  SIDEBAR_STEP_LARGE,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  parseStoredSidebarWidth,
} from "@/lib/sidebar-layout";
import { ResizablePanel } from "@/components/ui/resizable-panel";

type SidebarProps = {
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
  favorites: { page: { id: string; title: string; icon: string | null } }[];
  user: { name: string; email: string };
  unreadCount: number;
  locale: string;
  chatThreads: Parameters<typeof SidebarChat>[0]["threads"];
  meetingEvents: MeetingEventView[];
  calendarFeeds: CalendarFeedView[];
  projects: { id: string; name: string; icon: string | null }[];
  openTickets: number;
  onOpenQuickFind: () => void;
  /** Collapse the sidebar to nothing (desktop). Ctrl/Cmd+\ also toggles it. */
  onHideSidebar?: () => void;
};

export function Sidebar({
  workspace,
  workspaces,
  tree,
  teamspaces,
  favorites,
  user,
  unreadCount,
  locale,
  chatThreads,
  meetingEvents,
  calendarFeeds,
  projects,
  openTickets,
  onOpenQuickFind,
  onHideSidebar,
}: SidebarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.filter((p) => p.parentId === null).map((p) => p.id)),
  );
  const [notionOpen, setNotionOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState<"home" | "chat" | "meetings">("home");

  // --- Sidebar width: restore + persist -----------------------------------
  // The drag/keyboard/reset behaviour itself lives in `ResizablePanel`; this
  // component only owns the persisted width and the storage round-trip.
  useEffect(() => {
    try {
      setWidth(parseStoredSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)));
    } catch {
      /* private mode / storage blocked: keep the default width */
    }
  }, []);

  const commitWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setWidth(next);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
    } catch {
      /* ignore storage failures */
    }
  }, []);

  // Platform-aware chord hints for the footer's "Quick find" affordances.
  const isMac = useIsMac();

  const discuss = (pageId: string) =>
    startTransition(async () => {
      const outcome = await safeAction(() => discussPageAction(pageId));
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      setTab("chat");
      window.dispatchEvent(
        new CustomEvent(OPEN_CHAT_EVENT, { detail: { threadId: value.threadId } }),
      );
    });

  const sidebarTabs = [
    { id: "home" as const, label: t(locale, "home"), icon: Home },
    { id: "chat" as const, label: t(locale, "chat"), icon: MessageSquare },
    { id: "meetings" as const, label: t(locale, "meetings"), icon: CalendarDays },
  ];

  const addPage = (parentId: string | null, type: "PAGE" | "DATABASE") => {
    startTransition(async () => {
      const outcome = await safeAction(() =>
        createPageAction({ workspaceId: workspace.id, parentId, type }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <ResizablePanel
      as="aside"
      testId="sidebar"
      width={width}
      defaultWidth={SIDEBAR_DEFAULT_WIDTH}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      step={SIDEBAR_STEP}
      largeStep={SIDEBAR_STEP_LARGE}
      onResize={setWidth}
      onResizeEnd={commitWidth}
      label={t(locale, "resizeSidebar")}
      handleTitle={t(locale, "resizePanelHint")}
      handleTestId="sidebar-resize"
      handleClassName="z-[var(--z-sidebar)]"
      className="flex h-screen shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <WorkspaceSwitcher
        workspace={workspace}
        workspaces={workspaces}
        user={user}
        locale={locale}
        onCreateWorkspace={() => setCreateOpen(true)}
      />

      <div className="flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={onOpenQuickFind}
          className="focus-ring u-interactive u-colors flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate text-left">{t(locale, "quickFind")}</span>
          {/* The chord comes from the registry, not a literal: this chip used to
              read "Ctrl K", which is the command palette, and it was wrong on
              macOS too. `useIsMac` starts false so the first paint cannot
              disagree with the server. */}
          <Kbd>{formatShortcut("quick-find", { isMac }) || "Ctrl+P"}</Kbd>
        </button>
        {onHideSidebar ? (
          <button
            type="button"
            onClick={onHideSidebar}
            title={`${t(locale, "hideSidebar")} (${formatShortcut("toggle-sidebar", { isMac })})`}
            aria-label={t(locale, "hideSidebar")}
            data-testid="sidebar-hide"
            className="focus-ring u-interactive u-colors shrink-0 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="px-2 pt-1">
        <div
          role="tablist"
          aria-label={t(locale, "sidebarNavigation")}
          className="flex items-center gap-0.5"
        >
          {sidebarTabs.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  "focus-ring u-interactive u-colors flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium",
                  active
                    ? "bg-surface-2 text-fg"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {tab === "home" && (
        <>
          <HomeQuickLinks
            workspace={workspace}
            projects={projects}
            openTickets={openTickets}
            unreadCount={unreadCount}
            locale={locale}
          />
          <FavoritesList workspace={workspace} favorites={favorites} locale={locale} />
          <PageTree
            tree={tree}
            teamspaces={teamspaces}
            projects={projects}
            workspace={workspace}
            locale={locale}
            expanded={expanded}
            setExpanded={setExpanded}
            pending={pending}
            addPage={addPage}
            discuss={discuss}
            startTransition={startTransition}
          >
            <ImportSection
              workspace={workspace}
              addPage={addPage}
              locale={locale}
              startTransition={startTransition}
              onOpenNotion={() => setNotionOpen(true)}
            />
          </PageTree>

          <div className="mt-1 px-1">
            <button
              type="button"
              disabled={pending}
              onClick={() => addPage(null, "PAGE")}
              className="focus-ring u-interactive u-colors flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted hover:bg-surface-2"
            >
              <Plus className="h-4 w-4" />
              {t(locale, "add")}
            </button>
            <Link
              href={`/w/${workspace.slug}/settings`}
              className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted hover:bg-surface-2"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {t(locale, "customizeSidebar")}
            </Link>
          </div>
        </>
      )}

      <div className={cn("flex min-h-0 flex-1 flex-col", tab !== "chat" && "hidden")}>
        <SidebarChat threads={chatThreads} locale={locale} />
      </div>

      <div className={cn("flex min-h-0 flex-1 flex-col", tab !== "meetings" && "hidden")}>
        <SidebarMeetings
          workspaceId={workspace.id}
          slug={workspace.slug}
          events={meetingEvents}
          feeds={calendarFeeds}
          locale={locale}
        />
      </div>

      <SidebarFooter
        locale={locale}
        user={user}
        workspace={workspace}
        onOpenQuickFind={onOpenQuickFind}
        quickFindHint={formatShortcut("quick-find", { isMac })}
        startTransition={startTransition}
      />

      <WorkspaceDialog
        open={createOpen}
        mode="create"
        locale={locale}
        onClose={() => setCreateOpen(false)}
      />

      <NotionImportDialog locale={locale}
        open={notionOpen}
        onOpenChange={setNotionOpen}
        workspaceId={workspace.id}
        slug={workspace.slug}
      />
    </ResizablePanel>
  );
}
