"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteChatThreadAction, renameChatThreadAction } from "@/server/actions/chat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/**
 * Sidebar "Chat" tab: the conversation *list*.
 *
 * The conversation itself opens in the docked panel inside the main area, so a
 * discussion can be read next to the note it is about (and never squeezes the
 * sidebar).
 */
export function SidebarChat({
  threads,
  locale,
}: {
  threads: ChatThreadSummary[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = (threadId?: string) => {
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { threadId } }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "discussions")}
        </span>
        <button
          type="button"
          aria-label={t(locale, "newDiscussion")}
          onClick={() => open()}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      </div>

      {threads.length === 0 ? (
        <button
          type="button"
          onClick={() => open()}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2"
        >
          <Bot className="h-4 w-4" />
          {t(locale, "askAboutNotes")}
        </button>
      ) : (
        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto">
          {threads.map((thread) => {
            const last = thread.messages[thread.messages.length - 1];
            return (
              <li key={thread.id}>
                <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-2">
                  {renaming === thread.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      aria-label={t(locale, "discussionTitleAria")}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => {
                        if (blurTimer.current) clearTimeout(blurTimer.current);
                        startTransition(async () => {
                          const outcome = await safeAction(
                            () => renameChatThreadAction(thread.id, renameValue),
                            { locale },
                          );
                          if (!outcome.ok) toast.error(outcome.error);
                          setRenaming(null);
                          router.refresh();
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                      className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-sm outline-none focus:border-accent"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => open(thread.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-sm">
                          {thread.page ? `${thread.page.icon ?? "📄"} ` : ""}
                          {thread.title || t(locale, "newDiscussion")}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                          {last
                            ? `${last.role === "assistant" ? t(locale, "aiPrefix") : ""}${
                                last.role === "assistant"
                                  ? markdownToText(last.body).replace(/\s+/g, " ")
                                  : last.body
                              }`
                            : t(locale, "noMessagesYet")}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`${t(locale, "optionsFor")} ${thread.title || t(locale, "discussionLower")}`}
                            className={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted",
                              "opacity-0 hover:bg-bg group-hover:opacity-100 focus:opacity-100",
                              pending && "opacity-50",
                            )}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onSelect={() => open(thread.id)}>
                            <Bot className="h-4 w-4 text-muted" /> {t(locale, "openConversation")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenameValue(thread.title);
                              setRenaming(thread.id);
                            }}
                          >
                            <Pencil className="h-4 w-4 text-muted" /> {t(locale, "rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              startTransition(async () => {
                                const outcome = await safeAction(
                                  () => deleteChatThreadAction(thread.id),
                                  { locale },
                                );
                                if (!outcome.ok) toast.error(outcome.error);
                                else toast.success(t(locale, "conversationDeleted"));
                                router.refresh();
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
