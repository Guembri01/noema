"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteChatThreadAction, renameChatThreadAction } from "@/server/actions/chat";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { safeAction } from "@/lib/actions-client";
import { markdownToText } from "@/lib/markdown";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Event that opens a conversation in the docked panel. `{ threadId }` targets an
 * existing one; omitting it opens a fresh conversation.
 */
export const OPEN_CHAT_EVENT = "noema:open-chat";

export type ChatThreadSummary = {
  id: string;
  title: string;
  pageId: string | null;
  page: { id: string; title: string; icon: string | null } | null;
  messages: { id: string; body: string; role?: string; createdAt: string | Date }[];
};

/* -------------------------------------------------------------------------- *
 * Pure mappings
 * -------------------------------------------------------------------------- */

/** The hover actions a thread row exposes. */
export type ThreadRowActionId = "rename" | "delete";

export type ThreadRowAction = {
  id: ThreadRowActionId;
  /** Destructive actions are confirmed and painted with `--danger`. */
  danger: boolean;
};

/** Rename is safe inline; delete always goes through a danger confirm. */
export const THREAD_ROW_ACTIONS: readonly ThreadRowAction[] = [
  { id: "rename", danger: false },
  { id: "delete", danger: true },
] as const;

export function threadRowAction(id: ThreadRowActionId): ThreadRowAction {
  return THREAD_ROW_ACTIONS.find((action) => action.id === id) ?? THREAD_ROW_ACTIONS[0];
}

/** Localised label for a row action. */
export function threadRowActionLabel(id: ThreadRowActionId, locale: string): string {
  return id === "rename" ? t(locale, "rename") : t(locale, "delete");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Compact relative time for a thread row ("now", "5m", "3h", "2d", "6w", then a
 * date). Pure — the caller passes `now` so the node tests are deterministic.
 */
export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "";
  const diff = now.getTime() - ms;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;
  if (diff < 5 * WEEK) return `${Math.floor(diff / WEEK)}w`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The timestamp a row dates itself by: the newest message, if there is one. */
export function threadLastAt(thread: ChatThreadSummary): string | Date | null {
  const last = thread.messages[thread.messages.length - 1];
  return last?.createdAt ?? null;
}

/* -------------------------------------------------------------------------- *
 * Loading / empty
 * -------------------------------------------------------------------------- */

/** A skeleton matching the thread-row layout, so nothing shifts on load. */
export function ChatThreadSkeleton({ rows = 5 }: { rows?: number }) {
  const count = Math.max(1, Math.min(10, Math.trunc(rows) || 5));
  return (
    <ul
      data-testid="chat-thread-skeleton"
      aria-hidden
      className="min-h-0 flex-1 space-y-1 overflow-hidden"
    >
      {Array.from({ length: count }).map((_, index) => (
        <li key={index} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton variant="circle" width={20} height={20} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton variant="block" className="h-3" width="70%" />
            <Skeleton variant="block" className="h-2.5" width="38%" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The empty state for the thread list: icon + title + hint + primary action. */
export function ChatThreadsEmpty({ locale, onNew }: { locale: string; onNew: () => void }) {
  return (
    <div data-testid="chat-threads-empty" className="min-h-0 flex-1">
      <EmptyState
        variant="compact"
        icon={<Bot className="h-4 w-4" />}
        title={t(locale, "chatEmptyThreads")}
        description={t(locale, "askAboutNotes")}
        primaryAction={
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<MessageSquarePlus className="h-4 w-4" />}
            onClick={onNew}
          >
            {t(locale, "newDiscussion")}
          </Button>
        }
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * SidebarChat
 * -------------------------------------------------------------------------- */

/**
 * Sidebar "Chat" tab: the conversation *list*.
 *
 * The conversation itself opens in the docked panel inside the main area, so a
 * discussion can be read next to the note it is about (and never squeezes the
 * sidebar). Rows show a title + relative time; rename and delete reveal on hover
 * *and* focus, and delete always confirms with a danger dialog.
 */
export function SidebarChat({
  threads,
  locale,
  loading = false,
}: {
  threads: ChatThreadSummary[];
  locale: string;
  /** Show the skeleton while the list is being fetched. */
  loading?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<ChatThreadSummary | null>(null);

  const open = (threadId?: string) => {
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { threadId } }));
  };

  const beginRename = (thread: ChatThreadSummary) => {
    setRenameValue(thread.title);
    setRenaming(thread.id);
  };

  const commitRename = (thread: ChatThreadSummary) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (next === thread.title) return;
    startTransition(async () => {
      const outcome = await safeAction(() => renameChatThreadAction(thread.id, next), { locale });
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      router.refresh();
    });
  };

  const remove = () => {
    const target = confirmTarget;
    if (!target) return;
    startTransition(async () => {
      const outcome = await safeAction(() => deleteChatThreadAction(target.id), { locale });
      if (!outcome.ok) toast.error(outcome.error);
      else toast.success(t(locale, "conversationDeleted"));
      setConfirmTarget(null);
      router.refresh();
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "discussions")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t(locale, "newDiscussion")}
          onClick={() => open()}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <ChatThreadSkeleton />
      ) : threads.length === 0 ? (
        <ChatThreadsEmpty locale={locale} onNew={() => open()} />
      ) : (
        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto scrollbar-thin">
          {threads.map((thread) => {
            const lastAt = threadLastAt(thread);
            const stamp = relativeTime(lastAt);
            return (
              <li key={thread.id}>
                <div className="group flex items-center gap-1 rounded-sm px-1 py-1 u-colors hover:bg-surface-2 focus-within:bg-surface-2">
                  {renaming === thread.id ? (
                    <Input
                      autoFocus
                      size="sm"
                      value={renameValue}
                      aria-label={t(locale, "discussionTitleAria")}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => commitRename(thread)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                      className="h-7 min-w-0 flex-1 text-sm"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => open(thread.id)}
                        className="focus-ring min-w-0 flex-1 rounded-xs px-1 text-left"
                      >
                        <span className="block truncate text-sm">
                          {thread.page ? `${thread.page.icon ?? "📄"} ` : ""}
                          {thread.title || t(locale, "newDiscussion")}
                        </span>
                        <span className="block truncate text-2xs text-muted">
                          {stamp || lastPreview(thread, locale)}
                        </span>
                      </button>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-0.5 opacity-0 u-colors",
                          "group-hover:opacity-100 group-focus-within:opacity-100",
                          pending && "opacity-50",
                        )}
                      >
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`${threadRowActionLabel("rename", locale)} ${
                            thread.title || t(locale, "discussionLower")
                          }`}
                          onClick={() => beginRename(thread)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`${threadRowActionLabel("delete", locale)} ${
                            thread.title || t(locale, "discussionLower")
                          }`}
                          onClick={() => setConfirmTarget(thread)}
                          className="text-muted hover:bg-danger-soft hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmTarget(null);
        }}
        tone="danger"
        title={t(locale, "delete")}
        description={
          confirmTarget
            ? `${t(locale, "delete")} “${confirmTarget.title || t(locale, "discussionLower")}”? This cannot be undone.`
            : ""
        }
        confirmLabel={t(locale, "delete")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={remove}
      />
    </div>
  );
}

/** A one-line preview used until the thread has a relative timestamp. */
function lastPreview(thread: ChatThreadSummary, locale: string): string {
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return t(locale, "noMessagesYet");
  if (last.role === "assistant") return `${t(locale, "aiPrefix")}${markdownToText(last.body).replace(/\s+/g, " ")}`;
  return last.body;
}
