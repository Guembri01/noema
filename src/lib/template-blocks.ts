import {
  BUTTON_ACTION_KINDS,
  BUTTON_NOTIFY_LEVELS,
  isSafeButtonUrl,
  resolveButtonAction,
  validateButton,
  type ButtonAction,
  type ButtonActionKind,
  type ButtonNotifyLevel,
  type ButtonRow,
} from "@/lib/row-buttons";

/**
 * Template button + Button block engine (docs/MISSING_FEATURES.md §1 "Template
 * button block" / "Button block"; docs/specs/templates.md R31.10 and
 * docs/specs/automations.md R27.x).
 *
 * This module is the pure seam between stored node attributes and the shared
 * **Button action** vocabulary in `src/lib/row-buttons.ts` — the same actions
 * automations execute. There is no second action language here: a Button block
 * stores a `ButtonAction`, `validateButtonBlock` delegates to `validateButton`,
 * and `planButtonClick` delegates to `resolveButtonAction`. The only additional
 * job of this module is template resolution: an `insert_template` action is
 * turned into a fresh, id-minted block list via `resolveTemplateInsert`.
 *
 * Nothing here performs I/O, reads the clock, or throws.
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

/** Presentation styles a Button block may use. */
export const BUTTON_BLOCK_STYLES = ["default", "primary", "danger"] as const;
export type ButtonBlockStyle = (typeof BUTTON_BLOCK_STYLES)[number];

/** Every action a Button block may carry, in catalogue order. */
export const BUTTON_BLOCK_ACTIONS: readonly ButtonActionKind[] = BUTTON_ACTION_KINDS;
export type ButtonBlockAction = ButtonAction;
export type ButtonBlockActionType = ButtonActionKind;

