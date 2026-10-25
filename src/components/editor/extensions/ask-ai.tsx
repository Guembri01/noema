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
  ASK_AI_MODES,
  ASK_AI_OUTPUTS,
  ASK_AI_SOURCES,
  ASK_AI_SUMMARIZE_PROMPT,
  applyAnswer,
  applyError,
  buildAskAiRequest,
  isStale,
  refreshContext,
  validateAskAiBlock,
  type AskAiBlock,
  type AskAiContext,
  type AskAiIssue,
  type AskAiMode,
  type AskAiOutput,
  type AskAiPageContext,
  type AskAiRequest,
  type AskAiSource,
  type AskAiStatus,
} from "@/lib/ask-ai-block";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    askAi: {
      setAskAi: (attrs?: {
        prompt?: string;
        mode?: AskAiMode;
        output?: AskAiOutput;
        source?: AskAiSource;
      }) => ReturnType;
    };
  }
}

/** Character cap the editor validates a stored prompt against (route cap). */
export const ASK_AI_PROMPT_MAX_CHARS = 4000;

/** Re-export the shared default so the slash menu and the node agree. */
export { ASK_AI_SUMMARIZE_PROMPT };

/** Which `/api/ai` mode a request runs in (kept for existing imports). */
export type { AskAiMode };

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
    mode:
      typeof attrs.mode === "string" &&
      (ASK_AI_MODES as readonly string[]).includes(attrs.mode)
        ? (attrs.mode as AskAiMode)
        : "ask",
    output:
      typeof attrs.output === "string" &&
      (ASK_AI_OUTPUTS as readonly string[]).includes(attrs.output)
        ? (attrs.output as AskAiOutput)
        : "answer",
    source:
      typeof attrs.source === "string" &&
      (ASK_AI_SOURCES as readonly string[]).includes(attrs.source)
        ? (attrs.source as AskAiSource)
        : "page",
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
    mode: block.mode ?? "ask",
    output: block.output ?? "answer",
    source: block.source ?? "page",
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
    pageId?: string;
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
 *
 * `pageId` is the page the block lives in — supplied by the editor (the page
 * route's id), never read out of the block's attributes. The route re-checks
 * access and derives the page text server-side; the `context` sent here is a
 * fallback/display preview only.
 */
export function planAskAiRequest(input: {
  block: AskAiBlock;
  pageContext?: AskAiPageContext;
  workspaceId: string;
  pageId?: string;
  mode?: AskAiMode;
  now?: string | Date;
  maxPromptChars?: number;
  modelAllowlist?: readonly string[];
}): AskAiPlan {
  const mode: AskAiMode = input.mode ?? input.block.mode ?? "ask";
  const source: AskAiSource = input.block.source ?? "page";
  const requested: AskAiBlock =
    mode === "summarize" && input.block.prompt.trim() === ""
      ? { ...input.block, prompt: ASK_AI_SUMMARIZE_PROMPT }
      : input.block;
  const usePageContext = source === "page" && input.pageContext !== undefined;
  const pageContext = usePageContext ? input.pageContext : undefined;
  const stale = usePageContext ? isStale(requested, pageContext) : false;
  const issues = validateAskAiBlock(requested, {
    maxPromptChars: input.maxPromptChars ?? ASK_AI_PROMPT_MAX_CHARS,
    ...(input.modelAllowlist === undefined ? {} : { modelAllowlist: input.modelAllowlist }),
  });
  const block = usePageContext ? refreshContext(requested, pageContext) : requested;
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
      context: usePageContext ? context : "",
      workspaceId: input.workspaceId,
      ...(typeof input.pageId === "string" && input.pageId.trim() !== ""
        ? { pageId: input.pageId.trim() }
        : {}),
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

/** Convert an answer into editor blocks (Markdown when it looks like Markdown). */
export function askAiAnswerContent(answer: string): Array<Record<string, unknown>> {
  if (typeof answer !== "string" || answer.trim() === "") return [];
  // Convert Markdown to real blocks (headings, lists, code) instead of
  // flattening every line into a paragraph.
  if (hasMarkdown(answer)) return markdownToTipTap(answer) as Array<Record<string, unknown>>;
  return answer
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
}

/** Where a configured output writes the answer, relative to the block node. */
export type AskAiInsertion = { from: number; to?: number };

/**
 * The argument `insertContentAt` takes for an insertion: a bare position for
 * an insert, a `{from,to}` range for a replacement.
 */
export function askAiInsertTarget(
  insertion: AskAiInsertion,
): number | { from: number; to: number } {
  return insertion.to === undefined
    ? insertion.from
    : { from: insertion.from, to: insertion.to };
}

/**
 * The document range an answer is written into for a configured output.
 * `answer` keeps the text in the card (nothing to insert) and a non-finite
 * position is ignored, so a detached node never corrupts the document.
 */
export function askAiInsertionFor(
  pos: number | undefined,
  nodeSize: number,
  output: AskAiOutput,
): AskAiInsertion | null {
  if (typeof pos !== "number" || !Number.isFinite(pos) || pos < 0) return null;
  if (!Number.isFinite(nodeSize) || nodeSize <= 0) return null;
  if (output === "insert") return { from: pos + nodeSize };
  if (output === "replace") return { from: pos, to: pos + nodeSize };
  return null;
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
      // The configured action and where its output goes, persisted so a
      // reloaded page runs the block the author set up.
      mode: { default: "ask" },
      output: { default: "answer" },
      source: { default: "page" },
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
  getPos,
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
  const mode = block.mode ?? "ask";
  const output = block.output ?? "answer";
  const source = block.source ?? "page";
  // Pending is an in-flight request, not a stored flag: a page reloaded after
  // a crash mid-request should not claim to still be thinking.
  const pending = loading;

  /** The node's live position, or `undefined` when it has been detached. */
  const currentPos = (): number | undefined => {
    try {
      return getPos();
    } catch {
      return undefined;
    }
  };

  const run = useCallback(async () => {
    const plan = planAskAiRequest({
      block,
      pageContext: source === "page" ? askAiContextFromEditor(editor, pageId) : undefined,
      workspaceId: workspaceId ?? "",
      ...(pageId === undefined ? {} : { pageId }),
      mode,
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
      const data = (await response.json().catch(() => null)) as
        | { text?: string; error?: string }
        | null;
      if (!response.ok) {
        const message = data?.error ?? `${t(locale, "aiRequestFailed")} (${response.status})`;
        updateAttributes(askAiFailedAttrs(plan.block, message));
        toast.error(message);
        return;
      }
      const text = stripLoneSurrogates(data?.text ?? "");
      if (output === "replace") {
        // Replace the block itself; there is no card left to update when the
        // replacement succeeded. With no live position, keep the answer in the
        // card rather than dropping it.
        const content = askAiAnswerContent(text);
        const insertion = askAiInsertionFor(currentPos(), node.nodeSize, output);
        if (insertion && content.length > 0) {
          editor.chain().focus().insertContentAt(askAiInsertTarget(insertion), content).run();
        } else {
          updateAttributes(askAiAnsweredAttrs(plan.block, text));
        }
        return;
      }
      updateAttributes(askAiAnsweredAttrs(plan.block, text));
      if (output === "insert") {
        const content = askAiAnswerContent(text);
        const insertion = askAiInsertionFor(currentPos(), node.nodeSize, output);
        if (insertion && content.length > 0) {
          editor.chain().focus().insertContentAt(askAiInsertTarget(insertion), content).run();
        }
      }
    } catch {
      updateAttributes(askAiFailedAttrs(plan.block, t(locale, "aiRequestFailed")));
      toast.error(t(locale, "aiRequestFailed"));
    } finally {
      setLoading(false);
    }
  }, [
    block,
    editor,
    getPos,
    locale,
    mode,
    node.nodeSize,
    output,
    pageId,
    source,
    updateAttributes,
    workspaceId,
  ]);

  const insertAnswer = () => {
    const content = askAiAnswerContent(answer);
    if (content.length === 0) return;
    const insertion = askAiInsertionFor(currentPos(), node.nodeSize, "insert");
    if (insertion) editor.chain().focus().insertContentAt(askAiInsertTarget(insertion), content).run();
    else editor.chain().focus().insertContent(content).run();
  };

  return (
    <NodeViewWrapper className="noema-ask-ai" data-ask-ai="">
      <div className="noema-ask-card" contentEditable={false}>
        <div className="noema-ask-head">
          <Sparkles className="h-3.5 w-3.5" /> {t(locale, "askAI")}
          {block.stale === true && (
            <span className="noema-ask-stale" data-stale="true" title={t(locale, "askAiStale")}>
              <RefreshCw className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="noema-ask-config">
          <select
            value={mode}
            aria-label={t(locale, "askAiMode")}
            onChange={(e) => {
              const nextMode = e.target.value as AskAiMode;
              // A summary with no page has nothing to summarize; keep the
              // selector honest instead of letting the run fail on validation.
              updateAttributes(
                nextMode === "summarize"
                  ? { mode: nextMode, source: "page" }
                  : { mode: nextMode },
              );
            }}
            className="noema-ask-select"
          >
            <option value="ask">{t(locale, "askWord")}</option>
            <option value="summarize">{t(locale, "askSummarizePage")}</option>
          </select>
          <select
            value={output}
            aria-label={t(locale, "askAiOutput")}
            onChange={(e) => updateAttributes({ output: e.target.value as AskAiOutput })}
            className="noema-ask-select"
          >
            <option value="answer">{t(locale, "askAiOutputAnswer")}</option>
            <option value="insert">{t(locale, "askAiOutputInsert")}</option>
            <option value="replace">{t(locale, "askAiOutputReplace")}</option>
          </select>
          <label className="noema-ask-source">
            <input
              type="checkbox"
              checked={source === "page"}
              disabled={mode === "summarize"}
              onChange={(e) =>
                updateAttributes({ source: e.target.checked ? "page" : "none" })
              }
            />
            {t(locale, "askAiUsePage")}
          </label>
        </div>
        <input
          value={prompt}
          onChange={(e) => updateAttributes({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={t(locale, "askAiPlaceholder")}
          className="noema-ask-input"
        />
        <div className="noema-ask-actions">
          <button
            type="button"
            disabled={loading || !workspaceId}
            onClick={() => void run()}
            className="noema-ask-btn focus-ring u-interactive"
          >
            {loading
              ? t(locale, "chatThinking")
              : mode === "summarize"
                ? t(locale, "askSummarizePage")
                : t(locale, "askWord")}
          </button>
          {answer && output === "answer" && (
            <button
              type="button"
              onClick={insertAnswer}
              aria-label={t(locale, "insertWord")}
              className="noema-ask-btn focus-ring u-interactive"
            >
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
        {pending && (
          <div className="noema-ask-pending" role="status">
            {t(locale, "chatThinking")}
          </div>
        )}
        {block.error && (
          <div className="noema-ask-error" role="alert">
            {block.error}
          </div>
        )}
        {answer && (
          <div className="noema-ask-answer">
            <Markdown text={answer} />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
