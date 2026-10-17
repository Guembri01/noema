/**
 * Automation rule engine — the **pure** model behind trigger → condition →
 * action rules (docs/specs/automations.md §13 Automation engine / Database
 * automations / Button actions / Zapier connectors-via-webhooks, §20
 * Automations).
 *
 * A workspace authors an `AutomationRule`: a `Trigger`, an optional AND/OR
 * nested `Conditions` tree, and an ordered list of `Action`s. Nothing here
 * performs I/O or touches the clock:
 *
 * - `parseAutomation` normalizes and validates a stored/rough rule.
 * - `validateAutomation` returns field-level issues (unknown trigger/action,
 *   empty actions, self-referential `setProp`, oversize condition trees).
 * - `matchesTrigger` decides whether an event is in scope.
 * - `evaluateConditions` is a bounded, whitelisted DSL evaluator over one row.
 * - `runAutomation` turns a matched rule plus one event into a declarative list
 *   of `ActionEffect`s, guarded against cycles by a caller-threaded depth cap
 *   and visited-rule set.
 * - `describeAutomation` renders a rule for a list/detail UI.
 *
 * The modules are additive: the pre-existing `src/lib/automations.ts` owns the
 * ticket-event vocabulary and the `src/lib/cron-schedule.ts` owns cron parsing;
 * this engine reuses the latter for schedule triggers and accepts the former's
 * shape without changing it.
 */

import { describeCron, isValidCron, matchesCron } from "@/lib/cron-schedule";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The four trigger types a rule may bind to. */
export const TRIGGER_TYPES = ["row.created", "row.updated", "prop.changed", "schedule"] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** The four action types a rule may run. */
export const ACTION_TYPES = ["setProp", "notify", "createRow", "webhook"] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The whitelisted condition operators. No user code, no regex: a value is read
 * from the row by `propertyId` and compared with one of these. An operator that
 * is not in this list fails closed.
 */
export const CONDITION_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
  "notExists",
  "isEmpty",
  "notEmpty",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Severity a `notify` action carries. */
export type NotifyLevel = "info" | "success" | "warning";

/** HTTP verb a `webhook` action uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Bounded list lengths (spec R27.5 / R27.11). */
export const MAX_ACTIONS = 5;
export const MAX_CONDITION_DEPTH = 3;
export const MAX_CONDITION_LEAVES = 8;
/** Chain budget: a direct rule runs at depth 0, one chained rule at depth 1. */
export const DEFAULT_MAX_DEPTH = 2;

const NOTIFY_LEVELS: readonly NotifyLevel[] = ["info", "success", "warning"];
const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Operators whose `value` is required for the comparison to mean anything. */
const VALUE_OPS: readonly ConditionOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rule's trigger: a row lifecycle event, a property change, or a schedule. */
export type Trigger = {
  type: TriggerType;
  /** `prop.changed`: which property; omitted means "any property". */
  propertyId?: string;
  /** `schedule`: a 5-field cron expression; omitted means "every tick". */
  cron?: string;
};

/** A single condition predicate read from one row property. */
export type Condition = {
  propertyId: string;
  op: ConditionOp;
  value?: unknown;
};

/** An AND/OR/NOT group; every declared branch must pass (implicit AND). */
export type ConditionGroup = {
  all?: readonly ConditionNode[];
  any?: readonly ConditionNode[];
  none?: readonly ConditionNode[];
};

export type ConditionNode = Condition | ConditionGroup;

/** A rule's condition tree; `null`/absent means "always run". */
export type Conditions = ConditionNode | readonly ConditionNode[] | null | undefined;

export type SetPropAction = { type: "setProp"; propertyId: string; value: unknown };
export type NotifyAction = {
  type: "notify";
  message: string;
  level?: NotifyLevel;
  targets?: readonly string[];
};
export type CreateRowAction = {
  type: "createRow";
  values?: Record<string, unknown>;
  title?: string;
};
export type WebhookAction = {
  type: "webhook";
  url: string;
  method?: HttpMethod;
  body?: unknown;
};

/** A rule's ordered action; discriminated on `type`. */
export type Action = SetPropAction | NotifyAction | CreateRowAction | WebhookAction;

/** A workspace-scoped automation rule. `enabled` defaults to `true`. */
export type AutomationRule = {
  id: string;
  name?: string;
  enabled?: boolean;
  trigger: Trigger;
  conditions?: Conditions;
  actions: readonly Action[];
};

