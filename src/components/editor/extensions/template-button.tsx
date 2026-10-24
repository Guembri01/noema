"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Copy, Play, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TEMPLATES, templateContent, type TemplateId } from "@/lib/templates";
import type { RichNode } from "@/lib/blocks";
import type { PageTemplate } from "@/lib/template-gallery";
import {
  BUTTON_BLOCK_ACTIONS,
  BUTTON_BLOCK_STYLES,
  buttonPlanExecutability as coreButtonPlanExecutability,
  describeButton,
  parseButtonAction,
  parseButtonBlock,
  parseTemplateButton,
  planButtonClick,
  planTemplateButtonClick,
  resolveTemplateInsert,
  validateButtonBlock,
  type ButtonBlock as StoredButtonBlock,
  type ButtonBlockAction,
  type ButtonBlockStyle,
  type ButtonClickContext,
  type ButtonClickPlan,
  type TemplateButtonBlock,
  type TemplateInsertSource,
} from "@/lib/template-blocks";
import { listWorkspaceTemplatesAction } from "@/server/actions/home-templates";
import {
  executeButtonBlockAction,
  resolveTemplateInsertAction,
} from "@/server/actions/button-blocks";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

/**
 * Template-button + Button block editor nodes. The pure parsers, validator,
 * click planner and template resolver live in `src/lib/template-blocks.ts`,
 * which delegates the action vocabulary to the shared ButtonAction engine
 * (`src/lib/row-buttons.ts`). This file is the thin TipTap adapter: it loads the
 * workspace's saved templates, renders the node views and executes the
 * client-side half of a plan after the server action has authorized it.
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

type BlockNodeOptions = {
  locale: string;
  /** Workspace whose saved templates are offered / checked server-side. */
  workspaceId?: string;
  /** The page the block lives on (server permission checks + insertion). */
  pageId?: string;
};

/** A stable-enough id for a newly inserted atom (the editor never mints one). */
function newBlockId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

/** Project a saved workspace template onto the engine's insert-source shape. */
export function savedTemplateSource(template: PageTemplate): TemplateInsertSource {
  return templateSourceFromBlocks(template.id, template.blocks ?? [], template.name);
}

/** Project a raw block list onto an insert source with stable source ids. */
export function templateSourceFromBlocks(
  templateId: string,
  blocks: readonly RichNode[],
  label?: string,
): TemplateInsertSource {
  return {
    id: templateId,
    ...(label === undefined ? {} : { label }),
    blocks: blocks.map((node, index) => ({
      id:
        typeof node.attrs?.id === "string" && node.attrs.id !== ""
          ? node.attrs.id
          : `src-${templateId}-${index}`,
      index,
      ...(typeof node.type === "string" ? { type: node.type } : {}),
    })),
  };
}

