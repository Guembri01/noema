"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  Check,
  Copy,
  History,
  MessageSquarePlus,
  MoreHorizontal,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  createChatThreadAction,
  deleteChatThreadAction,
  postChatMessageAction,
} from "@/server/actions/chat";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatAnswerItems } from "@/components/chat-answer-menu";
import { describeActionError, safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { OPEN_CHAT_EVENT } from "@/components/sidebar-chat";

export type ChatMessageMeta = {
  activity?: string[];
  intents?: string[];
  references?: { id: string; title: string; icon: string | null }[];
  model?: string;
  provider?: string;
  savedPageId?: string;
  savedPageTitle?: string;
};

export type PanelMessage = {
  id: string;
  body: string;
  role?: string;
  createdAt: string | Date;
  meta?: unknown;
  user: { name: string; email: string } | null;
};

export type PanelThread = {
  id: string;
  title: string;
  pageId: string | null;
  page: { id: string; title: string; icon: string | null } | null;
  messages: PanelMessage[];
};

const QUICK_PROMPTS = [
  { label: "Summarize this note", prompt: "Summarize this note in three bullets and list any open tasks." },
  { label: "What are my projects?", prompt: "List my projects with their status, due dates and milestone progress." },
  { label: "Who is on the team?", prompt: "Who are the members of this workspace and what are their roles?" },
  { label: "What should I do next?", prompt: "Based on my notes, projects and open tasks, what should I focus on next?" },
];

/** Narrow the stored JSON metadata (Prisma returns JsonValue). */
function asMeta(value: unknown): ChatMessageMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ChatMessageMeta;
}

function time(value: string | Date) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Docked AI conversation panel. Lives inside the main content area (like the
 * sidebar-peek in the product this mirrors) so a discussion can be read next to
 * the note it is about. The sidebar keeps the list; this is the conversation.
 */
