"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  dragSidebarWidth,
  nudgeSidebarWidth,
  parseStoredSidebarWidth,
} from "@/lib/sidebar-layout";

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
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.filter((p) => p.parentId === null).map((p) => p.id)),
  );
  const [notionOpen, setNotionOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState<"home" | "chat" | "meetings">("home");

  // --- Sidebar width: restore, persist, drag + keyboard resize ------------
  useEffect(() => {
    try {
      setWidth(parseStoredSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)));
    } catch {
      /* private mode / storage blocked: keep the default width */
    }
  }, []);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const commitWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setWidth(next);
    widthRef.current = next;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
    } catch {
      /* ignore storage failures */
    }
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      setResizing(true);
      const onMove = (move: PointerEvent) => {
        setWidth(dragSidebarWidth(startWidth, move.clientX - startX));
      };
      const onUp = () => {
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        commitWidth(widthRef.current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [commitWidth],
  );

  const resizeByKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const shift = event.shiftKey;
      let next: number;
      if (event.key === "ArrowLeft") next = nudgeSidebarWidth(widthRef.current, -SIDEBAR_STEP, shift);
      else if (event.key === "ArrowRight") next = nudgeSidebarWidth(widthRef.current, SIDEBAR_STEP, shift);
      else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
      else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
      else return;
      event.preventDefault();
      commitWidth(next);
    },
    [commitWidth],
  );

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
    <aside
      data-testid="sidebar"
      style={{
        width,
        // Animate structural width changes (keyboard nudges, collapse/expand) on a
        // token, but never while dragging: a transitioned width would lag the
        // cursor instead of tracking it 1:1. This mirrors the reference app, which
        // animates the sidebar and disables the transition for the drag.
        transition: resizing ? "none" : "width var(--dur-2) var(--ease-smooth)",
      }}
      className="relative flex h-screen shrink-0 flex-col border-r border-border bg-sidebar"
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
          <Kbd>Ctrl K</Kbd>
        </button>
        {onHideSidebar ? (
          <button
            type="button"
            onClick={onHideSidebar}
            title={`${t(locale, "hideSidebar")} (Ctrl+\\)`}
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

      {/* Drag to resize. Keyboard-reachable: arrows nudge, Shift widens the
        step, Home/End jump to the min/max. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t(locale, "resizeSidebar")}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="sidebar-resize"
        onPointerDown={startResize}
        onKeyDown={resizeByKeyboard}
        onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className={cn(
          "absolute inset-y-0 -right-1 z-[var(--z-sidebar)] w-2 cursor-col-resize touch-none select-none",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent",
          "hover:after:bg-accent/50 focus-visible:after:bg-accent focus-visible:outline-none",
          // Dragging is 1:1: never let a transition lag the cursor while active.
          resizing && "u-no-transition after:w-0.5 after:bg-accent",
        )}
      />
    </aside>
  );
}
