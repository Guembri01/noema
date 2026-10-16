/**
 * Automation engine — the **pure** model behind trigger→action rules
 * (docs/specs/automations.md, requirements R27.1, R27.5-R27.6, R27.11,
 * R27.17). A rule binds a canonical event plus an optional list of filters to
 * an ordered list of actions; the actions themselves are the same declarative
 * `ButtonAction`s as the Button block (`src/lib/row-buttons.ts`, R89.26), so a
 * renderer already knows how to execute them.
 *
 * Nothing here performs a side effect: `matchesTrigger` decides whether an
 * event is in scope, `validateAutomation` turns a stored/rough rule into
 * field-level issues, and `planAutomation` turns a matched rule plus one
 * record into a declarative **action plan**. The plan never executes anything,
 * never touches the clock or the database, and never throws.
 *
 * The loop guard is caller-threaded and explicit: a plan reports the `depth`
 * it ran at and the `visited` rule ids, so a dispatcher chains rules by
 * feeding `depth + 1` and `visited` into the next `planAutomation` call. A rule
 * that comes back around — or a chain that reaches its depth budget — is
 * returned as a `skipped` plan instead of looping (R27.17).
 */

import {
  type ButtonAction,
  type ButtonActionPlan,
  type ButtonRow,
  resolveButtonAction,
  validateButton,
} from "@/lib/row-buttons";

/** The canonical events a trigger may bind to (R27.1). Raw activity kinds never appear here. */
export const AUTOMATION_EVENT_KINDS = [
  "ticket.status_changed",
  "ticket.label_added",
  "ticket.label_removed",
  "ticket.assigned",
  "schedule",
] as const;

export type AutomationEventKind = (typeof AUTOMATION_EVENT_KINDS)[number];

/** The filter operators the trigger DSL accepts. */
export const AUTOMATION_FILTER_OPS = [
  "eq",
  "neq",
  "in",
  "exists",
  "changed_to",
  "changed_from",
] as const;

export type AutomationFilterOp = (typeof AUTOMATION_FILTER_OPS)[number];

/**
 * One trigger predicate, evaluated against an event's `fields` (the values
 * after the change) and `previous` (the values before it). The union keeps the
 * payload honest: `in` carries `values`, equality operators carry `value`, and
 * `exists` carries neither.
 */
export type AutomationFilter =
  | { field: string; op: "eq"; value: unknown }
  | { field: string; op: "neq"; value: unknown }
  | { field: string; op: "in"; values: readonly unknown[] }
  | { field: string; op: "exists" }
  | { field: string; op: "changed_to"; value: unknown }
  | { field: string; op: "changed_from"; value: unknown };

/** A canonical event handed to the engine. */
export type AutomationEvent = {
  kind: AutomationEventKind;
  workspaceId?: string;
  ticketId?: string;
  actorId?: string;
  /** Field values after the change, keyed by field name. */
  fields?: Record<string, unknown>;
  /** Field values before the change, keyed by field name (change filters). */
  previous?: Record<string, unknown>;
};

/** A rule's trigger: one canonical event plus an optional all-must-pass filter list. */
export type AutomationTrigger = {
  event: AutomationEventKind;
  filters?: readonly AutomationFilter[];
};

/** A workspace-scoped automation rule. `enabled` defaults to `true`. */
export type AutomationRule = {
  id: string;
  workspaceId?: string;
  name?: string;
  enabled?: boolean;
  trigger: AutomationTrigger;
  actions: readonly ButtonAction[];
};

/** Ordered actions a rule may run (R27.11). */
export const MAX_AUTOMATION_ACTIONS = 5;
/** Bounded filter list (R27.5): a rule cannot express an unbounded predicate. */
export const MAX_AUTOMATION_FILTERS = 8;
/** Chain budget (R27.17): a direct rule runs at depth 0, one chained rule at depth 1. */
export const MAX_AUTOMATION_DEPTH = 2;

