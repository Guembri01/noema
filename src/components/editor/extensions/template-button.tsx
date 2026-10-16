"use client";

import { useCallback, useRef } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Copy, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TEMPLATES, templateContent, type TemplateId } from "@/lib/templates";
import type { RichNode } from "@/lib/blocks";
import {
  describeButton,
  parseButtonBlock,
  parseTemplateButton,
  planButtonClick,
  planTemplateButtonClick,
  validateButtonBlock,
  type ButtonBlock as StoredButtonBlock,
  type ButtonClickContext,
  type ButtonClickPlan,
  type TemplateButtonBlock,
  type TemplateInsertSource,
} from "@/lib/template-blocks";
import { t } from "@/lib/i18n";

/**
 * Template-button + Button block editor nodes. The pure parsers, validator,
 * click planner and template resolver live in `src/lib/template-blocks.ts`;
 * this file is the thin TipTap adapter that turns a stored node into a plan and
 * executes the client-side part of it.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    templateButton: {
      setTemplateButton: (attrs?: { templateId?: TemplateId }) => ReturnType;
    };
    button: {
      setButton: (attrs?: Record<string, unknown>) => ReturnType;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a `TemplateButtonBlock` from node attrs (strict, via `parseTemplateButton`). */
export function templateButtonBlockFromAttrs(attrs: unknown): TemplateButtonBlock | null {
  return parseTemplateButton(attrs);
}

/** Read a `ButtonBlock` from node attrs (strict, via `parseButtonBlock`). */
export function buttonBlockFromAttrs(attrs: unknown): StoredButtonBlock | null {
  return parseButtonBlock(attrs);
}

/**
 * The built-in templates projected onto the engine's `TemplateInsertSource`
 * shape: each top-level block becomes a `{ id, index, type }` entry so
 * `resolveTemplateInsert` can mint fresh ids and order them.
 */
export function builtinTemplateSources(): TemplateInsertSource[] {
  return TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    blocks: template.build().map((node, index) => ({
      id: `src-${template.id}-${index}`,
      index,
      ...(typeof node.type === "string" ? { type: node.type } : {}),
    })),
  }));
}

/** Known ids for `validateButtonBlock` membership checks. */
export function builtinButtonContext(options: { now?: string; actorId?: string } = {}): ButtonClickContext {
  return {
    templates: builtinTemplateSources(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
  };
}

/** Validate a template-button's derived button block against the built-ins. */
export function templateButtonIssues(attrs: unknown) {
  const block = templateButtonBlockFromAttrs(attrs);
  if (!block) return [{ path: "", code: "not_an_object" as const, message: "Not a template button." }];
  return validateButtonBlock(
    { id: block.id, label: block.label, action: { type: "insertTemplate", templateId: block.templateId } },
    { templates: TEMPLATES.map((template) => template.id) },
  );
}

/** Plan a template-button click via `planTemplateButtonClick`. */
export function planTemplateButtonAttrs(
  attrs: unknown,
  context: ButtonClickContext = {},
): ButtonClickPlan | null {
  const block = templateButtonBlockFromAttrs(attrs);
  if (!block) return null;
  return planTemplateButtonClick(block, context);
}

/** Plan a Button node click via `planButtonClick`. */
export function planButtonNodeClick(
  attrs: unknown,
  context: ButtonClickContext = {},
): ButtonClickPlan | null {
  const block = buttonBlockFromAttrs(attrs);
  if (!block) return null;
  return planButtonClick(block, context);
}

/** Human-readable reason an action cannot be executed in the editor. */
export const BUTTON_SETPROPS_REASON =
  "Property patches need a database/property context that a page button does not carry.";

/** Whether a plan can execute client-side (and, if not, why). */
export function buttonPlanExecutability(
  plan: ButtonClickPlan,
): { executable: boolean; reason?: string } {
  switch (plan.kind) {
    case "insertTemplate":
    case "openPage":
    case "duplicate":
    case "webhook":
      return { executable: true };
    case "setProps":
      return { executable: false, reason: BUTTON_SETPROPS_REASON };
    case "invalid":
      return {
        executable: false,
        reason: plan.issues.map((issue) => issue.message).join("; ") || "Invalid button.",
      };
  }
}

/**
 * The TipTap content for an `insertTemplate` plan: the built-in template's real
 * rich nodes, each stamped with the fresh id `resolveTemplateInsert` minted.
 */
export function templateInsertContent(plan: ButtonClickPlan): RichNode[] | null {
  if (plan.kind !== "insertTemplate") return null;
  const template = TEMPLATES.find((entry) => entry.id === (plan.templateId as TemplateId));
  if (!template) return null;
  return templateContent(template.id).map((node, index) => {
    const inserted = plan.insert.blocks[index];
    if (!inserted) return node;
    return { ...node, attrs: { ...(node.attrs ?? {}), id: inserted.id } };
  });
}

/** A reusable button that inserts a block template at its position. */
export const TemplateButton = Node.create<{ locale: string }>({
  name: "templateButton",
  group: "block",
  atom: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      id: { default: null },
      templateId: { default: "meeting" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-template-button]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-template-button": "" })];
  },

  addCommands() {
    return {
      setTemplateButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attrs ?? { templateId: "meeting" },
          }),
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <TemplateButtonView {...props} locale={locale} />
    ));
  },
});

