/**
 * Row buttons — the pure model behind the **Button block** (docs/MISSING_FEATURES.md
 * §1) and the database **Button property** (§3 "Buttons in databases"), spec
 * R89.26 with execution owned by the automations layer (docs/specs/automations.md
 * R27.x).
 *
 * Nothing here performs a side effect: `validateButton` turns a stored/rough
 * config into a list of field-level issues, and `resolveButtonAction` turns the
 * same config plus one row into a declarative **action plan** a renderer can
 * execute (open a link, stage a property write, insert a template, raise a
 * notification). URLs pass through the shared `sanitizeHref` allowlist, so the
 * `javascript:`/`data:`/`vbscript:` class of stored-XSS payloads (audit H2) can
 * never reach a plan.
 */

import { sanitizeHref } from "@/lib/validation";

/** The four action kinds a button may run. */
export type ButtonActionKind = "open_url" | "set_property" | "insert_template" | "notify";

/** Severity a `notify` action raises. */
export type ButtonNotifyLevel = "info" | "success" | "warning";

/** Every level a `notify` action accepts, in display order. */
export const BUTTON_NOTIFY_LEVELS = ["info", "success", "warning"] as const;

export type OpenUrlAction = {
  kind: "open_url";
  url: string;
  /** Defaults to `true` at resolve time. */
  openInNewTab?: boolean;
};

export type SetPropertyAction = {
  kind: "set_property";
  /** Target property; the write shape is owned by the database layer. */
  propertyId: string;
  value: unknown;
};

export type InsertTemplateAction = {
  kind: "insert_template";
  templateId: string;
};

export type NotifyAction = {
  kind: "notify";
  message: string;
  /** Defaults to `"info"`. */
  level?: ButtonNotifyLevel;
};

/** A button's declarative action; discriminated on `kind`. */
export type ButtonAction =
  | OpenUrlAction
  | SetPropertyAction
  | InsertTemplateAction
  | NotifyAction;

/** A configured button. `icon` is optional decoration only. */
export type ButtonConfig = {
  id: string;
  label: string;
  icon?: string;
  action: ButtonAction;
};

/** One field of an action kind, as advertised to a config editor. */
export type ButtonActionFieldSpec = {
  name: string;
  required: boolean;
  description: string;
};

/** Catalogue entry describing an action kind and its editable fields. */
export type ButtonActionSpec = {
  kind: ButtonActionKind;
  label: string;
  description: string;
  fields: readonly ButtonActionFieldSpec[];
  requiredFields: readonly string[];
};

/**
 * The allowed action kinds with their required fields. This is the single
 * source of truth the validator reads, so a new kind is a one-line addition
 * here plus its plan branch in `resolveButtonAction`.
 */
export const BUTTON_ACTION_CATALOG: readonly ButtonActionSpec[] = [
  {
    kind: "open_url",
    label: "Open URL",
    description: "Open a link in a new browser tab.",
    fields: [
      { name: "url", required: true, description: "An http(s) link or same-app path." },
      {
        name: "openInNewTab",
        required: false,
        description: "Open in a new tab instead of navigating away.",
      },
    ],
    requiredFields: ["url"],
  },
  {
    kind: "set_property",
    label: "Set property",
    description: "Write a value into the row's property.",
    fields: [
      { name: "propertyId", required: true, description: "The property to write." },
      { name: "value", required: true, description: "The value to store." },
    ],
    requiredFields: ["propertyId", "value"],
  },
  {
    kind: "insert_template",
    label: "Insert template",
    description: "Insert a saved template into the row.",
    fields: [
      { name: "templateId", required: true, description: "The template to insert." },
    ],
    requiredFields: ["templateId"],
  },
  {
    kind: "notify",
    label: "Notify",
    description: "Raise a notification for the workspace.",
    fields: [
      { name: "message", required: true, description: "The notification body." },
      { name: "level", required: false, description: "info, success or warning." },
    ],
    requiredFields: ["message"],
  },
] as const;