export type AutomationIssueCode =
  | "not_an_object"
  | "missing_field"
  | "wrong_type"
  | "unknown_event"
  | "too_many_actions"
  | "no_actions"
  | "too_many_filters"
  | "invalid_filter"
  | "invalid_action";

/** A single validation problem, addressable by `path` in a rule editor. */
export type AutomationIssue = {
  path: string;
  code: AutomationIssueCode;
  message: string;
};

/** Why a matched rule did not run. */
export type AutomationSkipReason = "disabled" | "visited" | "max_depth";

/** One resolved, side-effect-free step: the row-buttons plan for one action. */
export type AutomationActionStep = {
  index: number;
  plan: ButtonActionPlan;
};

type AutomationPlanBase = {
  ruleId: string;
  /** The trigger's canonical event, or `null` when the rule is malformed. */
  event: AutomationEventKind | null;
  /** Chain depth this rule was evaluated at (0 for a direct event). */
  depth: number;
  /** Rule ids seen so far, including this rule once it is planned. */
  visited: string[];
};

/** A runnable plan: every action resolved in order. */
export type PlannedAutomation = AutomationPlanBase & {
  status: "planned";
  runnable: true;
  steps: AutomationActionStep[];
};

/** A rule that matched but must not run (disabled or loop guard). */
export type SkippedAutomation = AutomationPlanBase & {
  status: "skipped";
  runnable: false;
  reason: AutomationSkipReason;
  message: string;
  steps: [];
};

/** A malformed rule: never executable, carries the full issue list. */
export type InvalidAutomation = AutomationPlanBase & {
  status: "invalid";
  runnable: false;
  issues: AutomationIssue[];
  steps: [];
};

export type AutomationPlan = PlannedAutomation | SkippedAutomation | InvalidAutomation;

/** Ambient data available while planning. Deterministic: no clock, no I/O. */
export type AutomationContext = {
  /** The record an action acts on; supplies the `{{token}}` interpolation scope. */
  row?: ButtonRow;
  variables?: Record<string, string>;
  /** Optional ISO timestamp a UI may stamp on the plan. */
  now?: string;
  /** Chain depth of the event being handled; defaults to 0. */
  depth?: number;
  /** Rule ids already run in this chain; defaults to empty. */
  visited?: readonly string[];
  /** Override the chain budget; defaults to `MAX_AUTOMATION_DEPTH`. */
  maxDepth?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

const asKind = (value: unknown): AutomationEventKind | null =>
  typeof value === "string" && (AUTOMATION_EVENT_KINDS as readonly string[]).includes(value)
    ? (value as AutomationEventKind)
    : null;

/** Value equality that also compares arrays by element (label-id sets). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  return false;
}

/** `in`: any single value matches, or any element of an array field matches. */
function matchesIn(fieldValue: unknown, values: readonly unknown[]): boolean {
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((item) => values.some((candidate) => valuesEqual(item, candidate)));
  }
  return values.some((candidate) => valuesEqual(fieldValue, candidate));
}

/** A missing field reads as an empty object, so filters are total over events. */
function eventScope(event: Record<string, unknown>, key: "fields" | "previous"): Record<string, unknown> {
  return isRecord(event[key]) ? event[key] : {};
}

/**
 * Evaluate one filter against an event. Fails closed: a malformed filter or an
 * unknown operator never matches. `changed_to`/`changed_from` compare only when
 * the field actually changed, so a no-op update cannot fire a rule.
 */
