import { sanitizeHref } from "@/lib/validation";

/**
 * Template button + Button block engine (docs/MISSING_FEATURES.md §1 "Template
 * button block" / "Button block"; §6 "Template button"). This is the pure core
 * behind the editor's template atom and the interactive Button block: strict
 * parsers, a semantic validator, a side-effect-free click planner and a
 * deterministic template-insert resolver.
 *
 * Nothing here performs I/O. `planButtonClick` turns a stored button into a
 * declarative **action plan** a renderer executes (navigate, stage a property
 * patch, resolve a template insert, call a webhook, duplicate source blocks),
 * and `resolveTemplateInsert` mints a fresh block list so two insertions never
 * share ids. Webhook URLs pass through the shared `sanitizeHref` allowlist, so
 * `javascript:`/`data:`/`vbscript:` payloads can never reach a plan.
 */

/* ---------------------------------------------------------------------------
   Shapes
   --------------------------------------------------------------------------- */

/** A standalone "Template button" atom that inserts a template on click. */
export type TemplateButtonBlock = {
  id: string;
  templateId: string;
  label: string;
  icon?: string;
};

/** Every method a `webhook` action may use. */
export const WEBHOOK_METHODS = ["POST", "PUT", "PATCH"] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];
export const DEFAULT_WEBHOOK_METHOD: WebhookMethod = "POST";

export type InsertTemplateButtonAction = {
  type: "insertTemplate";
  templateId: string;
};

export type OpenPageButtonAction = {
  type: "openPage";
  pageId: string;
};

/** A property patch: property id → value to write. */
export type SetPropsButtonAction = {
  type: "setProps";
  props: Record<string, unknown>;
};

export type WebhookButtonAction = {
  type: "webhook";
  url: string;
  method?: WebhookMethod;
  body?: unknown;
};

/** Duplicate the listed source blocks in place. */
export type DuplicateButtonAction = {
  type: "duplicate";
  sourceIds: string[];
};

/** A Button block's declarative action; discriminated on `type`. */
export type ButtonBlockAction =
  | InsertTemplateButtonAction
  | OpenPageButtonAction
  | SetPropsButtonAction
  | WebhookButtonAction
  | DuplicateButtonAction;

export type ButtonBlockActionType = ButtonBlockAction["type"];

/** The known action types, in catalogue order. */
export const BUTTON_BLOCK_ACTIONS: readonly ButtonBlockActionType[] = [
  "insertTemplate",
  "openPage",
  "setProps",
  "webhook",
  "duplicate",
];

/** A configured Button block. `icon`/`confirm` are optional. */
export type ButtonBlock = {
  id: string;
  label: string;
  icon?: string;
  action: ButtonBlockAction;
  /** When true a renderer asks before running the action. */
  confirm?: boolean;
};

/* ---------------------------------------------------------------------------
   Template insert sources
   --------------------------------------------------------------------------- */

/** One block stored in a template, with its source id and positional index. */
export type TemplateBlock = {
  id: string;
  index: number;
  type?: string;
  text?: string;
};

/** A template a button can insert: an id plus its ordered source blocks. */
export type TemplateInsertSource = {
  id: string;
  label?: string;
  blocks: readonly TemplateBlock[];
};

/** One inserted block: a fresh `id`, a shifted `index` and its source id. */
export type InsertedTemplateBlock = {
  id: string;
  index: number;
  sourceId: string;
  type?: string;
  text?: string;
};

/** The result of resolving a template into a fresh, id-minted block list. */
export type TemplateInsertResult = {
  templateId: string;
  insertedAt: string;
  actorId: string;
  blocks: InsertedTemplateBlock[];
};

export type ResolveTemplateInsertOptions = {
  /** ISO timestamp stamped on the insert (for audit/preview). */
  now?: string;
  /** Who triggered the insert (for audit/preview). */
  actorId?: string;
  /** Override the deterministic `${template}-${now}-${actor}-${index}` id. */
  idFactory?: (sourceId: string, index: number) => string;
};

