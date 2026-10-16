/**
 * Database Button property engine (§4 Button property — "Trigger actions from
 * a row").
 *
 * This is the *database* counterpart to the Button block model in
 * `src/lib/row-buttons.ts`. A `ButtonPropertyConfig` holds an ordered list of
 * `ButtonAction`s plus two presentation flags, and the helpers here are all
 * pure: nothing reads the clock or performs I/O.
 *
 * - `parseButtonConfig` normalizes a stored/rough config and applies defaults.
 * - `validateButtonConfig` returns field-level issues (unknown action, missing
 *   args, unsafe URL, unknown property/template/member, empty list).
 * - `planRowButton` turns a config plus one row into an ordered, side-effect
 *   free `{ kind, payload }` plan a dispatcher can execute.
 * - `canRun` gates destructive actions behind an `editor`-or-above role.
 * - `describeButtonConfig` renders a one-line summary for a list/detail UI.
 * - `dryRun` reports the expected `set_property` before/after changes.
 *
 * The action *ids* are imported from `row-buttons.ts` so the two models share
 * one vocabulary; this module only adds the three database-only kinds
 * (`duplicate_row`, `delete_row`, `webhook`). URLs pass the shared
 * `sanitizeHref` allowlist, then this engine narrows it further to `http`/
 * `https` for anything a button would fetch.
 */

import {
  BUTTON_ACTION_KINDS,
  BUTTON_NOTIFY_LEVELS,
  buttonScope,
  interpolateButtonText,
  isSafeButtonUrl,
} from "@/lib/row-buttons";
import type { ButtonActionKind, ButtonNotifyLevel, ButtonRow } from "@/lib/row-buttons";

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** The database-only action kinds, added on top of the row-button vocabulary. */
export const BUTTON_PROPERTY_EXTRA_ACTION_TYPES = [
  "duplicate_row",
  "delete_row",
  "webhook",
] as const;

/** Every action kind a Button property may run, in catalogue order. */
export type ButtonActionType =
  | ButtonActionKind
  | (typeof BUTTON_PROPERTY_EXTRA_ACTION_TYPES)[number];

/**
 * The known action kinds, in order. The first four reuse the row-button
 * vocabulary by import, so the two models cannot drift.
 */
export const BUTTON_PROPERTY_ACTION_TYPES: readonly ButtonActionType[] = [
  ...BUTTON_ACTION_KINDS,
  ...BUTTON_PROPERTY_EXTRA_ACTION_TYPES,
];

/** Actions that remove data; every other kind is additive or reversible. */
export const DESTRUCTIVE_ACTION_TYPES: readonly ButtonActionType[] = ["delete_row"];

/** HTTP verb a `webhook` action uses. */
export const BUTTON_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ButtonHttpMethod = (typeof BUTTON_HTTP_METHODS)[number];

/** Roles a caller may hold, ordered from least to most privileged. */
export const BUTTON_ROLES = ["viewer", "commenter", "editor", "owner"] as const;
export type ButtonRole = (typeof BUTTON_ROLES)[number];

/** Rank for the `editor+` gate; anything at or above `editor` may be destructive. */
const ROLE_RANK: Record<ButtonRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

/** A bounded action list keeps a single button from becoming a script. */
export const MAX_BUTTON_ACTIONS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenUrlAction = {
  type: "open_url";
  url: string;
  /** Defaults to `true` at plan time. */
  openInNewTab?: boolean;
};

export type SetPropertyAction = {
  type: "set_property";
  /** Target property; the write shape is owned by the database layer. */
  propertyId: string;
  value: unknown;
};

export type InsertTemplateAction = {
  type: "insert_template";
  templateId: string;
};

export type NotifyAction = {
  type: "notify";
  message: string;
  /** Defaults to `"info"`. */
  level?: ButtonNotifyLevel;
  /** Explicit recipients; each must exist when a member catalog is supplied. */
  memberIds?: readonly string[];
};

export type DuplicateRowAction = { type: "duplicate_row" };

export type DeleteRowAction = { type: "delete_row" };

export type WebhookAction = {
  type: "webhook";
  url: string;
  /** Defaults to `"POST"`. */
  method?: ButtonHttpMethod;
  /** A string body is interpolated against the row scope. */
  body?: unknown;
};