/** An interactive button that runs a configured action. */
export const ButtonBlock = Node.create<{ locale: string }>({
  name: "button",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      label: { default: "" },
      icon: { default: null },
      action: { default: null },
      confirm: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-button-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-button-block": "" })];
  },

  addCommands() {
    return {
      setButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ButtonBlockView {...props} locale={locale} />
    ));
  },
});

/**
 * D7 note: previously the labels below — `aria-label="Choose template"`,
 * "Insert" and `aria-label="Remove template button"` — were English literals
 * because this node view received no locale. `page-editor.tsx` now threads the
 * active locale here through the extension's `configure({ locale })` option and
 * the strings resolve from the shared catalogue.
 */
function TemplateButtonView({
  node,
  editor,
  getPos,
  deleteNode,
  locale,
}: NodeViewProps & { locale: string }) {
  const templateId = (node.attrs.templateId as TemplateId) ?? "meeting";
  const definition = TEMPLATES.find((entry) => entry.id === templateId) ?? TEMPLATES[0];
  const issues = templateButtonIssues(node.attrs as Record<string, unknown>);
  // Non-blocking confirmation for `confirm` buttons: the first activation arms
  // it and shows the description, the second one runs it (no window.confirm).
  const confirmArmed = useRef(false);

  const insert = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const plan = planTemplateButtonAttrs(
      {
        id: typeof node.attrs.id === "string" && node.attrs.id !== "" ? node.attrs.id : "templateButton",
        templateId,
        label: definition.label,
      },
      builtinButtonContext({ now: new Date().toISOString() }),
    );
    if (!plan || plan.kind !== "insertTemplate") {
      toast.error(issues[0]?.message ?? t(locale, "configureButtonFirst"));
      return;
    }
    const content = templateInsertContent(plan);
    if (!content) return;
    editor.chain().focus().insertContentAt(pos + node.nodeSize, content).run();
  };

  return (
    <NodeViewWrapper className="noema-template-button" data-template-button="">
      <div className="noema-template-card" contentEditable={false}>
        <span className="noema-template-label">
          <Copy className="h-3.5 w-3.5" />
          {definition.label}
        </span>
        <select
          value={templateId}
          onChange={(event) =>
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(getPos() as number, undefined, {
                  templateId: event.target.value,
                });
                return true;
              })
              .run()
          }
          aria-label={t(locale, "chooseTemplate")}
          className="noema-template-select"
        >
          {TEMPLATES.map((template) => (
            <option key={template.id} value={template.id}>
              {template.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="noema-template-insert"
          disabled={issues.length > 0}
          onClick={insert}
        >
          {t(locale, "insertWord")}
        </button>
        <button
          type="button"
          aria-label={t(locale, "templateRemoveAria")}
          className="noema-template-remove"
          onClick={() => deleteNode()}
        >
          ×
        </button>
      </div>
    </NodeViewWrapper>
  );
}

/** Collect the JSON of the named source blocks, dropping ids so copies re-mint. */
function duplicateSourceContent(editor: NodeViewProps["editor"], sourceIds: readonly string[]): RichNode[] {
  const wanted = new Set(sourceIds);
  const content: RichNode[] = [];
  editor.state.doc.forEach((child) => {
    const id = child.attrs?.id;
    if (typeof id !== "string" || !wanted.has(id)) return;
    const json = child.toJSON() as RichNode;
    if (json.attrs) {
      const attrs = { ...json.attrs };
      delete attrs.id;
      json.attrs = attrs;
    }
    content.push(json);
  });
  return content;
}

function ButtonBlockView({
  node,
  editor,
  getPos,
  deleteNode,
  locale,
}: NodeViewProps & { locale: string }) {
  const attrs = node.attrs as Record<string, unknown>;
  const block = buttonBlockFromAttrs(attrs);
  const label = block?.label ?? String(attrs.label ?? t(locale, "buttonConfigured"));
  // Non-blocking confirmation for `confirm` buttons: the first activation arms
  // it and shows the description, the second one runs it (no window.confirm).
  const confirmArmed = useRef(false);

  const run = useCallback(async () => {
    if (!block) {
      toast.error(t(locale, "configureButtonFirst"));
      return;
    }
    const plan = planButtonNodeClick(attrs, builtinButtonContext({ now: new Date().toISOString() }));
    if (!plan) {
      toast.error(t(locale, "configureButtonFirst"));
      return;
    }
    const executability = buttonPlanExecutability(plan);
    if (!executability.executable) {
      toast.error(executability.reason ?? t(locale, "configureButtonFirst"));
      return;
    }
    if (block.confirm && typeof window !== "undefined" && !confirmArmed.current) {
      confirmArmed.current = true;
      toast(describeButton(block));
      return;
    }
    confirmArmed.current = false;
    const pos = getPos();
    if (typeof pos !== "number") return;

    switch (plan.kind) {
      case "insertTemplate": {
        const content = templateInsertContent(plan);
        if (content) editor.chain().focus().insertContentAt(pos + node.nodeSize, content).run();
        return;
      }
      case "openPage": {
        if (typeof window !== "undefined") {
          window.location.assign(`/page/${encodeURIComponent(plan.pageId)}`);
        }
        return;
      }
      case "duplicate": {
        const content = duplicateSourceContent(editor, plan.sourceIds);
        if (content.length > 0) {
          editor.chain().focus().insertContentAt(pos + node.nodeSize, content).run();
        }
        return;
      }
      case "webhook": {
        try {
          await fetch(plan.url, {
            method: plan.method,
            ...(plan.body === undefined
              ? {}
              : {
                  body: typeof plan.body === "string" ? plan.body : JSON.stringify(plan.body),
                  headers: { "content-type": "application/json" },
                }),
          });
        } catch {
          toast.error(t(locale, "somethingWentWrongDot"));
        }
        return;
      }
      case "invalid":
      case "setProps":
        return;
    }
  }, [attrs, block, editor, getPos, locale, node.nodeSize]);

  return (
    <NodeViewWrapper className="noema-button-block" data-button-block="">
      <div className="noema-button-card" contentEditable={false}>
        <button type="button" className="noema-button-run" onClick={() => void run()}>
          <Play className="h-3.5 w-3.5" /> {label}
        </button>
        <button
          type="button"
          aria-label={t(locale, "remove")}
          className="noema-button-remove"
          onClick={() => deleteNode()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </NodeViewWrapper>
  );
}