/* ---------------------------------------------------------------------------
   Parsers
   --------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

/** Parse an untrusted value into a `TemplateButtonBlock`, or `null`. */
export function parseTemplateButton(input: unknown): TemplateButtonBlock | null {
  if (!isRecord(input)) return null;
  const id = nonEmptyString(input.id);
  const templateId = nonEmptyString(input.templateId);
  const label = nonEmptyString(input.label);
  const icon = optionalString(input.icon);
  if (id === null || templateId === null || label === null || icon === null) return null;
  return { id, templateId, label, ...(icon === undefined ? {} : { icon }) };
}

/** Parse an untrusted value into a `ButtonBlockAction`, or `null`. */
export function parseButtonAction(input: unknown): ButtonBlockAction | null {
  if (!isRecord(input)) return null;
  switch (input.type) {
    case "insertTemplate": {
      const templateId = nonEmptyString(input.templateId);
      return templateId === null ? null : { type: "insertTemplate", templateId };
    }
    case "openPage": {
      const pageId = nonEmptyString(input.pageId);
      return pageId === null ? null : { type: "openPage", pageId };
    }
    case "setProps": {
      if (!isRecord(input.props)) return null;
      return { type: "setProps", props: { ...input.props } };
    }
    case "webhook": {
      const url = nonEmptyString(input.url);
      if (url === null) return null;
      const method = optionalString(input.method);
      if (method !== undefined && !(WEBHOOK_METHODS as readonly string[]).includes(method ?? "")) {
        return null;
      }
      return {
        type: "webhook",
        url,
        ...(method === undefined ? {} : { method: method as WebhookMethod }),
        ...(input.body === undefined ? {} : { body: input.body }),
      };
    }
    case "duplicate": {
      if (!Array.isArray(input.sourceIds)) return null;
      const sourceIds: string[] = [];
      for (const id of input.sourceIds) {
        const value = nonEmptyString(id);
        if (value === null) return null;
        sourceIds.push(value);
      }
      return { type: "duplicate", sourceIds };
    }
    default:
      return null;
  }
}