export function ChatPanel({
  workspaceId,
  slug,
  thread,
  threads,
  modelLabel,
  locale,
  onClose,
}: {
  workspaceId: string;
  slug: string;
  thread: PanelThread | null;
  threads: PanelThread[];
  modelLabel: string;
  locale: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<{ id: string; body: string }[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(thread?.id ?? null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const active = threads.find((item) => item.id === activeThreadId) ?? thread ?? null;

  useEffect(() => {
    if (thread?.id) setActiveThreadId(thread.id);
  }, [thread?.id]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeThreadId]);

  // Keep the newest exchange in view as answers stream in.
  const messageCount = active?.messages.length ?? 0;
  const optimisticCount = optimistic.length;
  useEffect(() => {
    if (messageCount === 0 && optimisticCount === 0 && !pending) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [messageCount, optimisticCount, pending, activeThreadId, streaming]);

  // Opening another conversation from the sidebar re-targets this panel.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId) setActiveThreadId(detail.threadId);
      else setActiveThreadId(null);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, []);

  const send = (text?: string) => {
    const body = (text ?? draft).trim();
    if (!body) return;
    const optimisticId = `pending-${Date.now()}`;
    // Only a composer send consumes the draft. Prompts sent from the quick
    // actions or the answer menu never touch text the user is still typing.
    if (text === undefined) setDraft("");
    setOptimistic((current) => [...current, { id: optimisticId, body }]);

    startTransition(async () => {
      // R25.17 — never eat the draft: until the server acknowledges the
      // question nothing is stored, so any failure gives the exact text back
      // (without clobbering whatever the user typed in the meantime). The
      // stream route persists the question before it can answer 200, so once
      // it has, the text lives in the thread and must NOT come back.
      let acknowledged = false;
      const restoreDraft = () => setDraft((current) => current || body);
      /** Failure paths guarantee the optimistic bubble is gone (R25.17). */
      const dropOptimistic = () =>
        setOptimistic((current) => current.filter((item) => item.id !== optimisticId));
      const bail = (message: string) => {
        toast.error(message);
        restoreDraft();
        dropOptimistic();
      };

      let threadId = active?.id ?? null;
      if (!threadId) {
        const created = await safeAction(() => createChatThreadAction(workspaceId));
        if (!created.ok) {
          bail(created.error);
          return;
        }
        if ("error" in created.value) {
          bail(created.value.error);
          return;
        }
        threadId = created.value.id;
        setActiveThreadId(threadId);
      }
      dropOptimistic();
      if (!threadId) return;

      // Stream the answer; if the stream cannot start (AI off, transport down),
      // fall back to the single-shot action so the user still gets an answer.
      try {
        const response = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId, body }),
        });
        // A 200 means the route already wrote the question row (route.ts:56).
        acknowledged = response.ok;

        if (!response.ok || !response.body) {
          const posted = await safeAction(() => postChatMessageAction(threadId, body));
          const failure = !posted.ok
            ? posted.error
            : "error" in posted.value
              ? posted.value.error
              : null;
          if (failure) {
            toast.error(failure);
            if (!acknowledged) restoreDraft();
            dropOptimistic();
          }
          router.refresh();
          return;
        }

        setStreaming("");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          setStreaming(text);
        }
        if (text.includes("[stream-error]")) {
          // In-band failure: the route persisted the exchange either way, so
          // the draft stays consumed — it is in the thread now.
          toast.error(text.split("[stream-error]")[1]?.trim() || "The answer was cut short.");
        }
        setStreaming(null);
        router.refresh();
      } catch (error) {
        setStreaming(null);
        toast.error(describeActionError(error, locale));
        // Nothing reached the database before the transport died — the draft
        // is all the user has left of their question, so give it back.
        if (!acknowledged) restoreDraft();
        dropOptimistic();
        router.refresh();
      }
    });
  };

  return (
    <aside
      aria-label={t(locale, "chatTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) onClose();
      }}
      className="fixed inset-0 z-40 flex w-full flex-col border-l border-border bg-bg md:static md:z-auto md:w-[380px] md:shrink-0"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-accent"
        >
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {active ? active.title || "AI conversation" : "New AI conversation"}
          </p>
          {active?.page && (
            <Link
              href={`/w/${slug}/${active.page.id}`}
              className="flex items-center gap-1 truncate text-[11px] text-muted hover:text-fg"
            >
              📄 {active.page.title || "Untitled"}
            </Link>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-label={t(locale, "chatHistory")}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <History className="h-4 w-4" />
          </button>
          {historyOpen && (
            <div className="absolute right-0 top-8 z-50 w-64 rounded-lg border border-border bg-bg p-1 shadow-lg">
              {threads.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted">{t(locale, "chatEmptyThreads")}</p>
              ) : (
                threads.map((item) => (
                  <div key={item.id} className="group flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveThreadId(item.id);
                        setHistoryOpen(false);
                      }}
                      className={cn(
                        "min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2",
                        item.id === active?.id && "bg-surface-2",
                      )}
                    >
                      {item.title || "New discussion"}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${item.title || "discussion"}`}
                      onClick={() =>
                        startTransition(async () => {
                          const outcome = await safeAction(() => deleteChatThreadAction(item.id));
                          if (!outcome.ok) toast.error(outcome.error);
                          else {
                            if (activeThreadId === item.id) setActiveThreadId(null);
                            toast.success("Conversation deleted");
                          }
                          router.refresh();
                        })
                      }
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:text-red-500 group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label={t(locale, "chatNew")}
          onClick={() => {
            setActiveThreadId(null);
            setDraft("");
            composerRef.current?.focus();
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Close conversation"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!active && (
          <div className="mx-auto max-w-sm pt-6 text-center">
            <span
              aria-hidden
              className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-accent/10 text-accent"
            >
              <Sparkles className="h-7 w-7" />
            </span>
            <h2 className="mt-3 text-lg font-semibold">{t(locale, "chatHowCanIHelp")}</h2>
            <p className="mt-1 text-sm text-muted">
              Ask about your notes, projects, milestones, members or tasks — I
              read the workspace, never the internet.
            </p>
            <ul className="mt-4 space-y-1.5 text-left">
              {QUICK_PROMPTS.map((item) => (
                <li key={item.label}>
                  <button
                    type="button"
                    onClick={() => send(item.prompt)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {active && (
          <ul className="space-y-4">
            {active.messages.map((message) => {
              const meta = asMeta(message.meta);
              return message.role === "assistant" ? (
                <li key={message.id} className="group">
                  <div className="flex items-center gap-1.5 pb-1 text-[11px] text-muted">
                    <Sparkles className="h-3 w-3 shrink-0 text-accent" />
                    <span className="font-medium text-fg">{meta?.model || "Noema AI"}</span>
                    {meta?.activity && meta.activity.length > 0 && (
                      <span className="flex items-center gap-1 truncate">
                        <Check className="h-3 w-3 shrink-0" />
                        {meta.activity.join(" · ")}
                      </span>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t(locale, "chatAnswerActions")}
                          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-surface-2 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <ChatAnswerItems
                          Item={DropdownMenuItem}
                          Separator={DropdownMenuSeparator}
                          message={{
                            id: message.id,
                            body: message.body,
                            savedPageId: meta?.savedPageId,
                            savedPageTitle: meta?.savedPageTitle,
                            threadPageId: active?.page?.id ?? null,
                          }}
                          slug={slug}
                          locale={locale}
                          threadId={active?.id ?? null}
                          onFollowUp={(prompt) => send(prompt)}
                          onSaved={() => undefined}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="rounded-lg bg-surface/60 px-3 py-2">
                        <Markdown text={message.body} slug={slug} compact locale={locale} />
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      <ChatAnswerItems
                        Item={ContextMenuItem}
                        Separator={ContextMenuSeparator}
                        message={{
                          id: message.id,
                          body: message.body,
                          savedPageId: meta?.savedPageId,
                          savedPageTitle: meta?.savedPageTitle,
                          threadPageId: active?.page?.id ?? null,
                        }}
                        slug={slug}
                        locale={locale}
                        threadId={active?.id ?? null}
                        onFollowUp={(prompt) => send(prompt)}
                        onSaved={() => undefined}
                      />
                    </ContextMenuContent>
                  </ContextMenu>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <span>{time(message.createdAt)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(message.body);
                        toast.success("Copied");
                      }}
                      className="flex items-center gap-1 hover:text-fg"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                    <span className="text-[10px] opacity-70">Right-click for more</span>
                  </div>
                </li>
              ) : (
                <li key={message.id} className="flex justify-end">
                  <div className="max-w-[85%]">
                    <div className="rounded-2xl bg-accent/10 px-3 py-2 text-sm leading-relaxed">
                      {message.body}
                    </div>
                    <p className="mt-1 text-right text-[11px] text-muted">
                      {time(message.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
            {optimistic.map((item) => (
              <li key={item.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-accent/10 px-3 py-2 text-sm opacity-60">
                  {item.body}
                </div>
              </li>
            ))}
            {streaming !== null && (
              <li className="group">
                <div className="flex items-center gap-1.5 pb-1 text-[11px] text-muted">
                  <Sparkles className="h-3 w-3 shrink-0 animate-pulse text-accent" />
                  <span className="font-medium text-fg">{modelLabel}</span>
                  <span>{t(locale, "chatWriting")}</span>
                </div>
                <div className="rounded-lg bg-surface/60 px-3 py-2">
                  {streaming ? (
                    <Markdown text={streaming} slug={slug} compact locale={locale} />
                  ) : (
                    <span className="notion-skeleton block h-3 w-40 rounded" />
                  )}
                </div>
              </li>
            )}
            {pending && streaming === null && (
              <li className="flex items-center gap-2 text-xs text-muted">
                <Sparkles className="h-3.5 w-3.5 animate-pulse text-accent" />
                <span className="notion-skeleton h-3 w-40 rounded" />
                <span className="sr-only">{t(locale, "chatThinking")}</span>
              </li>
            )}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="rounded-xl border border-border bg-bg p-2 focus-within:border-accent">
          <textarea
            ref={composerRef}
            value={draft}
            aria-label="Ask the AI"
            rows={2}
            placeholder={t(locale, "chatPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className="max-h-40 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="flex items-center gap-1.5">
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                {modelLabel}
              </span>
            </span>
            <button
              type="button"
              aria-label="Send message"
              disabled={pending || !draft.trim()}
              onClick={() => send()}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          {t(locale, "chatFootnote")}
        </p>
      </div>
    </aside>
  );
}

