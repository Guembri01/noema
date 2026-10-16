"use client";

import { useCallback, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { CornerDownLeft, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { hasMarkdown, markdownToTipTap } from "@/lib/markdown"
import { stripLoneSurrogates } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  applyAnswer,
  applyError,
  buildAskAiRequest,
  isStale,
  refreshContext,
  validateAskAiBlock,
  type AskAiBlock,
  type AskAiContext,
  type AskAiIssue,
  type AskAiPageContext,
  type AskAiRequest,
  type AskAiStatus,
} from "@/lib/ask-ai-block";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    askAi: {
      setAskAi: (attrs?: { prompt?: string }) => ReturnType;
    };
  }
}

/** Character cap the editor validates a stored prompt against (route cap). */
export const ASK_AI_PROMPT_MAX_CHARS = 4000;

/** The prompt the "Summarize page" button grounds a summarize request in. */
export const ASK_AI_SUMMARIZE_PROMPT = "Summarize this page";

/** Which `/api/ai` mode a request runs in. */
export type AskAiMode = "ask" | "summarize";

let askAiSeed = 0;

/** Mint a stable-enough id for a block that has never persisted one. */
export function mintAskAiId(): string {
  askAiSeed += 1;
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return `ask_${cryptoApi.randomUUID()}`;
    } catch {
      // fall through to the counter id
    }
  }
  return `ask_${Date.now().toString(36)}_${askAiSeed.toString(36)}`;
}

function readContext(value: unknown): AskAiContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as AskAiContext;
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Read the canonical {@link AskAiBlock} out of a node's persisted attributes.
 * The block engine is strict about ids, so a node that has never been saved gets
 * a freshly minted one; every other field is read defensively.
 */
export function askAiBlockFromAttrs(attrs: Record<string, unknown>): AskAiBlock {
  const context = readContext(attrs.context);
  const block: AskAiBlock = {
    id:
      typeof attrs.id === "string" && attrs.id.trim() !== "" ? attrs.id.trim() : mintAskAiId(),
    prompt: typeof attrs.prompt === "string" ? attrs.prompt : "",
    status: (typeof attrs.status === "string" ? attrs.status : "idle") as AskAiStatus,
    updatedAt: typeof attrs.updatedAt === "string" ? attrs.updatedAt : "",
  };
  if (typeof attrs.model === "string" && attrs.model.trim() !== "") block.model = attrs.model.trim();
  if (typeof attrs.answer === "string" && attrs.answer !== "") block.answer = attrs.answer;
  if (context) block.context = context;
  if (attrs.stale === true) block.stale = true;
  if (typeof attrs.error === "string" && attrs.error !== "") block.error = attrs.error;
  return block;
}

/** Project a canonical block back onto the node's persisted attributes. */
export function askAiAttrsFromBlock(block: AskAiBlock): Record<string, unknown> {
  return {
    id: block.id,
    prompt: block.prompt,
    answer: block.answer ?? "",
    model: block.model ?? null,
    context: block.context ?? null,
    status: block.status,
    updatedAt: block.updatedAt,
    stale: block.stale === true,
    error: block.error ?? "",
  };
}

/**
 * Build the grounding the engine reads from the live editor: one entry per
 * top-level block carrying its persisted id and its plain text.
 */
export function askAiPageContext(input: {
  pageId?: string;
  blocks?: ReadonlyArray<{ id?: unknown; text?: unknown }>;
}): AskAiPageContext {
  const blocks = (input.blocks ?? [])
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      content: typeof entry.text === "string" ? entry.text : "",
    }))
    .filter((entry) => entry.id !== "");
  const context: AskAiPageContext = { blocks };
  if (typeof input.pageId === "string" && input.pageId.trim() !== "") {
    context.pageId = input.pageId.trim();
  }
  return context;
}

/** Read the page context straight off a live editor instance. */
export function askAiContextFromEditor(editor: Editor, pageId?: string): AskAiPageContext {
  const blocks: Array<{ id: unknown; text: string }> = [];
  editor.state.doc.forEach((node) => {
    blocks.push({ id: node.attrs?.id, text: node.textContent });
  });
  return askAiPageContext({ pageId, blocks });
}