/** Known ids for `validateButtonBlock` membership checks. */
export function builtinButtonContext(
  options: { now?: string; actorId?: string } = {},
): ButtonClickContext {
  return {
    templates: builtinTemplateSources(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
  };
}

/** Validate a template-button's derived button block against known templates. */
export function templateButtonIssues(attrs: unknown, templateIds?: readonly string[]) {
  const block = templateButtonBlockFromAttrs(attrs);
  if (!block) return [{ path: "", code: "not_an_object" as const, message: "Not a template button." }];
  return validateButtonBlock(
    {
      id: block.id,
      label: block.label,
      action: { kind: "insert_template", templateId: block.templateId },
    },
    { templates: templateIds ?? TEMPLATES.map((template) => template.id) },
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

/** Re-exported so the editor and its tests share one executability decision. */
export const buttonPlanExecutability = coreButtonPlanExecutability;

/**
 * The TipTap content for an `insertTemplate` plan. Built-in templates come from
 * `templateContent`; saved workspace templates pass their materialized block
 * list. Each block gets the fresh id `resolveTemplateInsert` minted.
 */
export function templateInsertContent(
  plan: ButtonClickPlan,
  blocks?: readonly RichNode[],
): RichNode[] | null {
  if (plan.kind !== "insertTemplate") return null;
  const source = blocks ?? templateContent(plan.templateId as TemplateId);
  if (!source || source.length === 0) return null;
  return source.map((node, index) => {
    const inserted = plan.insert.blocks[index];
    if (!inserted) return node;
    return { ...node, attrs: { ...(node.attrs ?? {}), id: inserted.id } };
  });
}

/* ---------------------------------------------------------------------------
   Saved-template catalogue (one request per workspace per session)
   --------------------------------------------------------------------------- */

type CatalogState = {
  status: "loading" | "ready" | "error";
  templates: PageTemplate[];
  error?: string;
};

const catalogCache = new Map<string, Promise<PageTemplate[]>>();

function loadWorkspaceTemplates(workspaceId: string): Promise<PageTemplate[]> {
  const cached = catalogCache.get(workspaceId);
  if (cached) return cached;
  const promise = (async () => {
    const outcome = await safeAction(() => listWorkspaceTemplatesAction({ workspaceId }));
    if (!outcome.ok) throw new Error(outcome.error);
    if ("error" in outcome.value) throw new Error(outcome.value.error);
    return outcome.value.templates;
  })();
  catalogCache.set(workspaceId, promise);
  void promise.catch(() => catalogCache.delete(workspaceId));
  return promise;
}

function useTemplateCatalog(workspaceId: string | undefined): CatalogState {
  const [state, setState] = useState<CatalogState>(() =>
    workspaceId
      ? { status: "loading", templates: [] }
      : { status: "ready", templates: [] },
  );

  useEffect(() => {
    if (!workspaceId) {
      setState({ status: "ready", templates: [] });
      return;
    }
    let active = true;
    setState({ status: "loading", templates: [] });
    loadWorkspaceTemplates(workspaceId)
      .then((templates) => {
        if (active) setState({ status: "ready", templates });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          templates: [],
          error: error instanceof Error ? error.message : undefined,
        });
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return state;
}

function templateLabelById(
  templateId: string,
  saved: readonly PageTemplate[],
): string {
  return (
    TEMPLATES.find((template) => template.id === templateId)?.label ??
    saved.find((template) => template.id === templateId)?.name ??
    templateId
  );
}

/* ---------------------------------------------------------------------------
   Nodes
   --------------------------------------------------------------------------- */

/** A reusable button that inserts a block template at its position. */
export const TemplateButton = Node.create<BlockNodeOptions>({
  name: "templateButton",
  group: "block",
  atom: true,

  addOptions() {
    return { locale: "en", workspaceId: undefined, pageId: undefined };
  },

  addAttributes() {
    return {
      id: { default: null },
      templateId: { default: "meeting" },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-template-button]",
        getAttrs: (element) => {
          const node = element as HTMLElement;
          return {
            id: node.getAttribute("data-id") ?? null,
            templateId: node.getAttribute("data-template-id") ?? "meeting",
            label: node.getAttribute("data-label") ?? "",
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "div",
      mergeAttributes({
        "data-template-button": "",
        "data-id": String(node.attrs.id ?? ""),
        "data-template-id": String(node.attrs.templateId ?? ""),
        "data-label": String(node.attrs.label ?? ""),
      }),
    ];
  },

  addCommands() {
    return {
      setTemplateButton:
        (attrs) =>
        ({ commands }) => {
          const templateId = attrs?.templateId ?? "meeting";
          return commands.insertContent({
            type: this.name,
            attrs: {
              id: newBlockId(),
              templateId,
              label: TEMPLATES.find((template) => template.id === templateId)?.label ?? "",
              ...(attrs ?? {}),
            },
          });
        },
    };
  },

  addNodeView() {
    const { locale, workspaceId, pageId } = this.options;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <TemplateButtonView
        {...props}
        locale={locale}
        workspaceId={workspaceId}
        pageId={pageId}
      />
    ));
  },
});

/** An interactive button that runs a configured action. */
export const ButtonBlock = Node.create<BlockNodeOptions>({
  name: "button",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en", workspaceId: undefined, pageId: undefined };
  },

  addAttributes() {
    return {
      id: { default: null },
      label: { default: "" },
      icon: { default: null },
      action: { default: null },
      confirm: { default: false },
      style: { default: "default" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-button-block]",
        getAttrs: (element) => {
          const node = element as HTMLElement;
          let action: unknown = null;
          const raw = node.getAttribute("data-action");
          if (raw) {
            try {
              action = JSON.parse(raw);
            } catch {
              action = null;
            }
          }
          return {
            id: node.getAttribute("data-id") ?? null,
            label: node.getAttribute("data-label") ?? "",
            style: node.getAttribute("data-style") ?? "default",
            action,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "div",
      mergeAttributes({
        "data-button-block": "",
        "data-id": String(node.attrs.id ?? ""),
        "data-label": String(node.attrs.label ?? ""),
        "data-style": String(node.attrs.style ?? "default"),
        "data-action":
          node.attrs.action === null || node.attrs.action === undefined
            ? ""
            : JSON.stringify(node.attrs.action),
      }),
    ];
  },

  addCommands() {
    return {
      setButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              id: newBlockId(),
              label: "",
              action: null,
              style: "default",
              ...(attrs ?? {}),
            },
          }),
    };
  },

  addNodeView() {
    const { locale, workspaceId, pageId } = this.options;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ButtonBlockView
        {...props}
        locale={locale}
        workspaceId={workspaceId}
        pageId={pageId}
      />
    ));
  },
});