/** The known action kinds, in catalogue order. */
export const BUTTON_ACTION_KINDS: readonly ButtonActionKind[] = BUTTON_ACTION_CATALOG.map(
  (spec) => spec.kind,
);

/** Look up an action-kind spec; `undefined` for an unknown kind. */
export function buttonActionSpec(kind: string): ButtonActionSpec | undefined {
  return BUTTON_ACTION_CATALOG.find((spec) => spec.kind === kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a URL is safe to hand to a plan. Delegates to the shared
 * `sanitizeHref` allowlist (http/https/mailto/tel plus safe relative paths);
 * anything else — `javascript:`, `data:`, `vbscript:`, and their whitespace /
 * encoding tricks — is refused.
 */
export function isSafeButtonUrl(url: unknown): boolean {
  return sanitizeHref(url) !== null;
}

export type ButtonIssueCode =
  | "not_an_object"
  | "missing_field"
  | "wrong_type"
  | "unknown_kind"
  | "unsafe_url";

/** A single validation problem, addressable by `path` in a config editor. */
export type ButtonIssue = {
  path: string;
  code: ButtonIssueCode;
  message: string;
};

function missing(path: string, field: string): ButtonIssue {
  return { path, code: "missing_field", message: `"${field}" is required.` };
}

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

/**
 * Validate a button config (typically straight from stored JSON) and return
 * every issue found. An empty array means the config is well-formed. Never
 * throws: a non-object collapses to a single `not_an_object` issue.
 */
export function validateButton(config: unknown): ButtonIssue[] {
  const issues: ButtonIssue[] = [];
  if (!isRecord(config)) {
    return [{ path: "", code: "not_an_object", message: "A button config must be an object." }];
  }

  if (isBlank(config.id)) issues.push(missing("id", "id"));
  if (isBlank(config.label)) issues.push(missing("label", "label"));
  if (config.icon !== undefined && typeof config.icon !== "string") {
    issues.push({ path: "icon", code: "wrong_type", message: `"icon" must be a string.` });
  }

  if (!isRecord(config.action)) {
    issues.push(missing("action", "action"));
    return issues;
  }
  const action = config.action;
  if (typeof action.kind !== "string") {
    issues.push(missing("action.kind", "kind"));
    return issues;
  }
  const spec = buttonActionSpec(action.kind);
  if (!spec) {
    issues.push({
      path: "action.kind",
      code: "unknown_kind",
      message: `"${action.kind}" is not a supported action kind.`,
    });
    return issues;
  }

  for (const field of spec.requiredFields) {
    if (isBlank(action[field])) issues.push(missing(`action.${field}`, field));
  }

  if (
    spec.kind === "open_url" &&
    typeof action.url === "string" &&
    action.url.trim() !== "" &&
    !isSafeButtonUrl(action.url)
  ) {
    issues.push({
      path: "action.url",
      code: "unsafe_url",
      message: "The URL is not a safe http(s) link.",
    });
  }

  if (
    spec.kind === "notify" &&
    action.level !== undefined &&
    !(BUTTON_NOTIFY_LEVELS as readonly unknown[]).includes(action.level)
  ) {
    issues.push({
      path: "action.level",
      code: "wrong_type",
      message: `"level" must be one of ${BUTTON_NOTIFY_LEVELS.join(", ")}.`,
    });
  }

  return issues;
}

/** Convenience: whether a config passes every validation rule. */
export function isValidButton(config: unknown): boolean {
  return validateButton(config).length === 0;
}

/** The row a button is clicked on. `values` maps property id → stored value. */
export type ButtonRow = {
  id: string;
  title?: string;
  values?: Record<string, unknown>;
};

/** Ambient data available to interpolation, kept deterministic for tests. */
export type ButtonContext = {
  /** Replaces/extends the row scope; merged last so callers can override. */
  variables?: Record<string, string>;
  /** Optional ISO timestamp a UI may stamp on the plan. */
  now?: string;
};

function coerceScopeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

/**
 * The `{{token}}` scope for a row: `id`, `title`, every primitive property
 * value, then the caller's variables (highest priority). Non-primitive values
 * are omitted rather than stringified, so an object never leaks `[object Object]`.
 */
export function buttonScope(
  row: ButtonRow,
  context: ButtonContext = {},
): Record<string, string> {
  const scope: Record<string, string> = { id: row.id };
  if (row.title !== undefined) scope.title = row.title;
  for (const [key, value] of Object.entries(row.values ?? {})) {
    const coerced = coerceScopeValue(value);
    if (coerced !== undefined) scope[key] = coerced;
  }
  return { ...scope, ...(context.variables ?? {}) };
}

/**
 * Replace `{{key}}` tokens using `scope`, leaving an unknown token verbatim so
 * a half-configured label is visible rather than silently blanked.
 */
export function interpolateButtonText(
  template: string,
  scope: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(scope, key) ? scope[key] : match,
  );
}

type PlanCommon = {
  buttonId: string;
  label: string;
  enabled: boolean;
  /** Present iff `enabled` is false. */
  disabledReason?: string;
};

/** A plan to open a URL; `href` is null only on an invalid plan branch. */
export type OpenUrlPlan = PlanCommon & {
  kind: "open_url";
  href: string;
  openInNewTab: boolean;
};

/** A plan to write a property value on the clicked row. */
export type SetPropertyPlan = PlanCommon & {
  kind: "set_property";
  rowId: string;
  propertyId: string;
  value: unknown;
};

/** A plan to insert a template into the clicked row. */
export type InsertTemplatePlan = PlanCommon & {
  kind: "insert_template";
  rowId: string;
  templateId: string;
};

/** A plan to raise a notification. */
export type NotifyPlan = PlanCommon & {
  kind: "notify";
  message: string;
  level: ButtonNotifyLevel;
};

/** An invalid config: never executable, carries the full issue list. */
export type InvalidPlan = PlanCommon & {
  kind: "invalid";
  issues: ButtonIssue[];
};

/**
 * A declarative, side-effect-free description of what clicking a button would
 * do. A renderer switches on `kind`; an `invalid` plan is always disabled.
 */
export type ButtonActionPlan =
  | OpenUrlPlan
  | SetPropertyPlan
  | InsertTemplatePlan
  | NotifyPlan
  | InvalidPlan;

/**
 * Resolve a button config against one row into an action plan. Never throws:
 * an invalid config yields an `invalid`, disabled plan carrying every issue.
 * Text fields (`open_url.url`, `notify.message`, string `set_property.value`)
 * are interpolated against `buttonScope(row, context)`.
 */
export function resolveButtonAction(
  config: unknown,
  row: ButtonRow,
  context: ButtonContext = {},
): ButtonActionPlan {
  const record = isRecord(config) ? config : {};
  const buttonId = typeof record.id === "string" ? record.id : "";
  const label = typeof record.label === "string" ? record.label : "";
  const scope = buttonScope(row, context);

  const issues = validateButton(config);
  if (issues.length > 0) {
    return {
      kind: "invalid",
      buttonId,
      label,
      enabled: false,
      disabledReason: issues[0].message,
      issues,
    };
  }

  const action = (record.action as ButtonAction);
  const common: PlanCommon = { buttonId, label, enabled: true };

  switch (action.kind) {
    case "open_url":
      return {
        ...common,
        kind: "open_url",
        href: interpolateButtonText(action.url, scope),
        openInNewTab: action.openInNewTab ?? true,
      };
    case "set_property":
      return {
        ...common,
        kind: "set_property",
        rowId: row.id,
        propertyId: action.propertyId,
        value:
          typeof action.value === "string"
            ? interpolateButtonText(action.value, scope)
            : action.value,
      };
    case "insert_template":
      return {
        ...common,
        kind: "insert_template",
        rowId: row.id,
        templateId: action.templateId,
      };
    case "notify":
      return {
        ...common,
        kind: "notify",
        message: interpolateButtonText(action.message, scope),
        level: action.level ?? "info",
      };
  }
}