/** One row an action reads from / acts on. Property values live under `values`. */
export type AutomationRow = {
  id?: string;
  values?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The canonical event handed to `matchesTrigger` / `runAutomation`. */
export type AutomationEvent = {
  type: TriggerType;
  rowId?: string;
  /** `prop.changed`: the property that changed. */
  propertyId?: string;
  /** `schedule`: when the tick fired (Date or ISO string). */
  at?: Date | string;
  /** `prop.changed`: value before the change. */
  from?: unknown;
  /** `prop.changed`: value after the change. */
  to?: unknown;
};

export type AutomationIssueCode =
  | "not_an_object"
  | "missing_field"
  | "wrong_type"
  | "unknown_trigger"
  | "unknown_action"
  | "invalid_cron"
  | "no_actions"
  | "too_many_actions"
  | "self_reference"
  | "invalid_condition"
  | "too_deep"
  | "too_many_leaves";

/** One validation problem, addressable by `path` in a rule editor. */
export type AutomationIssue = {
  path: string;
  code: AutomationIssueCode;
  message: string;
};

/** The result of `parseAutomation`: a normalized rule, or the blocking issues. */
export type AutomationParse =
  | { ok: true; rule: AutomationRule; issues: [] }
  | { ok: false; rule: null; issues: AutomationIssue[] };

/** Why a matched rule did not produce effects. */
export type RunSkipReason =
  | "invalid"
  | "disabled"
  | "trigger"
  | "conditions"
  | "visited"
  | "max_depth"
  | "no_op";

export type SetPropEffect = {
  type: "setProp";
  propertyId: string;
  value: unknown;
  rowId: string | null;
};
export type NotifyEffect = {
  type: "notify";
  message: string;
  level: NotifyLevel;
  targets: string[];
};
export type CreateRowEffect = { type: "createRow"; values: Record<string, unknown> };
export type WebhookEffect = {
  type: "webhook";
  url: string;
  method: HttpMethod;
  body: unknown;
};

/** A resolved, side-effect-free action step a dispatcher may execute. */
export type ActionEffect = SetPropEffect | NotifyEffect | CreateRowEffect | WebhookEffect;

type RunBase = {
  ruleId: string;
  /** Chain depth this rule was evaluated at (0 for a direct event). */
  depth: number;
  /** Rule ids seen so far, including this rule once planned. */
  visited: string[];
};

/** A runnable plan: every action resolved in order. */
export type PlannedRun = RunBase & {
  status: "planned";
  runnable: true;
  effects: ActionEffect[];
};

/** A rule that matched but must not run (disabled, no-op or loop guard). */
export type SkippedRun = RunBase & {
  status: "skipped";
  runnable: false;
  reason: RunSkipReason;
  message: string;
  effects: [];
};

export type AutomationRunResult = PlannedRun | SkippedRun;

/** Ambient data available while planning. Deterministic: no clock, no I/O. */
export type AutomationRunContext = {
  row?: AutomationRow;
  /** Chain depth of the event being handled; defaults to 0. */
  depth?: number;
  /** Rule ids already run in this chain; defaults to empty. */
  visited?: readonly string[];
  /** Override the chain budget; defaults to `DEFAULT_MAX_DEPTH`. */
  maxDepth?: number;
  /** Extra interpolation tokens, overriding row values. */
  variables?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Guards & small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const asTriggerType = (value: unknown): TriggerType | null =>
  typeof value === "string" && (TRIGGER_TYPES as readonly string[]).includes(value)
    ? (value as TriggerType)
    : null;

const asActionType = (value: unknown): ActionType | null =>
  typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value)
    ? (value as ActionType)
    : null;

const asConditionOp = (value: unknown): ConditionOp | null =>
  typeof value === "string" && (CONDITION_OPS as readonly string[]).includes(value)
    ? (value as ConditionOp)
    : null;

const asNotifyLevel = (value: unknown): NotifyLevel | null =>
  typeof value === "string" && (NOTIFY_LEVELS as readonly string[]).includes(value)
    ? (value as NotifyLevel)
    : null;

const asHttpMethod = (value: unknown): HttpMethod | null =>
  typeof value === "string" && (HTTP_METHODS as readonly string[]).includes(value)
    ? (value as HttpMethod)
    : null;

/** Value equality that also compares arrays and dates by content. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  return false;
}

/** Read a property, preferring `row.values` and falling back to the row itself. */
function readProperty(row: AutomationRow | null | undefined, propertyId: string): unknown {
  if (!isRecord(row)) return undefined;
  const values = isRecord(row.values) ? row.values : undefined;
  if (values && propertyId in values) return values[propertyId];
  return propertyId in row ? row[propertyId] : undefined;
}

/** Loose, total comparison for the ordering operators. */
function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return null;
}

const isValueEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
};

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
  if (Array.isArray(haystack)) return haystack.some((item) => valuesEqual(item, needle));
  return false;
}

function inList(current: unknown, list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  if (Array.isArray(current)) {
    return current.some((item) => list.some((candidate) => valuesEqual(item, candidate)));
  }
  return list.some((candidate) => valuesEqual(current, candidate));
}

function interpolate(text: string, scope: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = scope[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function scopeFor(row: AutomationRow | null | undefined, variables?: Record<string, string>): Record<string, unknown> {
  // The scope is built from **user data** (the row's `values`, the
  // automation's variables). `Object.assign` **sets** the `__proto__` key of
  // its source object — so a `__proto__` in that data would change the
  // **prototype** of this object, and every lookup would then find the
  // injected members. With a prototype-less object, `__proto__` is an ordinary
  // key like any other.
  const scope: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (isRecord(row)) {
    if (isRecord(row.values)) Object.assign(scope, row.values);
    for (const [key, value] of Object.entries(row)) {
      if (key !== "values") scope[key] = value;
    }
  }
  if (variables) Object.assign(scope, variables);
  return scope;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function missing(path: string, field: string): AutomationIssue {
  return { path, code: "missing_field", message: `"${field}" is required.` };
}

function validateTrigger(trigger: unknown): AutomationIssue[] {
  if (!isRecord(trigger)) return [missing("trigger", "trigger")];
  if (isBlank(trigger.type)) return [missing("trigger.type", "type")];
  const type = asTriggerType(trigger.type);
  if (type === null) {
    return [
      {
        path: "trigger.type",
        code: "unknown_trigger",
        message: `"${String(trigger.type)}" is not a supported trigger.`,
      },
    ];
  }
  const issues: AutomationIssue[] = [];
  if (trigger.propertyId !== undefined && typeof trigger.propertyId !== "string") {
    issues.push({ path: "trigger.propertyId", code: "wrong_type", message: '"propertyId" must be a string.' });
  }
  if (trigger.cron !== undefined) {
    if (typeof trigger.cron !== "string") {
      issues.push({ path: "trigger.cron", code: "wrong_type", message: '"cron" must be a string.' });
    } else if (!isValidCron(trigger.cron)) {
      issues.push({
        path: "trigger.cron",
        code: "invalid_cron",
        message: `"${trigger.cron}" is not a valid cron expression.`,
      });
    }
  }
  return issues;
}

function validateConditionNode(
  node: unknown,
  path: string,
  depth: number,
  counter: { leaves: number },
): AutomationIssue[] {
  if (!isRecord(node)) {
    return [{ path, code: "invalid_condition", message: "A condition must be an object." }];
  }

  // A leaf carries a propertyId; a group carries all/any/none.
  if ("propertyId" in node || "op" in node) {
    counter.leaves += 1;
    const issues: AutomationIssue[] = [];
    if (isBlank(node.propertyId)) issues.push(missing(`${path}.propertyId`, "propertyId"));
    const op = asConditionOp(node.op);
    if (isBlank(node.op)) {
      issues.push(missing(`${path}.op`, "op"));
    } else if (op === null) {
      issues.push({
        path: `${path}.op`,
        code: "invalid_condition",
        message: `"${String(node.op)}" is not a supported condition operator.`,
      });
    } else if (VALUE_OPS.includes(op) && !("value" in node)) {
      issues.push(missing(`${path}.value`, "value"));
    }
    return issues;
  }

  const branches = (["all", "any", "none"] as const).filter((key) => key in node);
  if (branches.length === 0) {
    return [
      {
        path,
        code: "invalid_condition",
        message: "A condition group must define `all`, `any` or `none`.",
      },
    ];
  }
  if (depth + 1 > MAX_CONDITION_DEPTH) {
    return [
      {
        path,
        code: "too_deep",
        message: `Conditions may nest at most ${MAX_CONDITION_DEPTH} levels.`,
      },
    ];
  }
  const issues: AutomationIssue[] = [];
  for (const key of branches) {
    const children = node[key];
    if (!Array.isArray(children)) {
      issues.push({
        path: `${path}.${key}`,
        code: "invalid_condition",
        message: `"${key}" must be an array of conditions.`,
      });
      continue;
    }
    children.forEach((child, index) => {
      issues.push(...validateConditionNode(child, `${path}.${key}.${index}`, depth + 1, counter));
    });
  }
  return issues;
}

function validateAction(action: unknown, index: number): AutomationIssue[] {
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
        message: `"${String(action.type)}" is not a supported action.`,
      },
    ];
  }

  const issues: AutomationIssue[] = [];
  if (type === "setProp") {
    if (isBlank(action.propertyId)) issues.push(missing(`${path}.propertyId`, "propertyId"));
    if (!("value" in action)) issues.push(missing(`${path}.value`, "value"));
  } else if (type === "notify") {
    if (isBlank(action.message)) issues.push(missing(`${path}.message`, "message"));
    if (action.level !== undefined && asNotifyLevel(action.level) === null) {
      issues.push({
        path: `${path}.level`,
        code: "unknown_action",
        message: `"${String(action.level)}" is not a supported notify level.`,
      });
    }
  } else if (type === "createRow") {
    if (action.values !== undefined && !isRecord(action.values)) {
      issues.push({ path: `${path}.values`, code: "wrong_type", message: '"values" must be an object.' });
    }
  } else if (type === "webhook") {
    if (isBlank(action.url)) issues.push(missing(`${path}.url`, "url"));
    if (action.method !== undefined && asHttpMethod(action.method) === null) {
      issues.push({
        path: `${path}.method`,
        code: "unknown_action",
        message: `"${String(action.method)}" is not a supported HTTP method.`,
      });
    }
  }
  return issues;
}