/* ---------------------------------------------------------------------------
   Template button view
   --------------------------------------------------------------------------- */

function TemplateButtonView({
  node,
  editor,
  getPos,
  deleteNode,
  locale,
  workspaceId,
  pageId,
}: NodeViewProps & {
  locale: string;
  workspaceId?: string;
  pageId?: string;
}) {
  const catalog = useTemplateCatalog(workspaceId);
  const templateId = (node.attrs.templateId as TemplateId) ?? "meeting";
  const builtin = TEMPLATES.find((entry) => entry.id === templateId);
  const saved = catalog.templates.find((entry) => entry.id === templateId);
  const savedSources = useMemo(
    () => catalog.templates.map((template) => savedTemplateSource(template)),
    [catalog.templates],
  );
  const allSources = useMemo(
    () => [...builtinTemplateSources(), ...savedSources],
    [savedSources],
  );
  const loadingMissing = !builtin && !saved && catalog.status === "loading";
  const missing = !builtin && !saved && catalog.status !== "loading";
  const label =
    builtin?.label ?? saved?.name ?? (loadingMissing ? t(locale, "templateLoading") : t(locale, "templateMissing"));
  const issues = validateButtonBlock(
    {
      id:
        typeof node.attrs.id === "string" && node.attrs.id !== ""
          ? node.attrs.id
          : "templateButton",
      label,
      action: { kind: "insert_template", templateId },
    },
    { templates: allSources.map((source) => source.id) },
  );
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const setTemplateId = (nextId: string) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, {
          templateId: nextId,
          label: templateLabelById(nextId, catalog.templates),
        });
        return true;
      })
      .run();
    setStatus("idle");
    setErrorMessage(null);
  };

  const insert = async () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (missing) {
      toast.error(t(locale, "templateMissing"));
      return;
    }

    if (!workspaceId || !pageId) {
      const message = t(locale, "templateLoadFailed");
      setStatus("error");
      setErrorMessage(message);
      toast.error(message);
      return;
    }

    // Always resolve through the server, including built-ins: that re-checks
    // the page's edit capability and, for a saved template, its workspace
    // binding (a deleted/foreign id never reaches the document).
    setStatus("pending");
    setErrorMessage(null);
    try {
      const outcome = await safeAction(() =>
        resolveTemplateInsertAction({
          workspaceId,
          pageId,
          templateId,
        }),
      );
      if (!outcome.ok) throw new Error(outcome.error);
      const result = outcome.value;
      if ("error" in result) throw new Error(result.error);
      const source = templateSourceFromBlocks(result.templateId, result.blocks, label);
      const insertPlan = resolveTemplateInsert(source, {
        now: new Date().toISOString(),
      });
      const content = templateInsertContent(
        {
          kind: "insertTemplate",
          blockId:
            typeof node.attrs.id === "string" && node.attrs.id !== ""
              ? node.attrs.id
              : "templateButton",
          label,
          confirm: false,
          templateId: result.templateId,
          insert: insertPlan,
        },
        result.blocks,
      );
      if (!content) throw new Error(issues[0]?.message ?? t(locale, "configureButtonFirst"));
      editor.chain().focus().insertContentAt(pos + node.nodeSize, content).run();
      setStatus("success");
      setErrorMessage(null);
      toast.success(t(locale, "buttonRunSuccess"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t(locale, "templateLoadFailed");
      setStatus("error");
      setErrorMessage(message);
      toast.error(message);
    }
  };

  return (
    <NodeViewWrapper className="noema-template-button" data-template-button="">
      <div className="noema-template-card" contentEditable={false}>
        <span className="noema-template-label">
          <Copy className="h-3.5 w-3.5" />
          {label}
        </span>
        <select
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
          aria-label={t(locale, "chooseTemplate")}
          className="noema-template-select"
        >
          {missing || loadingMissing ? (
            <option value={templateId}>{label}</option>
          ) : null}
          <optgroup label={t(locale, "templateBuiltinGroup")}>
            {TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </optgroup>
          {catalog.templates.length > 0 ? (
            <optgroup label={t(locale, "templateSavedGroup")}>
              {catalog.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.icon ? `${template.icon} ` : ""}
                  {template.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button
          type="button"
          className="noema-template-insert focus-ring u-interactive"
          disabled={status === "pending" || missing || loadingMissing || issues.length > 0}
          onClick={() => void insert()}
        >
          {status === "pending" ? t(locale, "saving") : t(locale, "insertWord")}
        </button>
        <button
          type="button"
          aria-label={t(locale, "templateRemoveAria")}
          className="noema-template-remove focus-ring u-interactive"
          onClick={() => deleteNode()}
        >
          ×
        </button>
        {status === "error" ? (
          <span role="alert" className="text-xs text-danger">
            {errorMessage ?? t(locale, "templateLoadFailed")}
          </span>
        ) : null}
        {status === "success" ? (
          <span role="status" className="text-xs text-muted">
            {t(locale, "buttonRunSuccess")}
          </span>
        ) : null}
        {catalog.status === "error" ? (
          <span role="status" className="text-xs text-muted">
            {t(locale, "templateLoadFailed")}
          </span>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}

/* ---------------------------------------------------------------------------
   Button block view
   --------------------------------------------------------------------------- */

function defaultActionFor(
  kind: ButtonBlockAction["kind"],
  firstTemplateId: string,
): ButtonBlockAction {
  switch (kind) {
    case "open_url":
      return { kind: "open_url", url: "" };
    case "insert_template":
      return { kind: "insert_template", templateId: firstTemplateId };
    case "set_property":
      return { kind: "set_property", propertyId: "", value: "" };
    case "notify":
      return { kind: "notify", message: "", level: "info" };
  }
}

function buttonKindLabel(locale: string, kind: ButtonBlockAction["kind"]): string {
  switch (kind) {
    case "open_url":
      return t(locale, "buttonKindOpenUrl");
    case "insert_template":
      return t(locale, "buttonKindInsertTemplate");
    case "set_property":
      return t(locale, "buttonKindSetProperty");
    case "notify":
      return t(locale, "buttonKindNotify");
  }
}

function buttonVariant(style: ButtonBlockStyle): "primary" | "secondary" | "danger" {
  return style === "primary" ? "primary" : style === "danger" ? "danger" : "secondary";
}

function ButtonBlockView({
  node,
  editor,
  getPos,
  deleteNode,
  locale,
  workspaceId,
  pageId,
}: NodeViewProps & {
  locale: string;
  workspaceId?: string;
  pageId?: string;
}) {
  const catalog = useTemplateCatalog(workspaceId);
  const attrs = node.attrs as Record<string, unknown>;
  // Old/imported atoms may predate the id attribute. The engine requires one,
  // so the view normalizes a stable fallback without rewriting the document.
  const normalizedAttrs = useMemo(
    () => ({
      ...attrs,
      id:
        typeof attrs.id === "string" && attrs.id !== ""
          ? attrs.id
          : `button-${String(attrs.label ?? "block")}`,
    }),
    [attrs],
  );
  const block = buttonBlockFromAttrs(normalizedAttrs);
  const label = typeof attrs.label === "string" ? attrs.label : "";
  const style: ButtonBlockStyle =
    typeof attrs.style === "string" &&
    (BUTTON_BLOCK_STYLES as readonly string[]).includes(attrs.style)
      ? (attrs.style as ButtonBlockStyle)
      : "default";
  const [editing, setEditing] = useState(block === null);
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const confirmArmed = useRef(false);

  const savedSources = useMemo(
    () => catalog.templates.map((template) => savedTemplateSource(template)),
    [catalog.templates],
  );
  const allSources = useMemo(
    () => [...builtinTemplateSources(), ...savedSources],
    [savedSources],
  );

  const action =
    parseButtonAction(attrs.action) ??
    defaultActionFor("open_url", allSources[0]?.id ?? "meeting");

  const updateAttrs = useCallback(
    (patch: Record<string, unknown>) => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      editor
        .chain()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
          return true;
        })
        .run();
      setStatus("idle");
      setErrorMessage(null);
    },
    [editor, getPos, node.attrs],
  );

  const updateAction = (next: ButtonBlockAction) => updateAttrs({ action: next });

  const plan = block
    ? planButtonNodeClick(normalizedAttrs, {
        templates: allSources,
        now: new Date().toISOString(),
      })
    : null;
  const executability = plan
    ? buttonPlanExecutability(plan)
    : { executable: false, reason: t(locale, "configureButtonFirst") };

  const run = useCallback(async () => {
    if (!block) {
      toast.error(t(locale, "configureButtonFirst"));
      return;
    }
    const current = planButtonNodeClick(normalizedAttrs, {
      templates: allSources,
      now: new Date().toISOString(),
    });
    if (!current) {
      toast.error(t(locale, "configureButtonFirst"));
      return;
    }
    const available = buttonPlanExecutability(current);
    if (!available.executable) {
      toast.error(available.reason ?? t(locale, "buttonRunFailed"));
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

    switch (current.kind) {
      case "openUrl": {
        setStatus("success");
        setErrorMessage(null);
        if (typeof window === "undefined") return;
        if (current.openInNewTab) {
          window.open(current.href, "_blank", "noopener,noreferrer");
        } else {
          window.location.assign(current.href);
        }
        return;
      }

      case "insertTemplate": {
        if (!workspaceId || !pageId) {
          const message = t(locale, "buttonRunFailed");
          setStatus("error");
          setErrorMessage(message);
          toast.error(message);
          return;
        }
        setStatus("pending");
        setErrorMessage(null);
        try {
          const outcome = await safeAction(() =>
            executeButtonBlockAction({
              workspaceId,
              pageId,
              action: block.action,
            }),
          );
          if (!outcome.ok) throw new Error(outcome.error);
          const result = outcome.value;
          if ("error" in result) throw new Error(result.error);
          if (result.kind !== "insert_template") {
            throw new Error(t(locale, "buttonRunFailed"));
          }
          const source = templateSourceFromBlocks(result.templateId, result.blocks);
          const insertPlan = resolveTemplateInsert(source, {
            now: new Date().toISOString(),
          });
          const content = templateInsertContent(
            {
              kind: "insertTemplate",
              blockId: block.id,
              label: block.label,
              confirm: block.confirm === true,
              templateId: result.templateId,
              insert: insertPlan,
            },
            result.blocks,
          );
          if (!content) throw new Error(t(locale, "buttonRunFailed"));
          editor.chain().focus().insertContentAt(pos + node.nodeSize, content).run();
          setStatus("success");
          toast.success(t(locale, "buttonRunSuccess"));
        } catch (error) {
          const message = error instanceof Error ? error.message : t(locale, "buttonRunFailed");
          setStatus("error");
          setErrorMessage(message);
          toast.error(message);
        }
        return;
      }

      case "setProperty": {
        if (!workspaceId || !pageId) {
          const message = t(locale, "buttonRunFailed");
          setStatus("error");
          setErrorMessage(message);
          toast.error(message);
          return;
        }
        setStatus("pending");
        setErrorMessage(null);
        try {
          const outcome = await safeAction(() =>
            executeButtonBlockAction({
              workspaceId,
              pageId,
              action: block.action,
            }),
          );
          if (!outcome.ok) throw new Error(outcome.error);
          if ("error" in outcome.value) throw new Error(outcome.value.error);
          setStatus("success");
          toast.success(t(locale, "buttonRunSuccess"));
        } catch (error) {
          const message = error instanceof Error ? error.message : t(locale, "buttonRunFailed");
          setStatus("error");
          setErrorMessage(message);
          toast.error(message);
        }
        return;
      }

      case "notify":
      case "invalid":
        setStatus("error");
        setErrorMessage(available.reason ?? t(locale, "buttonRunFailed"));
        toast.error(available.reason ?? t(locale, "buttonRunFailed"));
        return;
    }
  }, [allSources, block, editor, getPos, locale, node.nodeSize, normalizedAttrs, pageId, workspaceId]);

  const statusText =
    status === "pending"
      ? t(locale, "saving")
      : status === "success"
        ? t(locale, "buttonRunSuccess")
        : status === "error"
          ? (errorMessage ?? t(locale, "buttonRunFailed"))
          : !executability.executable
            ? executability.reason
            : null;

  return (
    <NodeViewWrapper className="noema-button-block" data-button-block="">
      <div className="noema-button-card flex flex-col gap-1" contentEditable={false}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={buttonVariant(style)}
            loading={status === "pending"}
            disabled={!executability.executable || status === "pending"}
            onClick={() => void run()}
            leftIcon={<Play className="h-3.5 w-3.5" />}
            title={executability.reason}
          >
            {label || t(locale, "blockButton")}
          </Button>
          <button
            type="button"
            aria-label={t(locale, "configureButton")}
            aria-expanded={editing}
            className="focus-ring u-interactive rounded-control border border-border p-1.5 text-muted hover:bg-surface-2"
            onClick={() => setEditing((open) => !open)}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t(locale, "remove")}
            className="focus-ring u-interactive rounded-control border border-border p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
            onClick={() => deleteNode()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {editing ? (
          <div
            role="group"
            aria-label={t(locale, "configureButton")}
            className="mt-1 grid max-w-xl gap-2 rounded-control border border-border bg-surface p-2 text-xs"
          >
            <label className="grid gap-1">
              <span className="text-muted">{t(locale, "buttonLabelAria")}</span>
              <input
                type="text"
                value={label}
                placeholder={t(locale, "blockButton")}
                className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                onChange={(event) => updateAttrs({ label: event.target.value })}
              />
            </label>

            <label className="grid gap-1">
              <span className="text-muted">{t(locale, "buttonStyleAria")}</span>
              <select
                value={style}
                className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                onChange={(event) =>
                  updateAttrs({ style: event.target.value as ButtonBlockStyle })
                }
              >
                <option value="default">{t(locale, "buttonStyleDefault")}</option>
                <option value="primary">{t(locale, "buttonStylePrimary")}</option>
                <option value="danger">{t(locale, "buttonStyleDanger")}</option>
              </select>
            </label>

            <label className="grid gap-1">
              <span className="text-muted">{t(locale, "buttonActionAria")}</span>
              <select
                value={action.kind}
                className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                onChange={(event) =>
                  updateAction(
                    defaultActionFor(
                      event.target.value as ButtonBlockAction["kind"],
                      allSources[0]?.id ?? "meeting",
                    ),
                  )
                }
              >
                {BUTTON_BLOCK_ACTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {buttonKindLabel(locale, kind)}
                  </option>
                ))}
              </select>
            </label>

            {action.kind === "open_url" ? (
              <>
                <label className="grid gap-1">
                  <span className="text-muted">{t(locale, "buttonUrlAria")}</span>
                  <input
                    type="url"
                    value={action.url}
                    placeholder={t(locale, "buttonUrlPlaceholder")}
                    className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                    onChange={(event) =>
                      updateAction({ ...action, url: event.target.value })
                    }
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={action.openInNewTab !== false}
                    onChange={(event) =>
                      updateAction({ ...action, openInNewTab: event.target.checked })
                    }
                  />
                  <span>{t(locale, "buttonOpenInNewTab")}</span>
                </label>
              </>
            ) : null}

            {action.kind === "insert_template" ? (
              <label className="grid gap-1">
                <span className="text-muted">{t(locale, "buttonTemplateIdAria")}</span>
                <select
                  value={action.templateId}
                  className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                  onChange={(event) =>
                    updateAction({ kind: "insert_template", templateId: event.target.value })
                  }
                >
                  {allSources.some((source) => source.id === action.templateId) ? null : (
                    <option value={action.templateId}>{action.templateId}</option>
                  )}
                  <optgroup label={t(locale, "templateBuiltinGroup")}>
                    {TEMPLATES.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
                    ))}
                  </optgroup>
                  {catalog.templates.length > 0 ? (
                    <optgroup label={t(locale, "templateSavedGroup")}>
                      {catalog.templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
            ) : null}

            {action.kind === "set_property" ? (
              <>
                <label className="grid gap-1">
                  <span className="text-muted">{t(locale, "buttonPropertyIdAria")}</span>
                  <input
                    type="text"
                    value={action.propertyId}
                    className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                    onChange={(event) =>
                      updateAction({ ...action, propertyId: event.target.value })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted">{t(locale, "buttonValueAria")}</span>
                  <textarea
                    key={`${block?.id ?? "new"}:${action.propertyId}`}
                    defaultValue={
                      typeof action.value === "string"
                        ? action.value
                        : JSON.stringify(action.value ?? "")
                    }
                    className="min-h-16 rounded-control border border-border bg-bg px-2 py-1 font-mono text-xs text-fg"
                    onBlur={(event) => {
                      const raw = event.target.value;
                      let next: unknown = raw;
                      if (raw.trim() !== "") {
                        try {
                          next = JSON.parse(raw);
                        } catch {
                          next = raw;
                        }
                      } else {
                        next = "";
                      }
                      if (next !== action.value) updateAction({ ...action, value: next });
                    }}
                  />
                </label>
                <p role="note" className="text-muted">
                  {t(locale, "buttonSetPropertyHint")}
                </p>
              </>
            ) : null}

            {action.kind === "notify" ? (
              <>
                <label className="grid gap-1">
                  <span className="text-muted">{t(locale, "buttonMessageAria")}</span>
                  <input
                    type="text"
                    value={action.message}
                    className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                    onChange={(event) =>
                      updateAction({ ...action, message: event.target.value })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted">{t(locale, "buttonLevelAria")}</span>
                  <select
                    value={action.level ?? "info"}
                    className="rounded-control border border-border bg-bg px-2 py-1 text-sm text-fg"
                    onChange={(event) =>
                      updateAction({
                        ...action,
                        level: event.target.value as "info" | "success" | "warning",
                      })
                    }
                  >
                    <option value="info">info</option>
                    <option value="success">success</option>
                    <option value="warning">warning</option>
                  </select>
                </label>
                <p role="note" className="text-danger">
                  {t(locale, "buttonNotifyUnsupported")}
                </p>
              </>
            ) : null}

            <div className="flex justify-end">
              <Button type="button" size="sm" variant="subtle" onClick={() => setEditing(false)}>
                {t(locale, "done")}
              </Button>
            </div>
          </div>
        ) : null}

        {statusText ? (
          <p
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
            className={cn("text-xs", status === "error" ? "text-danger" : "text-muted")}
          >
            {statusText}
          </p>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