/** A Button property's declarative action; discriminated on `type`. */
export type ButtonAction =
  | OpenUrlAction
  | SetPropertyAction
  | InsertTemplateAction
  | NotifyAction
  | DuplicateRowAction
  | DeleteRowAction
  | WebhookAction;

/** A configured Button property. */
export type ButtonPropertyConfig = {
  actions: readonly ButtonAction[];
  /** Render the button's label inside the cell; defaults to `true`. */
  showLabelInCell?: boolean;
  /** Ask for confirmation before running; defaults to `false`. */
  confirmRequired?: boolean;
};

/** A property a `set_property` action may target. */
export type PropertyRef = { id: string; name?: string };

/** A template an `insert_template` action may reference. */
export type TemplateRef = { id: string; name?: string };

/** A member a `notify` action may address. */
export type MemberRef = { id: string; name?: string };

/**
 * Reference catalogs used to resolve property/template/member ids. A catalog
 * that is not supplied simply skips that lookup (shape validation still runs).
 */
export type ButtonConfigContext = {
  properties?: readonly PropertyRef[];
  templates?: readonly TemplateRef[];
  members?: readonly MemberRef[];
};

export type ButtonPropertyIssueCode =
  | "not_an_object"
  | "missing_field"
  | "wrong_type"
  | "unknown_action"
  | "unsafe_url"
  | "no_actions"
  | "too_many_actions"
  | "unknown_property"
  | "unknown_template"
  | "unknown_member";

/** A single validation problem, addressable by `path` in a config editor. */
export type ButtonPropertyIssue = {
  path: string;
  code: ButtonPropertyIssueCode;
  message: string;
};

/** The result of `parseButtonConfig`: a normalized config, or the issues. */
export type ButtonConfigParse =
  | { ok: true; config: ButtonPropertyConfig; issues: [] }
  | { ok: false; config: null; issues: ButtonPropertyIssue[] };

// ---------------------------------------------------------------------------
// Guards & small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const asActionType = (value: unknown): ButtonActionType | null =>
  typeof value === "string" && (BUTTON_PROPERTY_ACTION_TYPES as readonly string[]).includes(value)
    ? (value as ButtonActionType)
    : null;

const asNotifyLevel = (value: unknown): ButtonNotifyLevel | null =>
  typeof value === "string" && (BUTTON_NOTIFY_LEVELS as readonly string[]).includes(value)
    ? (value as ButtonNotifyLevel)
    : null;

const asHttpMethod = (value: unknown): ButtonHttpMethod | null =>
  typeof value === "string" && (BUTTON_HTTP_METHODS as readonly string[]).includes(value)
    ? (value as ButtonHttpMethod)
    : null;

/**
 * Whether a URL may be fetched by a button. Delegates to the shared
 * `sanitizeHref` allowlist, then narrows to an `http`/`https` scheme — the only
 * two this engine will hand to a plan. `mailto:`, `tel:`, relative targets and
 * the whole `javascript:`/`data:` family are refused.
 */
export function isAllowedActionUrl(url: unknown): boolean {
  if (!isSafeButtonUrl(url)) return false;
  return /^https?:\/\//i.test(String(url).trim());
}

function missing(path: string, field: string): ButtonPropertyIssue {
  return { path, code: "missing_field", message: `"${field}" is required.` };
}

function wrongType(path: string, field: string, expected: string): ButtonPropertyIssue {
  return { path, code: "wrong_type", message: `"${field}" must be ${expected}.` };
}

