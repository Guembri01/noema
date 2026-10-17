"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import type { LiHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Gauge,
  History,
  MessageSquarePlus,
  MoreHorizontal,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  createChatThreadAction,
  deleteChatThreadAction,
  executeChatActionAction,
  postChatMessageAction,
  regenerateChatAnswerAction,
} from "@/server/actions/chat";
import type { ChatActionProposal } from "@/lib/chat-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/input";
import { ChatAnswerItems } from "@/components/chat-answer-menu";
import { describeActionError, safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { OPEN_CHAT_EVENT } from "@/components/sidebar-chat";
import { Z, TAG_HUES, type TagHue } from "@/lib/design-tokens";
import {
  assembleContext,
  estimateTokens,
  fitToBudget,
  type ContextChunk,
  type ContextDoc,
} from "@/lib/ai-context";

export type ChatMessageMeta = {
  activity?: string[];
  intents?: string[];
  references?: { id: string; title: string; icon: string | null }[];
  model?: string;
  provider?: string;
  savedPageId?: string;
  savedPageTitle?: string;
  /** Context budget accounting stored with the answer, when available. */
  contextTokens?: number;
  budgetTokens?: number;
  droppedTurns?: number;
  truncated?: boolean;
  /** A pending chat action the user can confirm (rendered as a button). */
  proposal?: ChatActionProposal;
  /** Set once a proposal has been applied — the confirm button disappears. */
  applied?: boolean;
  appliedAction?: string;
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

/**
 * Button copy for a proposed chat action. Kept local (a plain string map) so the
 * client bundle never imports `@/lib/chat-actions` for anything but its type.
 */
const PROPOSAL_LABELS: Record<ChatActionProposal["kind"], string> = {
  createTicket: "Create ticket",
  updateTicket: "Update ticket",
  moveTicket: "Move ticket",
  deleteTicket: "Delete ticket",
  archiveTicket: "Archive ticket",
  createNote: "Create note",
};

/** Default token budget for the conversation context attached to a question. */
const DEFAULT_CONTEXT_BUDGET = 1024;

/** Bounds and step for the context-budget control. */
const MIN_CONTEXT_BUDGET = 0;
const MAX_CONTEXT_BUDGET = 8192;
const CONTEXT_BUDGET_STEP = 128;

/** localStorage key holding one workspace's saved context-token budget. */
function contextBudgetStorageKey(workspaceId: string): string {
  return `noema:context-budget:${workspaceId}`;
}

/** Clamp a raw budget into the supported range as a whole number of tokens. */
function clampContextBudget(value: number): number {
  return Math.min(MAX_CONTEXT_BUDGET, Math.max(MIN_CONTEXT_BUDGET, Math.floor(value)));
}

/**
 * Read the workspace's persisted context budget, tolerating absent, blocked
 * (private mode) or corrupt storage by falling back to the default. An
 * out-of-range stored value is clamped so the control always has a legal value.
 */
function loadContextBudget(workspaceId: string): number {
  if (typeof window === "undefined") return DEFAULT_CONTEXT_BUDGET;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(contextBudgetStorageKey(workspaceId));
  } catch {
    return DEFAULT_CONTEXT_BUDGET;
  }
  if (raw === null || raw.trim() === "") return DEFAULT_CONTEXT_BUDGET;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampContextBudget(parsed) : DEFAULT_CONTEXT_BUDGET;
}

/** Persist the budget, tolerating private mode / disabled storage. */
function saveContextBudget(workspaceId: string, budget: number): void {
  try {
    window.localStorage.setItem(contextBudgetStorageKey(workspaceId), String(budget));
  } catch {
    // No storage — the in-memory budget still applies this session.
  }
}

/** Standing instruction mirrored from the server prompt (`chat-runtime`). */
const CONTEXT_SYSTEM_HINT =
  "You answer from the workspace data provided, never from the open internet.";

/** Shared empty list so the context memo never allocates a fresh dependency. */
const NO_MESSAGES: readonly PanelMessage[] = [];

/** A locally budgeted view of the conversation context sent with a question. */
type ContextAttachment = {
  /** The assembled prompt: instruction, kept turns, then the question. */
  prompt: string;
  /** `estimateTokens(prompt)`. */
  usedTokens: number;
  /** Tokens spent on the kept conversation turns alone. */
  contextTokens: number;
  /** `estimateTokens(question)`. */
  questionTokens: number;
  keptTurns: number;
  totalTurns: number;
  droppedTurns: number;
  /** True when a kept turn was shortened to fit the budget. */
  truncated: boolean;
};

/**
 * Budget the conversation context that accompanies a question, using the pure
 * sizing layer in `@/lib/ai-context`. The newest turns win the token budget and
 * the oldest are trimmed first, so a long discussion still grounds the question
 * without blowing the window; the survivors are then assembled into one prompt.
 */
function buildContextAttachment(
  messages: readonly PanelMessage[],
  question: string,
  maxTokens: number,
): ContextAttachment {
  const chunks: ContextChunk[] = messages.map((message) => ({
    id: message.id,
    text: `${message.role === "assistant" ? "Assistant" : "User"}: ${message.body}`,
  }));
  // Higher index = more recent = kept first; the oldest turns drop out.
  const fit = fitToBudget(chunks, { maxTokens, priorityOf: (_chunk, index) => index });
  const docs: ContextDoc[] = fit.kept.map((chunk) => ({ id: chunk.id, text: chunk.text }));
  const questionTokens = estimateTokens(question);
  // The turns already fit the budget; leave room for the mandatory instruction
  // and question so `assembleContext` keeps exactly what survived above.
  const assembled = assembleContext({
    system: CONTEXT_SYSTEM_HINT,
    docs,
    question,
    maxTokens: maxTokens + estimateTokens(CONTEXT_SYSTEM_HINT) + questionTokens + 4,
  });
  return {
    prompt: assembled.prompt,
    usedTokens: assembled.usedTokens,
    contextTokens: fit.usedTokens,
    questionTokens,
    keptTurns: fit.kept.length,
    totalTurns: chunks.length,
    droppedTurns: fit.dropped.length,
    truncated: fit.kept.some((chunk) => chunk.truncated),
  };
}

/** Narrow the stored JSON metadata (Prisma returns JsonValue). */
function asMeta(value: unknown): ChatMessageMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ChatMessageMeta;
}