export function matchesFilter(filter: unknown, event: unknown): boolean {
  if (!isRecord(filter) || !isRecord(event)) return false;
  const field = filter.field;
  if (typeof field !== "string" || field.trim() === "") return false;

  const fields = eventScope(event, "fields");
  const previous = eventScope(event, "previous");
  const current = fields[field];
  const before = previous[field];
  const changed = !valuesEqual(before, current);

  switch (filter.op) {
    case "eq":
      return valuesEqual(current, filter.value);
    case "neq":
      return !valuesEqual(current, filter.value);
    case "in":
      return Array.isArray(filter.values) && matchesIn(current, filter.values);
    case "exists":
      return current !== undefined && current !== null;
    case "changed_to":
      return changed && valuesEqual(current, filter.value);
    case "changed_from":
      return changed && valuesEqual(before, filter.value);
    default:
      return false;
  }
}

/**
 * Whether a rule's trigger is in scope for an event: the canonical kind must be
 * known and equal, and every filter must pass. A malformed rule or event — or a
 * non-canonical raw `kind` — never matches.
 */
export function matchesTrigger(rule: unknown, event: unknown): boolean {
  if (!isRecord(rule) || !isRecord(event)) return false;
  if (!isRecord(rule.trigger)) return false;
  const kind = asKind(event.kind);
  if (kind === null || rule.trigger.event !== kind) return false;
  const filters = rule.trigger.filters;
  if (filters === undefined) return true;
  return Array.isArray(filters) && filters.every((filter) => matchesFilter(filter, event));
}

function missing(path: string, field: string): AutomationIssue {
  return { path, code: "missing_field", message: `"${field}" is required.` };
}

function validateFilter(filter: unknown, path: string): AutomationIssue[] {
  if (!isRecord(filter)) {
    return [{ path, code: "invalid_filter", message: "A filter must be an object." }];
  }
  const issues: AutomationIssue[] = [];
  if (isBlank(filter.field)) issues.push(missing(`${path}.field`, "field"));
  if (isBlank(filter.op)) {
    issues.push(missing(`${path}.op`, "op"));
  } else if (!(AUTOMATION_FILTER_OPS as readonly unknown[]).includes(filter.op)) {
    issues.push({
      path: `${path}.op`,
      code: "invalid_filter",
      message: `"${String(filter.op)}" is not a supported filter operator.`,
    });
  } else if (filter.op === "in") {
    if (!Array.isArray(filter.values)) {
      issues.push({
        path: `${path}.values`,
        code: "invalid_filter",
        message: '"values" must be an array.',
      });
    }
  } else if (filter.op !== "exists" && !("value" in filter)) {
    issues.push(missing(`${path}.value`, "value"));
  }
  return issues;
}

/**
 * Validate a rule (typically straight from stored JSON) and return every issue
 * found. An empty array means the rule is well-formed. Never throws: a
 * non-object collapses to a single `not_an_object` issue. Action fields are
 * validated by the row-buttons validator; their issues are re-pathed onto the
 * rule's action index.
 */