/** The deterministic engine output the node view hands to the AI route. */
export type AskAiPlan = {
  /** The block with a refreshed content-hash baseline. */
  block: AskAiBlock;
  /** The deterministic request `buildAskAiRequest` produced. */
  request: AskAiRequest;
  /** Validation issues (an empty list means the request may run). */
  issues: AskAiIssue[];
  /** The JSON body for `POST /api/ai`. */
  body: {
    prompt: string;
    context: string;
    workspaceId: string;
    mode: AskAiMode;
    maxTokens: number;
  };
  /** Whether the previous answer was already stale before this refresh. */
  stale: boolean;
};

/**
 * The engine→renderer seam. Given the stored block and the live page context it
 * validates the block, refreshes the context hashes, builds the deterministic
 * request and derives the `/api/ai` body from it. Pure: no clock is read unless
 * `now` is supplied, and nothing is mutated.
 */
export function planAskAiRequest(input: {
  block: AskAiBlock;
  pageContext?: AskAiPageContext;
  workspaceId: string;
  mode?: AskAiMode;
  now?: string | Date;
  maxPromptChars?: number;
  modelAllowlist?: readonly string[];
}): AskAiPlan {
  const mode: AskAiMode = input.mode ?? "ask";
  const pageContext = input.pageContext;
  const stale = isStale(input.block, pageContext);
  const issues = validateAskAiBlock(input.block, {
    maxPromptChars: input.maxPromptChars ?? ASK_AI_PROMPT_MAX_CHARS,
    ...(input.modelAllowlist === undefined ? {} : { modelAllowlist: input.modelAllowlist }),
  });
  const block = refreshContext(input.block, pageContext);
  const request = buildAskAiRequest(block, {
    ...(pageContext === undefined ? {} : { pageContext }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const prefix = `Question: ${block.prompt}`;
  const context = request.user.startsWith(prefix)
    ? request.user.slice(prefix.length).trim()
    : request.user;
  return {
    block,
    request,
    issues,
    body: {
      prompt: block.prompt,
      context,
      workspaceId: input.workspaceId,
      mode,
      maxTokens: request.params.maxTokens,
    },
    stale,
  };
}

/** Fold a successful answer into node attributes via `applyAnswer`. */
export function askAiAnsweredAttrs(
  block: AskAiBlock,
  answer: string,
  now?: string | Date,
): Record<string, unknown> {
  return askAiAttrsFromBlock(
    applyAnswer(block, { answer, ...(now === undefined ? {} : { now }) }),
  );
}

/** Fold a failure into node attributes via `applyError`. */
export function askAiFailedAttrs(
  block: AskAiBlock,
  message: string,
  now?: string | Date,
): Record<string, unknown> {
  return askAiAttrsFromBlock(
    applyError(block, { message, ...(now === undefined ? {} : { now }) }),
  );
}

/** Whether a stored block's answer is stale against the live page context. */
export function askAiIsStale(block: AskAiBlock, pageContext?: AskAiPageContext): boolean {
  return isStale(block, pageContext);
}

/** A block that asks the configured AI provider and can insert the answer. */
export const AskAi = Node.create<{ workspaceId: string; locale: string; pageId?: string }>({
  name: "askAi",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { workspaceId: "", locale: "en" };
  },

  addAttributes() {
    return {
      // The Ask-AI engine's canonical fields. `prompt`/`answer` are unchanged
      // from the original atom so stored documents keep loading.
      id: { default: null },
      prompt: { default: "" },
      answer: { default: "" },
      model: { default: null },
      context: { default: null },
      status: { default: "idle" },
      updatedAt: { default: "" },
      stale: { default: false },
      error: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-ask-ai]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-ask-ai": "" })];
  },

  addCommands() {
    return {
      setAskAi:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    const workspaceId = this.options.workspaceId;
    const locale = this.options.locale;
    const pageId = this.options.pageId;
    return ReactNodeViewRenderer((props) => (
      <AskAiView {...props} workspaceId={workspaceId} locale={locale} pageId={pageId} />
    ));
  },
});

function AskAiView({
  node,
  editor,
  updateAttributes,
  deleteNode,
  workspaceId,
  locale,
  pageId,
}: NodeViewProps & { workspaceId?: string; locale: string; pageId?: string }) {
  const [loading, setLoading] = useState(false);
  const block = askAiBlockFromAttrs(node.attrs as Record<string, unknown>);
  const prompt = block.prompt;
  const answer = block.answer ?? "";

  const run = useCallback(
    async (mode: AskAiMode) => {
      const requested: AskAiBlock =
        mode === "summarize" && block.prompt.trim() === ""
          ? { ...block, prompt: ASK_AI_SUMMARIZE_PROMPT }
          : block;
      const plan = planAskAiRequest({
        block: requested,
        pageContext: askAiContextFromEditor(editor, pageId),
        workspaceId: workspaceId ?? "",
        mode,
        now: new Date(),
      });
      if (plan.issues.length > 0) {
        toast.error(plan.issues[0]?.message ?? t(locale, "aiRequestFailed"));
        return;
      }
      setLoading(true);
      // Persist the refreshed context hashes (and the pending status) before the
      // request leaves, so a reload mid-flight still shows the right baseline.
      updateAttributes(askAiAttrsFromBlock({ ...plan.block, status: "pending" }));
      try {
        const response = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan.body),
        });
        const data = (await response.json()) as { text?: string; error?: string };
        if (!response.ok) {
          updateAttributes(
            askAiFailedAttrs(plan.block, data.error ?? t(locale, "aiRequestFailed")),
          );
          toast.error(data.error ?? t(locale, "aiRequestFailed"));
          return;
        }
        updateAttributes(askAiAnsweredAttrs(plan.block, stripLoneSurrogates(data.text ?? "")));
      } catch {
        updateAttributes(askAiFailedAttrs(plan.block, t(locale, "aiRequestFailed")));
        toast.error(t(locale, "aiRequestFailed"));
      } finally {
        setLoading(false);
      }
    },
    [block, editor, locale, pageId, updateAttributes, workspaceId],
  );

  const insertAnswer = () => {
    if (!answer.trim()) return;
    // Convert Markdown to real blocks (headings, lists, code) instead of
    // flattening every line into a paragraph.
    const content = hasMarkdown(answer)
      ? markdownToTipTap(answer)
      : answer
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
    if (content.length === 0) return;
    editor.chain().focus().insertContent(content).run();
  };

  return (
    <NodeViewWrapper className="noema-ask-ai" data-ask-ai="">
      <div className="noema-ask-card" contentEditable={false}>
        <div className="noema-ask-head">
          <Sparkles className="h-3.5 w-3.5" /> {t(locale, "askAI")}
          {block.stale === true && (
            <span className="noema-ask-stale" data-stale="true" title={t(locale, "askWord")}>
              <RefreshCw className="h-3 w-3" />
            </span>
          )}
        </div>
        <input
          value={prompt}
          onChange={(e) => updateAttributes({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run("ask");
            }
          }}
          placeholder={t(locale, "askAiPlaceholder")}
          className="noema-ask-input"
        />
        <div className="noema-ask-actions">
          <button
            type="button"
            disabled={loading}
            onClick={() => void run("ask")}
            className="noema-ask-btn"
          >
            {loading ? t(locale, "chatThinking") : t(locale, "askWord")}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void run("summarize")}
            className="noema-ask-btn"
          >
            {t(locale, "askSummarizePage")}
          </button>
          {answer && (
            <button type="button" onClick={insertAnswer} className="noema-ask-btn">
              <CornerDownLeft className="h-3.5 w-3.5" /> {t(locale, "insertWord")}
            </button>
          )}
          <button
            type="button"
            aria-label={t(locale, "remove")}
            onClick={() => deleteNode()}
            className="noema-ask-icon"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {block.error && <div className="noema-ask-error">{block.error}</div>}
        {answer && (
          <div className="noema-ask-answer">
            <Markdown text={answer} />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