function time(value: string | Date) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toIso(value: string | Date): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

/* -------------------------------------------------------------------------- *
 * Pure mappings — message bubbles, chips, streaming, scroll, composer
 * -------------------------------------------------------------------------- */

export type MessageRole = "user" | "assistant";

/** Anything that is not explicitly `user` reads as the assistant. */
export function resolveMessageRole(role: string | null | undefined): MessageRole {
  return role === "user" ? "user" : "assistant";
}

export type BubbleSpec = {
  role: MessageRole;
  align: "start" | "end";
  surface: "user" | "assistant";
  /** Classes for the `<li>` row (cardinality + side). */
  rowClassName: string;
  /** Classes for the bubble surface — surface tokens only, never a raw colour. */
  bubbleClassName: string;
};

/**
 * A message's bubble is distinguished by **alignment + surface token**, never a
 * raw colour: the user sits end-aligned on `--surface-2`, the assistant starts
 * on `--surface` with a hairline border.
 */
export function messageBubble(role?: string | null): BubbleSpec {
  const resolved = resolveMessageRole(role);
  if (resolved === "user") {
    return {
      role: resolved,
      align: "end",
      surface: "user",
      rowClassName: "group flex justify-end",
      bubbleClassName: "rounded-lg bg-surface-2 px-3 py-2 text-sm leading-relaxed text-fg",
    };
  }
  return {
    role: resolved,
    align: "start",
    surface: "assistant",
    rowClassName: "group",
    bubbleClassName: "rounded-lg border border-border bg-surface px-3 py-2",
  };
}

export type CitationChip = {
  id: string;
  title: string;
  icon: string | null;
  href: string;
  hue: TagHue;
};

/** Deterministic tag hue for a citation, derived from its page id. */
export function citationHue(seed: string): TagHue {
  let hash = 0;
  const value = typeof seed === "string" ? seed : "";
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return TAG_HUES[hash % TAG_HUES.length];
}

/** Compact citation chips (links) for the workspace pages an answer cited. */
export function citationChips(
  slug: string,
  references: readonly { id: string; title: string; icon: string | null }[] | null | undefined,
  max = 4,
): CitationChip[] {
  const list = Array.isArray(references) ? references : [];
  return list
    .filter((reference) => reference && typeof reference.id === "string" && reference.id !== "")
    .slice(0, Math.max(0, max))
    .map((reference) => ({
      id: reference.id,
      title: (reference.title ?? "").trim() || "Untitled",
      icon: reference.icon ?? null,
      href: `/w/${slug}/${reference.id}`,
      hue: citationHue(reference.id),
    }));
}

/** A small `Tag` under an answer: tokens or grounding. */
export type AnswerChip = {
  key: "tokens" | "grounding" | "budget";
  label: string;
  hue: TagHue;
  title?: string;
};

/**
 * The chips shown beneath an assistant answer: estimated token cost, whether the
 * answer was grounded in workspace sources, and — when the server recorded it —
 * how much of the context budget the question consumed.
 */