const hasId = <T extends { id: string }>(refs: readonly T[] | undefined, id: string): boolean =>
  refs === undefined || refs.some((ref) => ref.id === id);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAction(
  action: unknown,
  index: number,
  context: ButtonConfigContext,
): ButtonPropertyIssue[] {
  const path = `actions.${index}`;
  if (!isRecord(action)) {
    return [{ path, code: "unknown_action", message: "An action must be an object." }];
  }
  if (isBlank(action.type)) return [missing(`${path}.type`, "type")];
  const type = asActionType(action.type);
  if (type === null) {
    return [
      {
        path: `${path}.type`,
        code: "unknown_action",
        message: `"${String(action.type)}" is not a supported action type.`,
      },
    ];
  }

  const issues: ButtonPropertyIssue[] = [];

  switch (type) {
    case "open_url":
      if (isBlank(action.url)) {
        issues.push(missing(`${path}.url`, "url"));
      } else if (!isAllowedActionUrl(action.url)) {
        issues.push({
          path: `${path}.url`,
          code: "unsafe_url",
          message: "The URL must be an http(s) link.",
        });
      }
      break;

    case "set_property":
      if (isBlank(action.propertyId)) {
        issues.push(missing(`${path}.propertyId`, "propertyId"));
      } else if (!hasId(context.properties, action.propertyId as string)) {
        issues.push({
          path: `${path}.propertyId`,
          code: "unknown_property",
          message: `"${String(action.propertyId)}" is not a known property.`,
        });
      }
      if (!("value" in action)) issues.push(missing(`${path}.value`, "value"));
      break;

    case "insert_template":
      if (isBlank(action.templateId)) {
        issues.push(missing(`${path}.templateId`, "templateId"));
      } else if (!hasId(context.templates, action.templateId as string)) {
        issues.push({
          path: `${path}.templateId`,
          code: "unknown_template",
          message: `"${String(action.templateId)}" is not a known template.`,
        });
      }
      break;

    case "notify": {
      if (isBlank(action.message)) issues.push(missing(`${path}.message`, "message"));
      if (action.level !== undefined && asNotifyLevel(action.level) === null) {
        issues.push(wrongType(`${path}.level`, "level", "one of info, success, warning"));
      }
      if (action.memberIds !== undefined) {
        if (!Array.isArray(action.memberIds)) {
          issues.push(wrongType(`${path}.memberIds`, "memberIds", "an array of ids"));
        } else {
          for (const memberId of action.memberIds) {
            if (typeof memberId !== "string") {
              issues.push(wrongType(`${path}.memberIds`, "memberIds", "an array of ids"));
              break;
            }
            if (!hasId(context.members, memberId)) {
              issues.push({
                path: `${path}.memberIds`,
                code: "unknown_member",
                message: `"${memberId}" is not a known member.`,
              });
            }
          }
        }
      }
      break;
    }

    case "webhook":
      if (isBlank(action.url)) {
        issues.push(missing(`${path}.url`, "url"));
      } else if (!isAllowedActionUrl(action.url)) {
        issues.push({
          path: `${path}.url`,
          code: "unsafe_url",
          message: "The webhook URL must be an http(s) link.",
        });
      }
      if (action.method !== undefined && asHttpMethod(action.method) === null) {
        issues.push(wrongType(`${path}.method`, "method", `one of ${BUTTON_HTTP_METHODS.join(", ")}`));
      }
      break;

    case "duplicate_row":
    case "delete_row":
      break;
  }

  return issues;
}

/**
 * Validate a Button property config (typically straight from stored JSON) and
 * return every issue found. An empty array means the config is well-formed.
 * Never throws: a non-object collapses to a single `not_an_object` issue.
 * Reference catalogs in `context` are optional; when omitted the corresponding
 * property/template/member lookups are skipped, not failed.
 */
export function validateButtonConfig(
  config: unknown,
  context: ButtonConfigContext = {},
): ButtonPropertyIssue[] {
  const issues: ButtonPropertyIssue[] = [];
  if (!isRecord(config)) {
    return [{ path: "", code: "not_an_object", message: "A button config must be an object." }];
  }

  if (config.showLabelInCell !== undefined && typeof config.showLabelInCell !== "boolean") {
    issues.push(wrongType("showLabelInCell", "showLabelInCell", "a boolean"));
  }
  if (config.confirmRequired !== undefined && typeof config.confirmRequired !== "boolean") {
    issues.push(wrongType("confirmRequired", "confirmRequired", "a boolean"));
  }

  if (!Array.isArray(config.actions)) {
    issues.push(missing("actions", "actions"));
  } else if (config.actions.length === 0) {
    issues.push({
      path: "actions",
      code: "no_actions",
      message: "A button must define at least one action.",
    });
  } else {
    if (config.actions.length > MAX_BUTTON_ACTIONS) {
      issues.push({
        path: "actions",
        code: "too_many_actions",
        message: `A button may define at most ${MAX_BUTTON_ACTIONS} actions.`,
      });
    }
    config.actions.forEach((action, index) => {
      issues.push(...validateAction(action, index, context));
    });
  }

  return issues;
}