/**
 * Validate a rule (typically straight from stored JSON) and return every issue
 * found. An empty array means the rule is well-formed. Never throws: a
 * non-object collapses to a single `not_an_object` issue.
 */
export function validateAutomation(rule: unknown): AutomationIssue[] {
  if (!isRecord(rule)) {
    return [{ path: "", code: "not_an_object", message: "An automation must be an object." }];
  }

  const issues: AutomationIssue[] = [];
  if (isBlank(rule.id)) issues.push(missing("id", "id"));
  if (rule.name !== undefined && typeof rule.name !== "string") {
    issues.push({ path: "name", code: "wrong_type", message: '"name" must be a string.' });
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    issues.push({ path: "enabled", code: "wrong_type", message: '"enabled" must be a boolean.' });
  }

  issues.push(...validateTrigger(rule.trigger));

  if (rule.conditions !== undefined && rule.conditions !== null) {
    const counter = { leaves: 0 };
    if (Array.isArray(rule.conditions)) {
      rule.conditions.forEach((node, index) => {
        issues.push(...validateConditionNode(node, `conditions.${index}`, 0, counter));
      });
    } else {
      issues.push(...validateConditionNode(rule.conditions, "conditions", 0, counter));
    }
    if (counter.leaves > MAX_CONDITION_LEAVES) {
      issues.push({
        path: "conditions",
        code: "too_many_leaves",
        message: `Conditions may define at most ${MAX_CONDITION_LEAVES} predicates.`,
      });
    }
  }

  if (!Array.isArray(rule.actions)) {
    issues.push(missing("actions", "actions"));
  } else if (rule.actions.length === 0) {
    issues.push({
      path: "actions",
      code: "no_actions",
      message: "A rule must define at least one action.",
    });
  } else {
    if (rule.actions.length > MAX_ACTIONS) {
      issues.push({
        path: "actions",
        code: "too_many_actions",
        message: `A rule may define at most ${MAX_ACTIONS} actions.`,
      });
    }
    rule.actions.forEach((action, index) => {
      issues.push(...validateAction(action, index));
    });
  }

  // Self-reference guard: a rule triggered by a property change must not set
  // that same property — that is an unconditional loop.
  const trigger = rule.trigger;
  if (
    isRecord(trigger) &&
    trigger.type === "prop.changed" &&
    typeof trigger.propertyId === "string" &&
    trigger.propertyId.trim() !== "" &&
    Array.isArray(rule.actions)
  ) {
    const propertyId = trigger.propertyId;
    rule.actions.forEach((action, index) => {
      if (isRecord(action) && action.type === "setProp" && action.propertyId === propertyId) {
        issues.push({
          path: `actions.${index}.propertyId`,
          code: "self_reference",
          message: `A rule triggered by "${propertyId}" cannot set "${propertyId}".`,
        });
      }
    });
  }

  return issues;
}