export function answerChips(
  meta: ChatMessageMeta | null | undefined,
  body: string,
): AnswerChip[] {
  const chips: AnswerChip[] = [];
  const tokens = estimateTokens(body);
  chips.push({
    key: "tokens",
    label: `${tokens} tok`,
    hue: "gray",
    title: `About ${tokens} estimated tokens`,
  });

  const references = meta?.references ?? [];
  if (references.length > 0) {
    chips.push({
      key: "grounding",
      label: `${references.length} source${references.length === 1 ? "" : "s"}`,
      hue: "green",
      title: "Grounded in your workspace",
    });
  } else {
    chips.push({
      key: "grounding",
      label: "No sources",
      hue: "yellow",
      title: "Answered without a workspace citation",
    });
  }

  if (typeof meta?.contextTokens === "number" && typeof meta?.budgetTokens === "number") {
    const trimmed = (meta.droppedTurns ?? 0) > 0 || meta.truncated === true;
    chips.push({
      key: "budget",
      label: `${meta.contextTokens}/${meta.budgetTokens} ctx`,
      hue: trimmed ? "red" : "blue",
      title: trimmed ? "Context was trimmed to fit the budget" : "Context fit the budget",
    });
  }

  return chips;
}

/* --- Streaming state machine ---------------------------------------------- */

export type StreamPhase = "idle" | "pending" | "streaming";

export const STREAM_PHASES: readonly StreamPhase[] = ["idle", "pending", "streaming"];

/** Streaming state: the phase plus the answer text accumulated so far. */
export type StreamState = { phase: StreamPhase; text: string };

export const STREAM_INITIAL: StreamState = { phase: "idle", text: "" };

export type StreamEvent =
  | { type: "send" }
  | { type: "open" }
  | { type: "chunk"; text: string }
  | { type: "settle" }
  | { type: "reset" };

/**
 * The phase transition table, as a pure function. Sending starts a request;
 * opening the stream and receiving a chunk move it to `streaming`; settling or
 * resetting returns to `idle`. A chunk that arrives while idle is ignored.
 */
export function nextStreamPhase(phase: StreamPhase, event: StreamEvent["type"]): StreamPhase {
  switch (event) {
    case "send":
      return "pending";
    case "open":
    case "chunk":
      return phase === "idle" ? "idle" : "streaming";
    case "settle":
    case "reset":
      return "idle";
    default:
      return phase;
  }
}

/** Reducer over the streaming state. Pure — pinned by the node tests. */
export function streamReducer(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    case "send":
      return { phase: nextStreamPhase(state.phase, "send"), text: "" };
    case "open":
      return { phase: nextStreamPhase(state.phase, "open"), text: state.text };
    case "chunk":
      if (state.phase === "idle") return state;
      return { phase: "streaming", text: state.text + (event.text ?? "") };
    case "settle":
      return { phase: "idle", text: "" };
    case "reset":
      return STREAM_INITIAL;
    default:
      return state;
  }
}

/* --- Auto-scroll ----------------------------------------------------------- */

/** Pixels from the bottom within which the list is considered "pinned". */
export const SCROLL_STICKY_THRESHOLD = 48;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = SCROLL_STICKY_THRESHOLD,
): boolean {
  return distanceFromBottom(metrics) <= Math.max(0, threshold);
}

export type AutoscrollDecision = { stick: boolean; showJump: boolean };

/**
 * Whether new content should yank the list to the bottom, and whether the
 * "new messages" pill should appear. Near the bottom we stick; once the user has
 * scrolled up we never yank and offer the pill instead.
 */
export function autoscrollDecision(
  metrics: ScrollMetrics,
  options: { userScrolledUp?: boolean } = {},
  threshold: number = SCROLL_STICKY_THRESHOLD,
): AutoscrollDecision {
  if (isNearBottom(metrics, threshold)) return { stick: true, showJump: false };
  return { stick: false, showJump: Boolean(options.userScrolledUp) };
}

/* --- Composer -------------------------------------------------------------- */

/** Composer height bounds in px (4px grid). */
export const COMPOSER_MIN_HEIGHT = 32;
export const COMPOSER_MAX_HEIGHT = 160;

/** Clamp a textarea's scrollHeight into the composer's min/max window. */
export function composerHeight(scrollHeight: number): number {
  const value = Number.isFinite(scrollHeight) ? scrollHeight : COMPOSER_MIN_HEIGHT;
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, Math.round(value)));
}

export type ComposerControls = { canSend: boolean; sendDisabled: boolean; showCancel: boolean };

/** Which composer affordances are live for a draft + streaming phase. */
export function composerControls({
  draft,
  phase,
  pending,
}: {
  draft: string;
  phase: StreamPhase;
  pending: boolean;
}): ComposerControls {
  const busy = pending || phase !== "idle";
  return {
    canSend: draft.trim().length > 0 && !busy,
    sendDisabled: draft.trim().length === 0 || busy,
    showCancel: phase !== "idle",
  };
}

/* -------------------------------------------------------------------------- *
 * Presentational pieces
 * -------------------------------------------------------------------------- */

/**
 * The three-dot "thinking" pulse. The dots are a fixed size, so the indicator
 * never shifts the layout, and the pulse uses the `animate-pulse-soft` token
 * with the `--dur-*` ladder for its stagger.
 */