/** Convenience: whether a config passes every validation rule. */
export function isValidButtonConfig(config: unknown, context: ButtonConfigContext = {}): boolean {
  return validateButtonConfig(config, context).length === 0;
}

/**
 * Normalize and validate a raw config. On success the returned config has
 * stable defaults (`showLabelInCell: true`, `confirmRequired: false`); on
 * failure the config is `null` and every blocking issue is returned. Never
 * throws.
 */
export function parseButtonConfig(
  raw: unknown,
  context: ButtonConfigContext = {},
): ButtonConfigParse {
  const issues = validateButtonConfig(raw, context);
  if (issues.length > 0 || !isRecord(raw)) {
    return { ok: false, config: null, issues };
  }
  const config: ButtonPropertyConfig = {
    actions: (raw.actions as readonly ButtonAction[]).slice(),
    showLabelInCell: raw.showLabelInCell !== false,
    confirmRequired: raw.confirmRequired === true,
  };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// Action planning
// ---------------------------------------------------------------------------

export type OpenUrlStep = {
  kind: "open_url";
  payload: { url: string; openInNewTab: boolean };
};
export type SetPropertyStep = {
  kind: "set_property";
  payload: { rowId: string; propertyId: string; value: unknown };
};
export type InsertTemplateStep = {
  kind: "insert_template";
  payload: { rowId: string; templateId: string };
};
export type NotifyStep = {
  kind: "notify";
  payload: { message: string; level: ButtonNotifyLevel; memberIds: string[] };
};
export type DuplicateRowStep = { kind: "duplicate_row"; payload: { rowId: string } };
export type DeleteRowStep = { kind: "delete_row"; payload: { rowId: string } };
export type WebhookStep = {
  kind: "webhook";
  payload: { url: string; method: ButtonHttpMethod; body: unknown };
};

/** One resolved, side-effect-free step a dispatcher may execute. */
export type ButtonPlanStep =
  | OpenUrlStep
  | SetPropertyStep
  | InsertTemplateStep
  | NotifyStep
  | DuplicateRowStep
  | DeleteRowStep
  | WebhookStep;

/** The ambient data a plan needs. `now` is exposed as an interpolation token. */
export type ButtonPlanContext = {
  row: ButtonRow;
  now?: string;
};

/**
 * Turn a config plus one row into an ordered plan. Never throws and never
 * performs I/O: string fields (`open_url.url`, `webhook.body`, `notify.message`
 * and string `set_property.value`) are interpolated against the row scope, and
 * `now` is offered as a `{{now}}` token. An invalid config yields an empty
 * plan — callers should validate first when they need the issues.
 */
export function planRowButton(config: unknown, { row, now }: ButtonPlanContext): ButtonPlanStep[] {
  if (validateButtonConfig(config).length > 0) return [];
  const record = config as ButtonPropertyConfig;
  const scope = buttonScope(row, now === undefined ? {} : { variables: { now } });
  const steps: ButtonPlanStep[] = [];

  for (const action of record.actions) {
    switch (action.type) {
      case "open_url":
        steps.push({
          kind: "open_url",
          payload: {
            url: interpolateButtonText(action.url, scope),
            openInNewTab: action.openInNewTab !== false,
          },
        });
        break;
      case "set_property":
        steps.push({
          kind: "set_property",
          payload: {
            rowId: row.id,
            propertyId: action.propertyId,
            value:
              typeof action.value === "string"
                ? interpolateButtonText(action.value, scope)
                : action.value,
          },
        });
        break;
      case "insert_template":
        steps.push({
          kind: "insert_template",
          payload: { rowId: row.id, templateId: action.templateId },
        });
        break;
      case "notify":
        steps.push({
          kind: "notify",
          payload: {
            message: interpolateButtonText(action.message, scope),
            level: asNotifyLevel(action.level) ?? "info",
            memberIds: Array.isArray(action.memberIds)
              ? action.memberIds.filter((id): id is string => typeof id === "string")
              : [],
          },
        });
        break;
      case "duplicate_row":
        steps.push({ kind: "duplicate_row", payload: { rowId: row.id } });
        break;
      case "delete_row":
        steps.push({ kind: "delete_row", payload: { rowId: row.id } });
        break;
      case "webhook":
        steps.push({
          kind: "webhook",
          payload: {
            url: action.url,
            method: asHttpMethod(action.method) ?? "POST",
            body:
              typeof action.body === "string"
                ? interpolateButtonText(action.body, scope)
                : action.body ?? null,
          },
        });
        break;
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function hasDestructiveAction(config: unknown): boolean {
  if (!isRecord(config) || !Array.isArray(config.actions)) return false;
  return config.actions.some(
    (action) =>
      isRecord(action) &&
      (DESTRUCTIVE_ACTION_TYPES as readonly string[]).includes(String(action.type)),
  );
}

/**
 * Whether a role may run a config. Fails closed: an invalid config or an
 * unknown role is refused. A config with any destructive action requires
 * `editor` or above; everything else is runnable by any role.
 */
export function canRun(config: unknown, { role }: { role: ButtonRole }): boolean {
  const rank = ROLE_RANK[role];
  if (rank === undefined) return false;
  if (validateButtonConfig(config).length > 0) return false;
  if (!hasDestructiveAction(config)) return true;
  return rank >= ROLE_RANK.editor;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const displayValue = (value: unknown): string => {
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "nothing";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

function describeAction(action: ButtonAction): string {
  switch (action.type) {
    case "open_url":
      return `open ${action.url}`;
    case "set_property":
      return `set "${action.propertyId}" to ${displayValue(action.value)}`;
    case "insert_template":
      return `insert template "${action.templateId}"`;
    case "notify":
      return `notify "${action.message}"`;
    case "duplicate_row":
      return "duplicate the row";
    case "delete_row":
      return "delete the row";
    case "webhook":
      return `call ${action.method ?? "POST"} ${action.url}`;
    default:
      return "do something";
  }
}

/**
 * A short human summary, e.g. `Button on "Status": set "status" to "Done",
 * then notify "Done"`. Malformed input yields a stable "Invalid button."
 * string rather than throwing.
 */
export function describeButtonConfig(
  config: unknown,
  { propertyName }: { propertyName?: string } = {},
): string {
  if (validateButtonConfig(config).length > 0) return "Invalid button.";
  const record = config as ButtonPropertyConfig;
  const head =
    typeof propertyName === "string" && propertyName.trim() !== ""
      ? `Button on "${propertyName}"`
      : "Button";
  return `${head}: ${record.actions.map(describeAction).join(", then ")}`;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** A predicted `set_property` write: what the row holds now and would hold. */
export type DryRunChange = {
  propertyId: string;
  before: unknown;
  after: unknown;
};

/** The predicted outcome of running a config, with no side effects. */
export type DryRunResult = {
  ok: boolean;
  issues: ButtonPropertyIssue[];
  steps: ButtonPlanStep[];
  changes: DryRunChange[];
  destructive: boolean;
};

/**
 * Predict the changes a config would make against one row. `set_property`
 * actions report a `before`/`after` pair; other actions contribute steps but
 * no change entries. Fails closed: an invalid config yields `ok: false`, the
 * issues and no steps.
 */
export function dryRun(config: unknown, { row }: { row: ButtonRow }): DryRunResult {
  const issues = validateButtonConfig(config);
  if (issues.length > 0) {
    return { ok: false, issues, steps: [], changes: [], destructive: false };
  }

  const steps = planRowButton(config, { row });
  const changes: DryRunChange[] = [];
  for (const step of steps) {
    if (step.kind === "set_property") {
      changes.push({
        propertyId: step.payload.propertyId,
        before: row.values?.[step.payload.propertyId],
        after: step.payload.value,
      });
    }
  }

  return {
    ok: true,
    issues: [],
    steps,
    changes,
    destructive: hasDestructiveAction(config),
  };
}