/** Parse an untrusted value into a `ButtonBlock`, or `null`. */
export function parseButtonBlock(input: unknown): ButtonBlock | null {
  if (!isRecord(input)) return null;
  const id = nonEmptyString(input.id);
  const label = nonEmptyString(input.label);
  const icon = optionalString(input.icon);
  const confirm = optionalBoolean(input.confirm);
  if (id === null || label === null || icon === null || confirm === null) return null;
  const action = parseButtonAction(input.action);
  if (action === null) return null;
  return {
    id,
    label,
    action,
    ...(icon === undefined ? {} : { icon }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

export type ButtonIssueCode =
  | "not_an_object"
  | "missing_field"
  | "wrong_type"
  | "unknown_action"
  | "unknown_template"
  | "unknown_property"
  | "unsafe_url"
  | "invalid_method";

/** A single semantic problem, addressable by `path` in a config editor. */
export type ButtonIssue = {
  path: string;
  code: ButtonIssueCode;
  message: string;
};

/** A reference to a known template or property: its id, or an `{ id }` object. */
export type KnownRef = string | { id: string };

export type ButtonValidationContext = {
  /** Known template ids; unknown `insertTemplate` ids are flagged when set. */
  templates?: readonly KnownRef[];
  /** Known property ids; unknown `setProps` keys are flagged when set. */
  properties?: readonly KnownRef[];
};

function toIdSet(refs: readonly KnownRef[] | undefined): Set<string> | null {
  if (refs === undefined) return null;
  const ids = new Set<string>();
  for (const ref of refs) {
    if (typeof ref === "string") ids.add(ref);
    else if (isRecord(ref) && typeof ref.id === "string") ids.add(ref.id);
  }
  return ids;
}

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

function missing(path: string, field: string): ButtonIssue {
  return { path, code: "missing_field", message: `"${field}" is required.` };
}

/**
 * Validate a Button block (typically straight from stored JSON) and return
 * every issue found. An empty array means the block is semantically sound.
 * Never throws: a non-object collapses to a single `not_an_object` issue, and
 * membership checks are skipped when the caller omits `templates`/`properties`.
 */
export function validateButtonBlock(
  block: unknown,
  context: ButtonValidationContext = {},
): ButtonIssue[] {
  const issues: ButtonIssue[] = [];
  if (!isRecord(block)) {
    return [{ path: "", code: "not_an_object", message: "A button block must be an object." }];
  }

  if (isBlank(block.id)) issues.push(missing("id", "id"));
  if (isBlank(block.label)) issues.push(missing("label", "label"));
  if (block.icon !== undefined && typeof block.icon !== "string") {
    issues.push({ path: "icon", code: "wrong_type", message: '"icon" must be a string.' });
  }
  if (block.confirm !== undefined && typeof block.confirm !== "boolean") {
    issues.push({ path: "confirm", code: "wrong_type", message: '"confirm" must be a boolean.' });
  }

  if (!isRecord(block.action)) {
    issues.push(missing("action", "action"));
    return issues;
  }
  const action = block.action;
  if (typeof action.type !== "string") {
    issues.push(missing("action.type", "type"));
    return issues;
  }
  if (!(BUTTON_BLOCK_ACTIONS as readonly string[]).includes(action.type)) {
    issues.push({
      path: "action.type",
      code: "unknown_action",
      message: `"${action.type}" is not a supported action type.`,
    });
    return issues;
  }

  const templates = toIdSet(context.templates);
  const properties = toIdSet(context.properties);

  switch (action.type) {
    case "insertTemplate": {
      if (isBlank(action.templateId)) {
        issues.push(missing("action.templateId", "templateId"));
      } else if (templates && !templates.has(String(action.templateId))) {
        issues.push({
          path: "action.templateId",
          code: "unknown_template",
          message: `Template "${String(action.templateId)}" does not exist.`,
        });
      }
      break;
    }
    case "openPage": {
      if (isBlank(action.pageId)) issues.push(missing("action.pageId", "pageId"));
      break;
    }
    case "setProps": {
      if (!isRecord(action.props)) {
        issues.push({ path: "action.props", code: "wrong_type", message: '"props" must be an object.' });
        break;
      }
      const keys = Object.keys(action.props);
      if (keys.length === 0) {
        issues.push({
          path: "action.props",
          code: "missing_field",
          message: '"props" must set at least one property.',
        });
      }
      if (properties) {
        for (const key of keys) {
          if (!properties.has(key)) {
            issues.push({
              path: `action.props.${key}`,
              code: "unknown_property",
              message: `Property "${key}" does not exist.`,
            });
          }
        }
      }
      break;
    }
    case "webhook": {
      if (isBlank(action.url)) {
        issues.push(missing("action.url", "url"));
      } else if (sanitizeHref(action.url) === null) {
        issues.push({
          path: "action.url",
          code: "unsafe_url",
          message: "The webhook URL is not a safe http(s) link.",
        });
      }
      if (
        action.method !== undefined &&
        !(WEBHOOK_METHODS as readonly unknown[]).includes(action.method)
      ) {
        issues.push({
          path: "action.method",
          code: "invalid_method",
          message: `"method" must be one of ${WEBHOOK_METHODS.join(", ")}.`,
        });
      }
      break;
    }
    case "duplicate": {
      if (!Array.isArray(action.sourceIds)) {
        issues.push({
          path: "action.sourceIds",
          code: "wrong_type",
          message: '"sourceIds" must be an array.',
        });
      } else if (action.sourceIds.length === 0) {
        issues.push({
          path: "action.sourceIds",
          code: "missing_field",
          message: '"sourceIds" needs at least one block id.',
        });
      } else if (!action.sourceIds.every((id) => typeof id === "string" && id.trim() !== "")) {
        issues.push({
          path: "action.sourceIds",
          code: "wrong_type",
          message: '"sourceIds" must contain non-empty strings.',
        });
      }
      break;
    }
    default:
      break;
  }

  return issues;
}

/** Convenience: whether a block passes every validation rule. */
export function isValidButtonBlock(
  block: unknown,
  context: ButtonValidationContext = {},
): boolean {
  return validateButtonBlock(block, context).length === 0;
}

/* ---------------------------------------------------------------------------
   Template insert resolver
   --------------------------------------------------------------------------- */

function defaultIdFactory(
  templateId: string,
  now: string,
  actorId: string,
): (sourceId: string, index: number) => string {
  const base = [templateId, now, actorId].filter((part) => part !== "").join("-");
  return (_sourceId: string, index: number) => `${base}-${index}`;
}

/**
 * Resolve a template into a fresh, id-minted block list. Blocks are ordered by
 * their stored `index` (ties keep source order), and their indices are shifted
 * so the first inserted block lands at `0` — a template captured mid-document
 * keeps its internal order without dragging the old offsets along. Ids come
 * from `options.idFactory` or the deterministic
 * `${templateId}-${now}-${actorId}-${index}` default. Never mutates `template`.
 */
export function resolveTemplateInsert(
  template: TemplateInsertSource,
  options: ResolveTemplateInsertOptions = {},
): TemplateInsertResult {
  const now = options.now ?? "";
  const actorId = options.actorId ?? "";
  const makeId = options.idFactory ?? defaultIdFactory(template.id, now, actorId);

  const ordered = template.blocks
    .map((block, position) => ({ block, position }))
    .sort((left, right) =>
      left.block.index === right.block.index
        ? left.position - right.position
        : left.block.index - right.block.index,
    );

  const base = ordered.length > 0 ? ordered[0].block.index : 0;
  const blocks: InsertedTemplateBlock[] = ordered.map(({ block }, index) => ({
    id: makeId(block.id, index),
    index: block.index - base,
    sourceId: block.id,
    ...(block.type === undefined ? {} : { type: block.type }),
    ...(block.text === undefined ? {} : { text: block.text }),
  }));

  return { templateId: template.id, insertedAt: now, actorId, blocks };
}

/* ---------------------------------------------------------------------------
   Click plans
   --------------------------------------------------------------------------- */

type PlanCommon = {
  blockId: string;
  label: string;
  /** Whether a renderer must confirm before executing. */
  confirm: boolean;
};

export type InsertTemplateClickPlan = PlanCommon & {
  kind: "insertTemplate";
  templateId: string;
  insert: TemplateInsertResult;
};

export type OpenPageClickPlan = PlanCommon & {
  kind: "openPage";
  pageId: string;
};

export type SetPropsClickPlan = PlanCommon & {
  kind: "setProps";
  patch: Record<string, unknown>;
};

export type WebhookClickPlan = PlanCommon & {
  kind: "webhook";
  url: string;
  method: WebhookMethod;
  body?: unknown;
};

export type DuplicateClickPlan = PlanCommon & {
  kind: "duplicate";
  sourceIds: string[];
};

/** An invalid block: never executable, carries the full issue list. */
export type InvalidClickPlan = PlanCommon & {
  kind: "invalid";
  issues: ButtonIssue[];
};

/** A declarative, side-effect-free description of what clicking would do. */
export type ButtonClickPlan =
  | InsertTemplateClickPlan
  | OpenPageClickPlan
  | SetPropsClickPlan
  | WebhookClickPlan
  | DuplicateClickPlan
  | InvalidClickPlan;

export type ButtonClickContext = {
  /** Full template sources, used to resolve `insertTemplate`. */
  templates?: readonly TemplateInsertSource[];
  /** Known property ids, used to validate a `setProps` patch. */
  properties?: readonly KnownRef[];
  /** ISO timestamp stamped on an `insertTemplate` plan. */
  now?: string;
  /** Actor stamped on an `insertTemplate` plan. */
  actorId?: string;
};

function findTemplate(
  templates: readonly TemplateInsertSource[] | undefined,
  id: string,
): TemplateInsertSource | undefined {
  return templates?.find((template) => template.id === id);
}

/**
 * Resolve a Button block against its ambient context into an action plan.
 * Never throws: an invalid block yields an `invalid`, disabled plan carrying
 * every issue. `insertTemplate` resolves the template's blocks through
 * {@link resolveTemplateInsert}; `duplicate` returns the source ids untouched;
 * `setProps` returns the property patch.
 */
export function planButtonClick(
  block: ButtonBlock,
  context: ButtonClickContext = {},
): ButtonClickPlan {
  const common: PlanCommon = {
    blockId: block.id,
    label: block.label,
    confirm: block.confirm === true,
  };

  const issues = validateButtonBlock(block, {
    templates: context.templates,
    properties: context.properties,
  });
  if (issues.length > 0) {
    return { ...common, kind: "invalid", issues };
  }

  const action = block.action;
  switch (action.type) {
    case "insertTemplate": {
      const source = findTemplate(context.templates, action.templateId);
      if (source === undefined) {
        return {
          ...common,
          kind: "invalid",
          issues: [
            {
              path: "action.templateId",
              code: "unknown_template",
              message: `Template "${action.templateId}" does not exist.`,
            },
          ],
        };
      }
      return {
        ...common,
        kind: "insertTemplate",
        templateId: action.templateId,
        insert: resolveTemplateInsert(source, {
          now: context.now,
          actorId: context.actorId,
        }),
      };
    }
    case "openPage":
      return { ...common, kind: "openPage", pageId: action.pageId };
    case "setProps":
      return { ...common, kind: "setProps", patch: { ...action.props } };
    case "webhook":
      return {
        ...common,
        kind: "webhook",
        url: action.url,
        method: action.method ?? DEFAULT_WEBHOOK_METHOD,
        ...(action.body === undefined ? {} : { body: action.body }),
      };
    case "duplicate":
      return { ...common, kind: "duplicate", sourceIds: [...action.sourceIds] };
    default:
      return {
        ...common,
        kind: "invalid",
        issues: [
          {
            path: "action.type",
            code: "unknown_action",
            message: "Unknown action type.",
          },
        ],
      };
  }
}

/**
 * Resolve a standalone Template button into an `insertTemplate` plan. A thin
 * adapter so the atom and the Button block share one click semantics.
 */
export function planTemplateButtonClick(
  block: TemplateButtonBlock,
  context: ButtonClickContext = {},
): ButtonClickPlan {
  return planButtonClick(
    {
      id: block.id,
      label: block.label,
      ...(block.icon === undefined ? {} : { icon: block.icon }),
      action: { type: "insertTemplate", templateId: block.templateId },
    },
    context,
  );
}

/* ---------------------------------------------------------------------------
   Descriptions
   --------------------------------------------------------------------------- */

function describeAction(action: ButtonBlockAction): string {
  switch (action.type) {
    case "insertTemplate":
      return `Insert template "${action.templateId}"`;
    case "openPage":
      return `Open page "${action.pageId}"`;
    case "setProps": {
      const count = Object.keys(action.props).length;
      return `Set ${count} ${count === 1 ? "property" : "properties"}`;
    }
    case "webhook": {
      const method = action.method ?? DEFAULT_WEBHOOK_METHOD;
      return `${method} ${action.url}`;
    }
    case "duplicate": {
      const count = action.sourceIds.length;
      return `Duplicate ${count} ${count === 1 ? "block" : "blocks"}`;
    }
  }
}

/** A one-line, human-readable summary of a Template/Button block. */
export function describeButton(block: ButtonBlock | TemplateButtonBlock): string {
  const action: ButtonBlockAction =
    "action" in block ? block.action : { type: "insertTemplate", templateId: block.templateId };
  const base = describeAction(action);
  return "confirm" in block && block.confirm === true ? `${base} (confirm)` : base;
}