export function validateAutomation(rule: unknown): AutomationIssue[] {
  const issues: AutomationIssue[] = [];
  if (!isRecord(rule)) {
    return [{ path: "", code: "not_an_object", message: "An automation must be an object." }];
  }

  if (isBlank(rule.id)) issues.push(missing("id", "id"));
  if (rule.workspaceId !== undefined && typeof rule.workspaceId !== "string") {
    issues.push({ path: "workspaceId", code: "wrong_type", message: '"workspaceId" must be a string.' });
  }
  if (rule.name !== undefined && typeof rule.name !== "string") {
    issues.push({ path: "name", code: "wrong_type", message: '"name" must be a string.' });
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    issues.push({ path: "enabled", code: "wrong_type", message: '"enabled" must be a boolean.' });
  }

  if (!isRecord(rule.trigger)) {
    issues.push(missing("trigger", "trigger"));
  } else {
    const trigger = rule.trigger;
    if (isBlank(trigger.event)) {
      issues.push(missing("trigger.event", "event"));
    } else if (asKind(trigger.event) === null) {
      issues.push({
        path: "trigger.event",
        code: "unknown_event",
        message: `"${String(trigger.event)}" is not a supported event.`,
      });
    }
    if (trigger.filters !== undefined) {
      if (!Array.isArray(trigger.filters)) {
        issues.push({
          path: "trigger.filters",
          code: "wrong_type",
          message: '"filters" must be an array.',
        });
      } else {
        if (trigger.filters.length > MAX_AUTOMATION_FILTERS) {
          issues.push({
            path: "trigger.filters",
            code: "too_many_filters",
            message: `A rule may define at most ${MAX_AUTOMATION_FILTERS} filters.`,
          });
        }
        trigger.filters.forEach((filter, index) => {
          issues.push(...validateFilter(filter, `trigger.filters.${index}`));
        });
      }
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
    if (rule.actions.length > MAX_AUTOMATION_ACTIONS) {
      issues.push({
        path: "actions",
        code: "too_many_actions",
        message: `A rule may define at most ${MAX_AUTOMATION_ACTIONS} actions.`,
      });
    }
    rule.actions.forEach((action, index) => {
      for (const issue of validateButton({ id: "action", label: "action", action })) {
        issues.push({
          path: issue.path === "" ? `actions.${index}` : `actions.${index}.${issue.path}`,
          code: "invalid_action",
          message: issue.message,
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

const normalizeDepth = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const normalizeMaxDepth = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : MAX_AUTOMATION_DEPTH;

const normalizeVisited = (visited: readonly string[] | undefined): string[] =>
  Array.isArray(visited) ? [...new Set(visited.filter((id) => typeof id === "string"))] : [];

/**
 * Turn a matched rule plus one record into a declarative action plan. Never
 * throws and never performs a side effect.
 *
 * Precedence: an invalid rule yields an `invalid` plan carrying every issue; a
 * disabled rule, a rule already in `visited`, and a chain at its `maxDepth`
 * each yield a `skipped` plan with a `reason`. Otherwise every action is
 * resolved, in order, through `resolveButtonAction` against `context.row`
 * (text fields interpolated), and the plan's `visited` includes this rule so a
 * dispatcher can thread it into the next call — the loop guard (R27.17).
 */
export function planAutomation(rule: unknown, context: AutomationContext = {}): AutomationPlan {
  const record = isRecord(rule) ? rule : {};
  const ruleId = typeof record.id === "string" ? record.id : "";
  const trigger = isRecord(record.trigger) ? record.trigger : {};
  const event = asKind(trigger.event);
  const depth = normalizeDepth(context.depth);
  const maxDepth = normalizeMaxDepth(context.maxDepth);
  const visited = normalizeVisited(context.visited);
  const base = { ruleId, event, depth };

  const issues = validateAutomation(rule);
  if (issues.length > 0) {
    return { ...base, status: "invalid", runnable: false, issues, steps: [], visited };
  }

  if (record.enabled === false) {
    return {
      ...base,
      status: "skipped",
      runnable: false,
      reason: "disabled",
      message: "The rule is disabled.",
      steps: [],
      visited,
    };
  }

  if (visited.includes(ruleId)) {
    return {
      ...base,
      status: "skipped",
      runnable: false,
      reason: "visited",
      message: "The rule already ran in this chain.",
      steps: [],
      visited,
    };
  }

  if (depth >= maxDepth) {
    return {
      ...base,
      status: "skipped",
      runnable: false,
      reason: "max_depth",
      message: `The chain reached its maximum depth of ${maxDepth}.`,
      steps: [],
      visited,
    };
  }

  const row: ButtonRow = context.row ?? { id: "" };
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name : ruleId;
  const actions = record.actions as readonly ButtonAction[];
  const steps: AutomationActionStep[] = actions.map((action, index) => ({
    index,
    plan: resolveButtonAction(
      { id: `${ruleId}#${index}`, label: name, action },
      row,
      { variables: context.variables, now: context.now },
    ),
  }));

  return { ...base, status: "planned", runnable: true, steps, visited: [...visited, ruleId] };
}
