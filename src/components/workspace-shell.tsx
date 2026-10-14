"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { OPEN_CHAT_EVENT } from "@/components/sidebar-chat";
import { ChatPanel, type PanelThread } from "@/components/chat-panel";
import type { CalendarFeedView, MeetingEventView } from "@/components/sidebar-meetings";
import { QuickFind } from "@/components/quick-find";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { PageTreeNode } from "@/server/queries";

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const searchParams = useSearchParams();

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuickOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        className={cn(
          "fixed inset-y-0 left-0 z-40 md:static md:z-auto",
          sidebarOpen ? "block" : "hidden md:block",
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
        />
      </div>

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
    </div>
  );
}