export function TypingIndicator({
  label,
  modelLabel,
}: {
  label: string;
  modelLabel?: string;
}) {
  return (
    <div
      data-testid="typing-indicator"
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-xs text-muted"
    >
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        <span className="size-1.5 rounded-full bg-accent animate-pulse-soft" />
        <span
          className="size-1.5 rounded-full bg-accent animate-pulse-soft"
          style={{ animationDelay: "var(--dur-1)" }}
        />
        <span
          className="size-1.5 rounded-full bg-accent animate-pulse-soft"
          style={{ animationDelay: "var(--dur-2)" }}
        />
      </span>
      <span className="truncate">
        {modelLabel ? <span className="font-medium text-fg">{modelLabel} </span> : null}
        {label}
      </span>
    </div>
  );
}

/** The skeleton shown while a conversation's first message is in flight. */
export function ChatPanelSkeleton() {
  return (
    <div data-testid="chat-panel-skeleton" aria-hidden className="space-y-4">
      {[0, 1, 2].map((index) => (
        <div key={index} className={cn("flex", index % 2 === 0 ? "justify-start" : "justify-end")}>
          <div className="w-[70%] space-y-2">
            <Skeleton variant="block" className="h-3" width="40%" />
            <Skeleton variant="block" className="h-12" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The empty conversation: icon + title + hint + quick prompts. */
export function ChatEmptyState({
  locale,
  onPrompt,
}: {
  locale: string;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div data-testid="chat-empty" className="mx-auto w-full max-w-sm">
      <EmptyState
        variant="full"
        icon={<Sparkles className="h-5 w-5" />}
        title={t(locale, "chatHowCanIHelp")}
        description={t(locale, "chatIntro")}
      />
      <ul className="mt-2 space-y-1.5">
        {QUICK_PROMPTS.map((item) => (
          <li key={item.label}>
            <Button
              variant="secondary"
              size="sm"
              className="w-full justify-start text-left"
              onClick={() => onPrompt(item.prompt)}
            >
              {item.label}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type ChatMessageItemProps = {
  role?: string | null;
  body: string;
  createdAt?: string | Date | null;
  meta?: ChatMessageMeta | null;
  slug: string;
  locale: string;
  modelLabel?: string;
  user?: { name: string; email: string } | null;
  onCopy?: () => void;
  onRegenerate?: () => void;
  onApplyProposal?: (proposal: ChatActionProposal) => void;
  pending?: boolean;
  /** Slot for the `⋯` dropdown (kept out of the presentational render). */
  menu?: ReactNode;
} & LiHTMLAttributes<HTMLLIElement>;

/**
 * One message row: user or assistant bubble, the grounding / token `Tag`s under
 * an answer, citation chips, and the copy / regenerate actions that reveal on
 * hover *and* focus. Pure presentation — the menus and side-effects live in
 * `ChatPanel`, so this renders under `renderToStaticMarkup`.
 */
export const ChatMessageItem = forwardRef<HTMLLIElement, ChatMessageItemProps>(
  function ChatMessageItem(
    {
      role,
      body,
      createdAt,
      meta,
      slug,
      locale,
      modelLabel,
      user,
      onCopy,
      onRegenerate,
      onApplyProposal,
      pending = false,
      menu,
      className,
      ...rest
    },
    ref,
  ) {
    const spec = messageBubble(role);
    const isAssistant = spec.role === "assistant";
    const chips = isAssistant ? answerChips(meta, body) : [];
    const citations = isAssistant ? citationChips(slug, meta?.references) : [];
    const referenceCount = meta?.references?.length ?? 0;
    const proposal = meta?.proposal && !meta.applied ? meta.proposal : null;
    const stamp = createdAt ? time(createdAt) : "";

    return (
      <li
        {...rest}
        ref={ref}
        data-message-role={spec.role}
        data-align={spec.align}
        data-surface={spec.surface}
        className={cn(spec.rowClassName, "animate-rise", className)}
      >
        <div className={cn("flex min-w-0 flex-col", isAssistant ? "w-full" : "max-w-[85%] items-end")}>
          {isAssistant ? (
            <div className="flex items-center gap-1.5 pb-1 text-2xs text-muted">
              <Sparkles className="h-3 w-3 shrink-0 text-accent" aria-hidden />
              <span className="font-medium text-fg">{meta?.model || modelLabel || "Noema AI"}</span>
              {(meta?.activity?.length ?? 0) > 0 ? (
                <Tag size="sm" hue="gray" className="min-w-0 max-w-[12rem]" title={meta?.activity?.join(", ")}>
                  {meta?.activity?.join(" · ")}
                </Tag>
              ) : null}
              {menu ? <span className="ms-auto flex items-center">{menu}</span> : null}
            </div>
          ) : user?.name ? (
            <div className="flex items-center justify-end gap-1.5 pb-1 text-2xs text-muted">
              <span className="truncate">{user.name}</span>
              <Avatar user={{ id: user.email || user.name, name: user.name }} size={20} />
            </div>
          ) : null}

          <div className={cn(spec.bubbleClassName, "break-words")}>
            {isAssistant ? (
              <Markdown text={body} slug={slug} compact locale={locale} />
            ) : (
              <span className="whitespace-pre-wrap">{body}</span>
            )}
          </div>

          {isAssistant && (chips.length > 0 || citations.length > 0) ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chips.map((chip) => (
                <Tag key={chip.key} size="sm" hue={chip.hue} title={chip.title}>
                  {chip.label}
                </Tag>
              ))}
              {citations.map((citation) => (
                <Link key={citation.id} href={citation.href} className="focus-ring rounded-sm">
                  <Tag size="sm" hue={citation.hue} dot title={citation.title}>
                    {citation.icon ? `${citation.icon} ` : ""}
                    {citation.title}
                  </Tag>
                </Link>
              ))}
              {referenceCount > citations.length ? (
                <Tag size="sm" hue="gray" title={`${referenceCount} sources`}>
                  +{referenceCount - citations.length}
                </Tag>
              ) : null}
            </div>
          ) : null}

          {isAssistant && proposal && onApplyProposal ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-2">
              <Button
                size="xs"
                disabled={pending}
                onClick={() => onApplyProposal(proposal)}
                leftIcon={<Check className="h-3.5 w-3.5" />}
              >
                {PROPOSAL_LABELS[proposal.kind] ?? "Confirm"}
              </Button>
              <span className="text-2xs text-muted">
                Confirm to apply — this changes workspace data.
              </span>
            </div>
          ) : null}

          <div className="mt-1 flex items-center gap-3 text-2xs text-muted opacity-0 u-colors group-hover:opacity-100 group-focus-within:opacity-100">
            {stamp ? <time dateTime={createdAt ? toIso(createdAt) : undefined}>{stamp}</time> : null}
            {onCopy ? (
              <button
                type="button"
                onClick={onCopy}
                aria-label={t(locale, "copy")}
                className="focus-ring u-colors flex items-center gap-1 rounded-xs px-1 hover:text-fg"
              >
                <Copy className="h-3 w-3" aria-hidden /> {t(locale, "copy")}
              </button>
            ) : null}
            {isAssistant && onRegenerate ? (
              <button
                type="button"
                onClick={onRegenerate}
                aria-label={t(locale, "chatRegenerate")}
                className="focus-ring u-colors flex items-center gap-1 rounded-xs px-1 hover:text-fg"
              >
                <RefreshCw className="h-3 w-3" aria-hidden /> {t(locale, "chatRegenerate")}
              </button>
            ) : null}
          </div>
        </div>
      </li>
    );
  },
);

/* -------------------------------------------------------------------------- *
 * ChatPanel
 * -------------------------------------------------------------------------- */

/**
 * Docked AI conversation panel. Lives inside the main content area (like the
 * panel in the product this mirrors) so a discussion can be read next to the
 * note it is about. The sidebar keeps the list; this is the conversation.
 */
export function ChatPanel({
  workspaceId,
  slug,
  thread,
  threads,
  modelLabel,
  locale,
  onClose,
  activePageId = null,
  loading = false,
}: {
  workspaceId: string;
  slug: string;
  thread: PanelThread | null;
  threads: PanelThread[];
  modelLabel: string;
  locale: string;
  onClose: () => void;
  /**
   * The page currently open in the UI. Sent with every question so the assistant
   * can answer about "this page" — before this, such questions could only be
   * answered from the workspace overview.
   */
  activePageId?: string | null;
  /** Show the thread skeleton while the conversation is being fetched. */
  loading?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stream, dispatch] = useReducer(streamReducer, STREAM_INITIAL);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<{ id: string; body: string }[]>([]);
  const [error, setError] = useState<{ message: string; retryBody?: string } | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(thread?.id ?? null);
  const [contextBudget, setContextBudget] = useState(DEFAULT_CONTEXT_BUDGET);
  const [budgetLoaded, setBudgetLoaded] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);

  const active = threads.find((item) => item.id === activeThreadId) ?? thread ?? null;
  const messages = active?.messages ?? NO_MESSAGES;

  // Client-side preview only: this estimates the context budget rendered in the
  // composer UI. The stream route rebuilds its own grounding context, so none of
  // these figures travel with the question — sending them would be a dead
  // protocol the server never reads.
  const contextPreview = useMemo(
    () => buildContextAttachment(messages, draft.trim(), contextBudget),
    [messages, draft, contextBudget],
  );

  useEffect(() => {
    if (thread?.id) setActiveThreadId(thread.id);
  }, [thread?.id]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeThreadId]);

  // Auto-grow the composer up to its max height (never an ad-hoc value).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${composerHeight(el.scrollHeight)}px`;
  }, [draft]);

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

  // Hydrate the saved budget once per workspace. Declared before the persistence
  // effect so a fresh load can never overwrite the stored choice with the
  // default; an unset value keeps the default.
  useEffect(() => {
    setContextBudget(loadContextBudget(workspaceId));
    setBudgetLoaded(true);
  }, [workspaceId]);

  // Persist every change so the choice survives reloads. Storage being
  // unavailable (private mode / quota) leaves the in-memory budget intact.
  useEffect(() => {
    if (!budgetLoaded) return;
    saveContextBudget(workspaceId, contextBudget);
  }, [budgetLoaded, workspaceId, contextBudget]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const decision = autoscrollDecision(
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      { userScrolledUp: true },
    );
    atBottomRef.current = decision.stick;
    if (!decision.showJump) setShowJump(false);
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setShowJump(false);
    scrollToBottom(prefersReducedMotion() ? "auto" : "smooth");
  }, [scrollToBottom]);

  // Keep the newest exchange in view as answers stream in — but never yank a
  // user who has scrolled up; offer the "new messages" pill instead.
  const messageCount = messages.length;
  const optimisticCount = optimistic.length;
  useEffect(() => {
    if (messageCount === 0 && optimisticCount === 0 && stream.phase === "idle") return;
    if (atBottomRef.current) {
      scrollToBottom(prefersReducedMotion() ? "auto" : "smooth");
    } else {
      setShowJump(true);
    }
  }, [messageCount, optimisticCount, stream.phase, stream.text, activeThreadId, scrollToBottom]);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "settle" });
  }, []);

  const send = (text?: string) => {
    const body = (text ?? draft).trim();
    if (!body) return;
    setError(null);
    const optimisticId = `pending-${Date.now()}`;
    // Only a composer send consumes the draft. Prompts sent from the quick
    // actions or the answer menu never touch text the user is still typing.
    if (text === undefined) setDraft("");
    setOptimistic((current) => [...current, { id: optimisticId, body }]);
    dispatch({ type: "send" });

    startTransition(async () => {
      // R25.17 — never eat the draft: until the server acknowledges the
      // question nothing is stored, so any failure gives the exact text back
      // (without clobbering whatever the user typed in the meantime).
      let acknowledged = false;
      const restoreDraft = () => setDraft((current) => current || body);
      const dropOptimistic = () =>
        setOptimistic((current) => current.filter((item) => item.id !== optimisticId));
      const settle = () => dispatch({ type: "settle" });
      const bail = (message: string) => {
        setError(message ? { message, retryBody: body } : null);
        restoreDraft();
        dropOptimistic();
        settle();
      };

      const controller = new AbortController();
      abortRef.current = controller;

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
      if (controller.signal.aborted) {
        bail("");
        return;
      }
      dropOptimistic();
      if (!threadId) {
        settle();
        return;
      }

      // Stream the answer; if the stream cannot start (AI off, transport down),
      // fall back to the single-shot action so the user still gets an answer.
      try {
        const response = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            threadId,
            body,
            // The page on screen, so "what page am I in?" is answerable.
            pageId: activePageId,
          }),
        });
        // A 200 means the route already wrote the question row (route.ts:56).
        acknowledged = response.ok;

        if (!response.ok || !response.body) {
          const posted = await safeAction(() =>
            postChatMessageAction(threadId, body, activePageId),
          );
          const failure = !posted.ok
            ? posted.error
            : "error" in posted.value
              ? posted.value.error
              : null;
          if (failure) {
            setError({ message: failure, retryBody: body });
            if (!acknowledged) restoreDraft();
            dropOptimistic();
          }
          settle();
          router.refresh();
          return;
        }

        dispatch({ type: "open" });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const piece = decoder.decode(value, { stream: true });
          text += piece;
          dispatch({ type: "chunk", text: piece });
        }
        if (text.includes("[stream-error]")) {
          // In-band failure: the route persisted the exchange either way, so
          // the draft stays consumed — it is in the thread now.
          toast.error(text.split("[stream-error]")[1]?.trim() || "The answer was cut short.");
        }
        settle();
        router.refresh();
      } catch (caught) {
        settle();
        const aborted = caught instanceof Error && caught.name === "AbortError";
        if (aborted) {
          // User cancelled: nothing reached the database before we stopped.
          dropOptimistic();
          if (!acknowledged) restoreDraft();
          router.refresh();
          return;
        }
        toast.error(describeActionError(caught, locale));
        // Nothing reached the database before the transport died — the draft
        // is all the user has left of their question, so give it back.
        if (!acknowledged) restoreDraft();
        dropOptimistic();
        router.refresh();
      } finally {
        abortRef.current = null;
      }
    });
  };

  /**
   * Apply a proposed chat action. This is the ONLY way the assistant changes
   * workspace data; it runs the same server action the board uses, which
   * re-checks permission server-side.
   */
  const confirmAction = (messageId: string, proposal: ChatActionProposal) => {
    const threadId = active?.id;
    if (!threadId) return;
    startTransition(async () => {
      const outcome = await safeAction(
        () => executeChatActionAction({ threadId, action: proposal, proposalMessageId: messageId }),
        { locale },
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(outcome.value.message || "Done");
      router.refresh();
    });
  };

  const deleteThread = (id: string) => {
    startTransition(async () => {
      const outcome = await safeAction(() => deleteChatThreadAction(id));
      if (!outcome.ok) toast.error(outcome.error);
      else {
        if (activeThreadId === id) setActiveThreadId(null);
        toast.success("Conversation deleted");
      }
      router.refresh();
    });
  };

  const { canSend, sendDisabled, showCancel } = composerControls({
    draft,
    phase: stream.phase,
    pending,
  });
  const hasConversation = active !== null || optimisticCount > 0 || stream.phase !== "idle";
  const showSkeleton = !hasConversation && (loading || pending);

  return (
    <aside
      aria-label={t(locale, "chatTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) onClose();
      }}
      style={{ zIndex: Z.overlay }}
      className="fixed inset-0 flex w-full flex-col border-l border-border bg-bg md:static md:w-[380px] md:shrink-0"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"
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
              className="flex items-center gap-1 truncate text-2xs text-muted hover:text-fg"
            >
              📄 {active.page.title || "Untitled"}
            </Link>
          )}
        </div>

        <div className="relative">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t(locale, "chatHistory")}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <History className="h-4 w-4" />
          </Button>
          {historyOpen && (
            <div
              style={{ zIndex: Z.popover }}
              className="surface-raised absolute end-0 top-8 w-64 p-1"
            >
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
                        "focus-ring min-w-0 flex-1 truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-2",
                        item.id === active?.id && "bg-surface-2",
                      )}
                    >
                      {item.title || "New discussion"}
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${item.title || "discussion"}`}
                      onClick={() => deleteThread(item.id)}
                      className="h-6 w-6 text-muted opacity-0 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <Button
          size="icon"
          variant="ghost"
          aria-label={t(locale, "chatNew")}
          onClick={() => {
            setActiveThreadId(null);
            setDraft("");
            setError(null);
            dispatch({ type: "reset" });
            composerRef.current?.focus();
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t(locale, "close")} onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3"
        >
          {showSkeleton ? (
            <ChatPanelSkeleton />
          ) : !hasConversation ? (
            <ChatEmptyState locale={locale} onPrompt={(prompt) => send(prompt)} />
          ) : (
            <ul className="space-y-4" aria-label={active?.title || t(locale, "conversation")}>
              {messages.map((message, index) => {
                const meta = asMeta(message.meta);
                const spec = messageBubble(message.role);
                const answerMenu = (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t(locale, "chatAnswerActions")}
                        className="focus-ring u-colors flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted opacity-0 hover:bg-surface-2 focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
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
                );

                if (spec.role !== "assistant") {
                  return (
                    <ChatMessageItem
                      key={message.id}
                      role={message.role}
                      body={message.body}
                      createdAt={message.createdAt}
                      slug={slug}
                      locale={locale}
                      user={message.user}
                      onCopy={() => {
                        void navigator.clipboard?.writeText(message.body);
                        toast.success("Copied");
                      }}
                      className="animate-fade"
                    />
                  );
                }

                return (
                  <ChatMessageItem
                    key={message.id}
                    role={message.role}
                    body={message.body}
                    createdAt={message.createdAt}
                    meta={meta}
                    slug={slug}
                    locale={locale}
                    modelLabel={modelLabel}
                    pending={pending}
                    menu={answerMenu}
                    onCopy={() => {
                      void navigator.clipboard?.writeText(message.body);
                      toast.success("Copied");
                    }}
                    onRegenerate={
                      index === messages.length - 1
                        ? () => {
                            const id = active?.id;
                            if (!id) return;
                            startTransition(async () => {
                              const outcome = await safeAction(() =>
                                regenerateChatAnswerAction(id),
                              );
                              if (!outcome.ok) toast.error(outcome.error);
                              else toast.success("Answer regenerated");
                              router.refresh();
                            });
                          }
                        : undefined
                    }
                    onApplyProposal={(proposal) => confirmAction(message.id, proposal)}
                  />
                );
              })}

              {optimistic.map((item) => (
                <ChatMessageItem
                  key={item.id}
                  role="user"
                  body={item.body}
                  slug={slug}
                  locale={locale}
                  className="animate-fade opacity-60"
                />
              ))}

              {stream.phase !== "idle" ? (
                <li data-testid="chat-streaming" className="animate-fade">
                  <div className="flex items-center gap-1.5 pb-1 text-2xs text-muted">
                    <Sparkles
                      className="h-3 w-3 shrink-0 animate-pulse-soft text-accent"
                      aria-hidden
                    />
                    <span className="font-medium text-fg">{modelLabel}</span>
                    <span>{t(locale, "chatWriting")}</span>
                  </div>
                  <div className={cn(messageBubble("assistant").bubbleClassName, "animate-fade")}>
                    {stream.text ? (
                      <Markdown text={stream.text} slug={slug} compact locale={locale} />
                    ) : (
                      <TypingIndicator label={t(locale, "chatThinking")} />
                    )}
                  </div>
                </li>
              ) : null}

              {error ? (
                <li
                  data-testid="chat-error"
                  role="alert"
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-xs text-danger"
                >
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 break-words">{error.message}</span>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      const retryBody = error.retryBody;
                      setError(null);
                      if (retryBody) send(retryBody);
                    }}
                  >
                    {t(locale, "retry")}
                  </Button>
                </li>
              ) : null}

              <div ref={bottomRef} />
            </ul>
          )}
        </div>

        {showJump ? (
          <button
            type="button"
            onClick={jumpToBottom}
            style={{ zIndex: Z.sticky }}
            className="absolute bottom-3 inset-x-0 mx-auto flex w-fit animate-rise items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-xs font-medium text-fg shadow-2 focus-ring u-colors hover:bg-surface-2"
          >
            <ArrowDown className="h-3 w-3" aria-hidden /> New messages
          </button>
        ) : null}
      </div>

      <div className="border-t border-border p-3">
        {/* Context budget: shows and limits the conversation context attached to a
            question. The figures are a client-side preview; the stream route
            rebuilds its own grounding context. */}
        <div className="mb-2">
          <button
            type="button"
            aria-label={t(locale, "chatContextBudget")}
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((value) => !value)}
            className="focus-ring u-colors flex w-full items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-2xs text-muted hover:bg-surface-2"
          >
            <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="font-medium text-fg">Context</span>
            <span className="truncate">
              {contextPreview.keptTurns}/{contextPreview.totalTurns} msgs ·{" "}
              {contextPreview.contextTokens}/{contextBudget} tokens
            </span>
            <span className="ms-auto shrink-0">
              {contextPreview.droppedTurns > 0 || contextPreview.truncated ? (
                <TriangleAlert className="h-3 w-3 text-warning" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
              )}
            </span>
          </button>
        </div>

        {contextOpen && (
          <div className="mb-2 rounded-lg border border-border p-2 text-2xs text-muted">
            <label className="flex items-center gap-2">
              <span className="shrink-0 font-medium uppercase tracking-wide">Token budget</span>
              <input
                type="number"
                min={MIN_CONTEXT_BUDGET}
                max={MAX_CONTEXT_BUDGET}
                step={CONTEXT_BUDGET_STEP}
                value={contextBudget}
                aria-label={t(locale, "chatContextTokenBudget")}
                onChange={(event) => {
                  const next = event.target.valueAsNumber;
                  setContextBudget(
                    Number.isFinite(next) ? clampContextBudget(next) : DEFAULT_CONTEXT_BUDGET,
                  );
                }}
                className="ms-auto h-7 w-24 rounded-sm border border-border bg-bg px-2 text-right text-xs text-fg outline-none focus-ring"
              />
            </label>
            <p className="mt-1.5">
              Newest turns fill the budget first; older turns are trimmed to fit.
            </p>
            <dl className="mt-1.5 grid grid-cols-3 gap-1">
              <div>
                <dt className="inline">Question: </dt>
                <dd className="inline text-fg">{contextPreview.questionTokens} tok</dd>
              </div>
              <div>
                <dt className="inline">Context: </dt>
                <dd className="inline text-fg">{contextPreview.contextTokens} tok</dd>
              </div>
              <div>
                <dt className="inline">Assembled: </dt>
                <dd className="inline text-fg">{contextPreview.usedTokens} tok</dd>
              </div>
            </dl>
            <p className="mt-1.5">
              {contextPreview.totalTurns === 0
                ? "No earlier messages yet — the question is sent on its own."
                : contextPreview.droppedTurns > 0
                  ? `Trimmed the oldest ${contextPreview.droppedTurns} message(s) to fit.`
                  : contextPreview.truncated
                    ? "The oldest kept message was shortened to fit."
                    : "All earlier messages fit within the budget."}
            </p>
          </div>
        )}

        <Textarea
          ref={composerRef}
          size="sm"
          rows={1}
          value={draft}
          aria-label={t(locale, "askAI")}
          placeholder={t(locale, "chatPlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) send();
            }
          }}
          className="min-h-8 max-h-40 resize-none overflow-y-auto"
        />

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Tag size="sm" hue="gray" dot className="max-w-[10rem]">
              {modelLabel}
            </Tag>
            <span className="hidden items-center gap-1 text-2xs text-muted sm:flex">
              <Kbd size="xs">↵</Kbd> send
              <span className="mx-0.5">·</span>
              <Kbd size="xs">⇧↵</Kbd> new line
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {showCancel ? (
              <Button
                size="xs"
                variant="danger"
                tone="soft"
                onClick={cancelStream}
                leftIcon={<Square className="h-3 w-3" />}
              >
                Stop
              </Button>
            ) : null}
            <Button
              size="icon"
              aria-label={t(locale, "chatSend")}
              disabled={sendDisabled}
              loading={pending}
              onClick={() => send()}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>

        <p className="mt-1.5 text-2xs text-muted">{t(locale, "chatFootnote")}</p>
      </div>
    </aside>
  );
}
