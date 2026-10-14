"use client";

import { useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { CornerDownLeft, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { hasMarkdown, markdownToTipTap } from "@/lib/markdown"
import { stripLoneSurrogates } from "@/lib/utils";
import { t } from "@/lib/i18n";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    askAi: {
      setAskAi: (attrs?: { prompt?: string }) => ReturnType;
    };
  }
}

/** A block that asks the configured AI provider and can insert the answer. */
export const AskAi = Node.create<{ workspaceId: string; locale: string }>({
  name: "askAi",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { workspaceId: "", locale: "en" };
  },

  addAttributes() {
    return {
      prompt: { default: "" },
      answer: { default: "" },
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
    return ReactNodeViewRenderer((props) => (
      <AskAiView {...props} workspaceId={workspaceId} locale={locale} />
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
}: NodeViewProps & { workspaceId?: string; locale: string }) {
  const [loading, setLoading] = useState(false);
  const prompt = String(node.attrs.prompt ?? "");
  const answer = String(node.attrs.answer ?? "");

  const ask = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          context: editor.getText().slice(0, 6000),
          workspaceId,
        }),
      });
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) {
        toast.error(data.error ?? t(locale, "aiRequestFailed"));
        return;
      }
      updateAttributes({ answer: stripLoneSurrogates(data.text ?? "") });
    } catch {
      toast.error(t(locale, "aiRequestFailed"));
    } finally {
      setLoading(false);
    }
  };

  const summarize = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "summarize",
          context: editor.getText().slice(0, 8000),
          workspaceId,
        }),
      });
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) {
        toast.error(data.error ?? t(locale, "aiRequestFailed"));
        return;
      }
      updateAttributes({ answer: stripLoneSurrogates(data.text ?? "") });
    } catch {
      toast.error(t(locale, "aiRequestFailed"));
    } finally {
      setLoading(false);
    }
  };

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
        </div>
        <input
          value={prompt}
          onChange={(e) => updateAttributes({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder={t(locale, "askAiPlaceholder")}
          className="noema-ask-input"
        />
        <div className="noema-ask-actions">
          <button
            type="button"
            disabled={loading}
            onClick={() => void ask()}
            className="noema-ask-btn"
          >
            {loading ? t(locale, "chatThinking") : t(locale, "askWord")}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void summarize()}
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
        {answer && (
          <div className="noema-ask-answer">
            <Markdown text={answer} />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