/** A configured Button block. `icon`/`confirm`/`style` are optional. */
export type ButtonBlock = {
  id: string;
  label: string;
  icon?: string;
  action: ButtonBlockAction;
  /** When true a renderer asks before running the action. */
  confirm?: boolean;
  /** Visual style; defaults to `"default"`. */
  style?: ButtonBlockStyle;
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

function asNotifyLevel(value: unknown): ButtonNotifyLevel | null {
  return typeof value === "string" &&
    (BUTTON_NOTIFY_LEVELS as readonly string[]).includes(value)
    ? (value as ButtonNotifyLevel)
    : null;
}

function asButtonStyle(value: unknown): ButtonBlockStyle | null {
  return typeof value === "string" &&
    (BUTTON_BLOCK_STYLES as readonly string[]).includes(value)
    ? (value as ButtonBlockStyle)
    : null;
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

/** Parse an untrusted value into the shared `ButtonAction`, or `null`. */
export function parseButtonAction(input: unknown): ButtonBlockAction | null {
  if (!isRecord(input)) return null;
  switch (input.kind) {
    case "open_url": {
      const url = nonEmptyString(input.url);
      if (url === null) return null;
      const openInNewTab = optionalBoolean(input.openInNewTab);
      if (openInNewTab === null) return null;
      return {
        kind: "open_url",
        url,
        ...(openInNewTab === undefined ? {} : { openInNewTab }),
      };
    }
    case "set_property": {
      const propertyId = nonEmptyString(input.propertyId);
      if (propertyId === null || !("value" in input)) return null;
      return { kind: "set_property", propertyId, value: input.value };
    }
    case "insert_template": {
      const templateId = nonEmptyString(input.templateId);
      return templateId === null ? null : { kind: "insert_template", templateId };
    }
    case "notify": {
      const message = nonEmptyString(input.message);
      if (message === null) return null;
      const level = input.level === undefined ? undefined : asNotifyLevel(input.level);
      if (level === null) return null;
      return { kind: "notify", message, ...(level === undefined ? {} : { level }) };
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
  const style = input.style === undefined ? undefined : asButtonStyle(input.style);
  if (id === null || label === null || icon === null || confirm === null || style === null) {
    return null;
  }
  const action = parseButtonAction(input.action);
  if (action === null) return null;
  return {
    id,
    label,
    action,
    ...(icon === undefined ? {} : { icon }),
    ...(confirm === undefined ? {} : { confirm }),
    ...(style === undefined ? {} : { style }),
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
  | "unsafe_url";

/** A single semantic problem, addressable by `path` in a config editor. */
export type ButtonIssue = {
  path: string;
  code: ButtonIssueCode;
  message: string;
};

/** A reference to a known template or property: its id, or an `{ id }` object. */
export type KnownRef = string | { id: string };

export type ButtonValidationContext = {
  /** Known template ids; unknown `insert_template` ids are flagged when set. */
  templates?: readonly KnownRef[];
  /** Known property ids; unknown `set_property` ids are flagged when set. */
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
 * every issue found. Shape validation is delegated to the shared
 * `validateButton` so the block and automations cannot drift; this module only
 * adds the editor-level `style` field and the optional template/property
 * membership checks.
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
  if (block.style !== undefined && asButtonStyle(block.style) === null) {
    issues.push({
      path: "style",
      code: "wrong_type",
      message: `"style" must be one of ${BUTTON_BLOCK_STYLES.join(", ")}.`,
    });
  }

  if (!isRecord(block.action)) {
    issues.push(missing("action", "action"));
    return issues;
  }
  const action = block.action;

  // Shared validator: unknown actions, missing fields and unsafe URLs all come
  // from the automation ButtonAction vocabulary.
  for (const issue of validateButton({ id: "button", label: "Button", action })) {
    if (issue.path === "id" || issue.path === "label") continue;
    issues.push({
      path: issue.path,
      code: issue.code === "unknown_kind" ? "unknown_action" : issue.code,
      message: issue.message,
    });
  }

  const templates = toIdSet(context.templates);
  const properties = toIdSet(context.properties);
  if (action.kind === "insert_template" && typeof action.templateId === "string") {
    if (templates && !templates.has(action.templateId)) {
      issues.push({
        path: "action.templateId",
        code: "unknown_template",
        message: `Template "${action.templateId}" does not exist.`,
      });
    }
  }
  if (action.kind === "set_property" && typeof action.propertyId === "string") {
    if (properties && !properties.has(action.propertyId)) {
      issues.push({
        path: "action.propertyId",
        code: "unknown_property",
        message: `Property "${action.propertyId}" does not exist.`,
      });
    }
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

export type OpenUrlClickPlan = PlanCommon & {
  kind: "openUrl";
  href: string;
  openInNewTab: boolean;
};

export type SetPropertyClickPlan = PlanCommon & {
  kind: "setProperty";
  propertyId: string;
  value: unknown;
};

export type NotifyClickPlan = PlanCommon & {
  kind: "notify";
  message: string;
  level: ButtonNotifyLevel;
};

/** An invalid block: never executable, carries the full issue list. */
export type InvalidClickPlan = PlanCommon & {
  kind: "invalid";
  issues: ButtonIssue[];
};

/** A declarative, side-effect-free description of what clicking would do. */
export type ButtonClickPlan =
  | InsertTemplateClickPlan
  | OpenUrlClickPlan
  | SetPropertyClickPlan
  | NotifyClickPlan
  | InvalidClickPlan;

export type ButtonClickContext = {
  /** Full template sources, used to resolve `insert_template`. */
  templates?: readonly TemplateInsertSource[];
  /** Known property ids, used to validate a `set_property` patch. */
  properties?: readonly KnownRef[];
  /** Interpolation tokens available to `open_url`/`notify` text. */
  variables?: Record<string, string>;
  /** ISO timestamp stamped on an `insert_template` plan. */
  now?: string;
  /** Actor stamped on an `insert_template` plan. */
  actorId?: string;
};

function findTemplate(
  templates: readonly TemplateInsertSource[] | undefined,
  id: string,
): TemplateInsertSource | undefined {
  return templates?.find((template) => template.id === id);
}

function invalid(common: PlanCommon, issues: ButtonIssue[]): InvalidClickPlan {
  return { ...common, kind: "invalid", issues };
}

/**
 * Resolve a Button block against its ambient context into an action plan.
 * Never throws: an invalid block yields an `invalid`, disabled plan carrying
 * every issue. Non-template actions are planned by the shared
 * `resolveButtonAction`; `insert_template` additionally resolves the template
 * into fresh blocks.
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
  if (issues.length > 0) return invalid(common, issues);

  const action = block.action;
  if (action.kind === "insert_template") {
    const source = findTemplate(context.templates, action.templateId);
    if (source === undefined) {
      return invalid(common, [
        {
          path: "action.templateId",
          code: "unknown_template",
          message: `Template "${action.templateId}" does not exist.`,
        },
      ]);
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

  const row: ButtonRow = { id: "" };
  const plan = resolveButtonAction(
    { id: block.id, label: block.label, action },
    row,
    {
      ...(context.variables === undefined ? {} : { variables: context.variables }),
      ...(context.now === undefined ? {} : { now: context.now }),
    },
  );

  switch (plan.kind) {
    case "open_url": {
      // The shared engine validates the authored URL; variables can still be
      // substituted afterwards, so the interpolated href is re-checked rather
      // than trusting a `{{token}}` to stay on the allowlist.
      if (!isSafeButtonUrl(plan.href)) {
        return invalid(common, [
          {
            path: "action.url",
            code: "unsafe_url",
            message: "The URL is not a safe http(s) link.",
          },
        ]);
      }
      return {
        ...common,
        kind: "openUrl",
        href: plan.href,
        openInNewTab: plan.openInNewTab,
      };
    }
    case "set_property":
      return {
        ...common,
        kind: "setProperty",
        propertyId: plan.propertyId,
        value: plan.value,
      };
    case "notify":
      return {
        ...common,
        kind: "notify",
        message: plan.message,
        level: plan.level,
      };
    case "invalid":
      return invalid(
        common,
        plan.issues.map((issue) => ({
          path: issue.path,
          code: issue.code === "unknown_kind" ? "unknown_action" : issue.code,
          message: issue.message,
        })),
      );
    case "insert_template":
      return invalid(common, [
        {
          path: "action.templateId",
          code: "unknown_template",
          message: `Template "${plan.templateId}" does not exist.`,
        },
      ]);
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
      action: { kind: "insert_template", templateId: block.templateId },
    },
    context,
  );
}

/* ---------------------------------------------------------------------------
   Executability
   --------------------------------------------------------------------------- */

/** Why a notification action is disabled in the editor. */
export const BUTTON_NOTIFY_REASON =
  "This block has no recipient list, so notifications are disabled.";

/**
 * Whether a plan can execute from the editor, and (if not) why. `open_url`,
 * `insert_template` and `set_property` are executable; the server re-checks
 * workspace/page permissions and the database context for the latter two.
 * `notify` is explicitly disabled rather than silently no-op: the shared
 * notification vocabulary needs a recipient list the block does not carry.
 */
export function buttonPlanExecutability(
  plan: ButtonClickPlan,
): { executable: boolean; reason?: string } {
  switch (plan.kind) {
    case "openUrl":
    case "insertTemplate":
    case "setProperty":
      return { executable: true };
    case "notify":
      return { executable: false, reason: BUTTON_NOTIFY_REASON };
    case "invalid":
      return {
        executable: false,
        reason: plan.issues.map((issue) => issue.message).join("; ") || "Invalid button.",
      };
  }
}

/* ---------------------------------------------------------------------------
   Descriptions
   --------------------------------------------------------------------------- */

function describeAction(action: ButtonBlockAction): string {
  switch (action.kind) {
    case "open_url":
      return `Open "${action.url}"`;
    case "set_property":
      return `Set property "${action.propertyId}"`;
    case "insert_template":
      return `Insert template "${action.templateId}"`;
    case "notify": {
      const level = action.level ?? "info";
      return `Notify (${level}) "${action.message}"`;
    }
  }
}

/** A one-line, human-readable summary of a Template/Button block. */
export function describeButton(block: ButtonBlock | TemplateButtonBlock): string {
  const action: ButtonBlockAction =
    "action" in block ? block.action : { kind: "insert_template", templateId: block.templateId };
  const base = describeAction(action);
  return "confirm" in block && block.confirm === true ? `${base} (confirm)` : base;
}