/** Convenience: whether a rule passes every validation rule. */
export function isValidAutomation(rule: unknown): boolean {
  return validateAutomation(rule).length === 0;
}

/**
 * Normalize and validate a raw automation. On success the returned rule has
 * stable defaults (`enabled: true`, `conditions: null`); on failure the rule is
 * `null` and every blocking issue is returned. Never throws.
 */
export function parseAutomation(raw: unknown): AutomationParse {
  const issues = validateAutomation(raw);
  if (issues.length > 0 || !isRecord(raw)) {
    return { ok: false, rule: null, issues };
  }
  const rule: AutomationRule = {
    id: raw.id as string,
    name: typeof raw.name === "string" ? raw.name : undefined,
    enabled: raw.enabled !== false,
    trigger: raw.trigger as Trigger,
    conditions: (raw.conditions ?? null) as Conditions,
    actions: raw.actions as readonly Action[],
  };
  return { ok: true, rule, issues: [] };
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

function parseEventDate(at: unknown): Date | null {
  if (at instanceof Date) return Number.isFinite(at.getTime()) ? at : null;
  if (typeof at === "string") {
    const parsed = new Date(at);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

/**
 * Whether a rule's trigger is in scope for an event. Fails closed: a malformed
 * rule or event never matches, an unknown trigger type never matches, and a
 * `prop.changed` event with no actual change (`from` equals `to`, or neither is
 * supplied) never matches — the no-op guard.
 */
export function matchesTrigger(rule: unknown, event: unknown): boolean {
  if (!isRecord(rule) || !isRecord(event)) return false;
  if (!isRecord(rule.trigger)) return false;
  const type = asTriggerType(rule.trigger.type);
  if (type === null || event.type !== type) return false;

  if (type === "prop.changed") {
    const propertyId = rule.trigger.propertyId;
    if (
      typeof propertyId === "string" &&
      propertyId.trim() !== "" &&
      event.propertyId !== propertyId
    ) {
      return false;
    }
    if (valuesEqual(event.from, event.to)) return false;
    return true;
  }

  if (type === "schedule") {
    const cron = rule.trigger.cron;
    if (cron === undefined) return true;
    if (typeof cron !== "string") return false;
    const date = parseEventDate(event.at);
    return date !== null && matchesCron(cron, date);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Condition DSL
// ---------------------------------------------------------------------------

function evaluateLeaf(condition: Condition, row: AutomationRow | null | undefined): boolean {
  const op = asConditionOp(condition.op);
  if (op === null) return false;
  const current = readProperty(row, condition.propertyId);
  const value = condition.value;

  switch (op) {
    case "eq":
      return valuesEqual(current, value);
    case "neq":
      return !valuesEqual(current, value);
    case "gt": {
      const cmp = compareValues(current, value);
      return cmp !== null && cmp > 0;
    }
    case "gte": {
      const cmp = compareValues(current, value);
      return cmp !== null && cmp >= 0;
    }
    case "lt": {
      const cmp = compareValues(current, value);
      return cmp !== null && cmp < 0;
    }
    case "lte": {
      const cmp = compareValues(current, value);
      return cmp !== null && cmp <= 0;
    }
    case "in":
      return inList(current, value);
    case "notIn":
      return !inList(current, value);
    case "contains":
      return containsValue(current, value);
    case "startsWith":
      return typeof current === "string" && typeof value === "string" && current.startsWith(value);
    case "endsWith":
      return typeof current === "string" && typeof value === "string" && current.endsWith(value);
    case "exists":
      return current !== undefined && current !== null;
    case "notExists":
      return current === undefined || current === null;
    case "isEmpty":
      return isValueEmpty(current);
    case "notEmpty":
      return !isValueEmpty(current);
    default:
      return false;
  }
}

function evaluateNode(node: unknown, row: AutomationRow | null | undefined): boolean {
  if (!isRecord(node)) return false;

  if ("propertyId" in node || "op" in node) {
    const propertyId = node.propertyId;
    if (typeof propertyId !== "string" || propertyId.trim() === "") return false;
    return evaluateLeaf(node as Condition, row);
  }

  const branches = (["all", "any", "none"] as const).filter((key) => key in node);
  if (branches.length === 0) return false;

  let result = true;
  for (const key of branches) {
    const children = node[key];
    if (!Array.isArray(children)) return false;
    if (key === "all") {
      result = result && children.every((child) => evaluateNode(child, row));
    } else if (key === "any") {
      result = result && children.some((child) => evaluateNode(child, row));
    } else {
      result = result && children.every((child) => !evaluateNode(child, row));
    }
  }
  return result;
}

/**
 * Evaluate a condition tree against one row. `null`/absent conditions are
 * always-true; an array is an implicit `all`. Fails closed: an unknown operator
 * or malformed node is `false`, never a throw. Pure and deterministic.
 */
export function evaluateConditions(
  conditions: Conditions,
  row: AutomationRow | null | undefined,
): boolean {
  if (conditions === null || conditions === undefined) return true;
  if (Array.isArray(conditions)) return conditions.every((node) => evaluateNode(node, row));
  return evaluateNode(conditions, row);
}

// ---------------------------------------------------------------------------
// Action planning
// ---------------------------------------------------------------------------

function planSetProp(
  action: SetPropAction,
  row: AutomationRow | null | undefined,
): SetPropEffect | null {
  const rowId = isRecord(row) && typeof row.id === "string" ? row.id : null;
  // No-op guard: setting a property to the value it already holds is dropped.
  if (isRecord(row) && valuesEqual(readProperty(row, action.propertyId), action.value)) {
    return null;
  }
  return { type: "setProp", propertyId: action.propertyId, value: action.value, rowId };
}

function planNotify(action: NotifyAction, scope: Record<string, unknown>): NotifyEffect {
  return {
    type: "notify",
    message: interpolate(action.message, scope),
    level: asNotifyLevel(action.level) ?? "info",
    targets: Array.isArray(action.targets) ? action.targets.filter((t): t is string => typeof t === "string") : [],
  };
}

function planCreateRow(action: CreateRowAction, scope: Record<string, unknown>): CreateRowEffect {
  const values: Record<string, unknown> = isRecord(action.values) ? { ...action.values } : {};
  if (typeof action.title === "string" && !("title" in values)) {
    values.title = interpolate(action.title, scope);
  }
  return { type: "createRow", values };
}

function planWebhook(action: WebhookAction, scope: Record<string, unknown>): WebhookEffect {
  const body = typeof action.body === "string" ? interpolate(action.body, scope) : action.body ?? null;
  return {
    type: "webhook",
    url: action.url,
    method: asHttpMethod(action.method) ?? "POST",
    body,
  };
}

function planEffects(
  actions: readonly Action[],
  row: AutomationRow | null | undefined,
  scope: Record<string, unknown>,
): ActionEffect[] {
  const effects: ActionEffect[] = [];
  for (const action of actions) {
    if (!isRecord(action)) continue;
    switch (action.type) {
      case "setProp": {
        const effect = planSetProp(action as SetPropAction, row);
        if (effect) effects.push(effect);
        break;
      }
      case "notify":
        effects.push(planNotify(action as NotifyAction, scope));
        break;
      case "createRow":
        effects.push(planCreateRow(action as CreateRowAction, scope));
        break;
      case "webhook":
        effects.push(planWebhook(action as WebhookAction, scope));
        break;
      default:
        break;
    }
  }
  return effects;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const normalizeDepth = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const normalizeMaxDepth = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_MAX_DEPTH;

const normalizeVisited = (visited: readonly string[] | undefined): string[] =>
  Array.isArray(visited) ? [...new Set(visited.filter((id) => typeof id === "string"))] : [];

function skip(base: RunBase, reason: RunSkipReason, message: string): SkippedRun {
  return { ...base, status: "skipped", runnable: false, reason, message, effects: [] };
}

/**
 * Turn a rule plus one event into a declarative list of action effects. Never
 * throws and never performs a side effect.
 *
 * Precedence: an invalid rule, a disabled rule, a non-matching trigger, then
 * the loop guard (a rule already in `visited`, or a chain at `depth >=
 * maxDepth`), then the conditions, then the no-op guard. On success every
 * action is resolved in order and the returned `visited` includes this rule so
 * a dispatcher can thread it into the next call.
 */
export function runAutomation(
  rule: unknown,
  event: unknown,
  context: AutomationRunContext = {},
): AutomationRunResult {
  const record = isRecord(rule) ? rule : {};
  const ruleId = typeof record.id === "string" ? record.id : "";
  const depth = normalizeDepth(context.depth);
  const maxDepth = normalizeMaxDepth(context.maxDepth);
  const visited = normalizeVisited(context.visited);
  const base: RunBase = { ruleId, depth, visited };

  if (validateAutomation(rule).length > 0) {
    return skip(base, "invalid", "The rule is not valid.");
  }

  const ruleRecord = record as unknown as AutomationRule;

  if (ruleRecord.enabled === false) {
    return skip(base, "disabled", "The rule is disabled.");
  }

  if (!matchesTrigger(ruleRecord, event)) {
    return skip(base, "trigger", "The event does not match the rule's trigger.");
  }

  if (visited.includes(ruleId)) {
    return skip(base, "visited", "The rule already ran in this chain.");
  }

  if (depth >= maxDepth) {
    return skip(base, "max_depth", `The chain reached its maximum depth of ${maxDepth}.`);
  }

  if (!evaluateConditions(ruleRecord.conditions, context.row)) {
    return skip(base, "conditions", "The rule's conditions did not pass.");
  }

  const scope = scopeFor(context.row, context.variables);
  const effects = planEffects(ruleRecord.actions, context.row, scope);
  if (effects.length === 0) {
    return skip(base, "no_op", "Every action was a no-op.");
  }

  return { ...base, status: "planned", runnable: true, effects, visited: [...visited, ruleId] };
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

function describeTrigger(trigger: Trigger): string {
  switch (trigger.type) {
    case "row.created":
      return "When a row is created";
    case "row.updated":
      return "When a row is updated";
    case "prop.changed":
      return typeof trigger.propertyId === "string" && trigger.propertyId.trim() !== ""
        ? `When property "${trigger.propertyId}" changes`
        : "When any property changes";
    case "schedule": {
      if (typeof trigger.cron === "string" && isValidCron(trigger.cron)) {
        return `On a schedule (${describeCron(trigger.cron)})`;
      }
      return "On a schedule";
    }
    default:
      return "When triggered";
  }
}

function describeConditionNode(node: ConditionNode): string {
  if ("propertyId" in node || "op" in node) {
    const leaf = node as Condition;
    const value = "value" in leaf ? ` ${displayValue(leaf.value)}` : "";
    return `${leaf.propertyId} ${leaf.op}${value}`;
  }
  const group = node as ConditionGroup;
  const parts: string[] = [];
  if (Array.isArray(group.all)) parts.push(`all of [${group.all.map(describeConditionNode).join(", ")}]`);
  if (Array.isArray(group.any)) parts.push(`any of [${group.any.map(describeConditionNode).join(", ")}]`);
  if (Array.isArray(group.none)) parts.push(`none of [${group.none.map(describeConditionNode).join(", ")}]`);
  return parts.join(" and ");
}

function describeConditions(conditions: Conditions): string {
  if (conditions === null || conditions === undefined) return "";
  if (Array.isArray(conditions)) {
    return (conditions as readonly ConditionNode[]).map((node) => describeConditionNode(node)).join(" and ");
  }
  return describeConditionNode(conditions as ConditionNode);
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "setProp":
      return `set "${action.propertyId}" to ${displayValue(action.value)}`;
    case "notify":
      return `notify "${action.message}"`;
    case "createRow":
      return action.title ? `create a row titled "${action.title}"` : "create a row";
    case "webhook":
      return `call ${action.method ?? "POST"} ${action.url}`;
    default:
      return "do something";
  }
}

/**
 * A short human summary of a rule, e.g. `When property "status" changes where
 * priority eq "High", then notify "ping"`. Malformed input yields a stable
 * "Invalid automation." string rather than throwing.
 */
export function describeAutomation(rule: unknown): string {
  if (validateAutomation(rule).length > 0) return "Invalid automation.";
  const record = rule as AutomationRule;
  const parts: string[] = [describeTrigger(record.trigger)];
  const conditions = describeConditions(record.conditions);
  if (conditions !== "") parts.push(`where ${conditions}`);
  parts.push(`then ${record.actions.map(describeAction).join(", then ")}`);
  return parts.join(", ");
}
