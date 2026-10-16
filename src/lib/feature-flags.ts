/**
 * A pure, deterministic feature-flag engine.
 *
 * A `Flag` declares a feature key and how it reaches users; `evaluateFlag`
 * answers whether one context (a user id plus optional attributes) gets it and
 * *why*, so a UI can explain a decision and a test can pin it. The engine is
 * the missing half of the matrix's "Feature flags" row
 * (`docs/FEATURE_MATRIX.md:665`, planned) and the plan-gate substrate the
 * licensing spec wants (`docs/specs/plans-licensing.md` §2.3) — today every
 * switch is environment-variable presence, owned by the operator, with no
 * per-user targeting or gradual rollout.
 *
 * PURE module: no prisma, no `node:*` imports, no clock, no randomness. The
 * rollout bucket is a deterministic FNV-1a hash of the user id, so the same
 * user always lands in the same bucket — no flip-flopping between requests —
 * and the whole decision is reproducible in a unit test.
 *
 * Precedence is fixed and total, most specific first:
 *
 *   1. `denylist`  - an explicitly excluded user is off (a kill switch)
 *   2. `allowlist` - an explicitly included user is on (beta access)
 *   3. `rules`     - a matching targeting rule turns the flag on
 *   4. `rollout`   - otherwise the user's bucket decides the percentage
 *   5. `enabled`   - the baseline when no override applies
 *
 * That ordering makes `enabled: false` a safe shipping default: a flag can be
 * dark everywhere and still light up for an allowlist or a percentage, while
 * `enabled: true` keeps everyone on unless a rule narrows it.
 *
 * Everything fails closed: a structurally bad stored flag is treated as
 * disabled (`reason: "invalid"`), an unknown rule operator or a rule on a
 * missing attribute never matches, and `validateFlag` reports malformed flags
 * instead of throwing. Unit-pinned red-first by `src/lib/feature-flags.test.ts`.
 */

/**
 * Attribute values a targeting rule can read. Scalars only — a rule compares
 * one value; a list belongs on the rule's `value` side (see `in`).
 */
export type FlagAttributeValue = string | number | boolean | null | undefined;

/** The value side of a rule: a scalar, or a list for the `in` operator. */
export type FlagRuleValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean)[];

/**
 * The operator vocabulary. Every operator is checked at runtime too, so stored
 * JSON that names an operator this version does not know is inert rather than
 * a crash or an accidental match.
 */
export const FLAG_RULE_OPERATORS = [
  "eq",
  "neq",
  "in",
  "contains",
  "starts_with",
  "ends_with",
  "gt",
  "lt",
  "gte",
  "lte",
  "exists",
  "not_exists",
] as const;

export type FlagRuleOperator = (typeof FLAG_RULE_OPERATORS)[number];

/** One targeting rule: read `attr` from the context, apply `op` to `value`. */
export type FlagRule = {
  /** Attribute name on the evaluation context (or `"userId"`). */
  attr: string;
  op: FlagRuleOperator;
  /** Expected value; unused by `exists` / `not_exists`. */
  value?: FlagRuleValue;
};

/**
 * A feature flag as stored. Every targeting field is optional: the more fields
 * a flag sets, the narrower the override (see the module precedence).
 */
export type Flag = {
  key: string;
  enabled: boolean;
  /** Percentage of users included (0..100); the rest fall to `enabled`. */
  rollout?: number;
  /** User ids always included, regardless of rules and rollout. */
  allowlist?: string[];
  /** User ids always excluded — beats every other field. */
  denylist?: string[];
  /** Targeting rules; any match turns the flag on. */
  rules?: FlagRule[];
};

/** What one evaluation reads: a user id and optional targeting attributes. */
export type FlagContext = {
  userId: string;
  attributes?: Record<string, FlagAttributeValue>;
};

/**
 * Why a decision came out the way it did. `denylist` / `disabled` / `invalid`
 * / `not_found` are the negative reasons; the rest are positive.
 */
export type FlagReason =
  | "denylist"
  | "allowlist"
  | "rules"
  | "rollout"
  | "planGate"
  | "enabled"
  | "disabled"
  | "global"
  | "invalid"
  | "not_found";

export type FlagDecision = {
  enabled: boolean;
  reason: FlagReason;
};

/* ------------------------------------------------------------------ *
 * Plan-aware definitions (MISSING_FEATURES §17 "Feature flags" and
 * "Plan gates").
 *
 * The `Flag` engine above targets one beta population with targeting rules
 * and a bare user-id rollout. The definition surface below adds the two
 * things the licensing spec asks for (`docs/specs/plans-licensing.md`): a
 * workspace-scoped allowlist and a `planGate`, so one feature can be
 * restricted to a plan while still being beta-tested with named users.
 *
 * Precedence, most specific first:
 *
 *   1. `allowlist`      - a named user or workspace is on
 *   2. `planGate`       - the context's plan is (or is not) admitted
 *   3. `rolloutPercent` - `bucketOf(userId, key)` decides the percentage
 *   4. `enabled`        - the baseline, reported as `"global"`
 *
 * The same `evaluateFlag` serves both surfaces (see its overloads); a
 * definition is recognised by its plan-aware fields or by a plan/workspace
 * in the context. Everything stays pure: no clock, no randomness, no I/O.
 * ------------------------------------------------------------------ */

/** The plans a `planGate` admits, by plan id (e.g. `business`, `enterprise`). */
export type FlagPlanGate = {
  /** Plan ids for which the flag is enabled; an empty list admits nobody. */
  plans: readonly string[];
};

/**
 * A plan-aware feature-flag definition. Every targeting field is optional:
 * the more a definition sets, the more specific its override.
 */
export type FlagDefinition = {
  key: string;
  enabled: boolean;
  /** Percentage of users included (0..100), keyed by `bucketOf(userId, key)`. */
  rolloutPercent?: number;
  /** Named users / workspaces always included, regardless of plan or rollout. */
  allowlist?: {
    userIds?: readonly string[];
    workspaceIds?: readonly string[];
  };
  /** When set, only the listed plans get the flag (fails closed otherwise). */
  planGate?: FlagPlanGate;
};

/** What one plan-aware evaluation reads. Every field is optional. */
export type FlagEvaluationContext = {
  userId?: string;
  workspaceId?: string;
  plan?: string;
};

/** Non-null, non-array object — the only shape trusted as a flag/rule. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlagRuleOperator(value: unknown): value is FlagRuleOperator {
  return (
    typeof value === "string" &&
    (FLAG_RULE_OPERATORS as readonly string[]).includes(value)
  );
}

/**
 * Deterministic 0..99 bucket for a user id (FNV-1a, 32-bit, unsigned).
 *
 * Stable for the life of the flag definition: the same id always yields the
 * same bucket, so a `rollout` percentage partitions users once and never
 * reshuffles them between requests. The exact boundaries are pinned by the unit
 * test — changing the hash would move users, so treat it as a wire format.
 */
export function bucketFor(userId: string): number {
  const id = typeof userId === "string" ? userId : "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

/**
 * Read a rule's attribute from the context. `"userId"` always resolves to the
 * context's user id, so rules can target a specific user without that id being
 * duplicated into `attributes`.
 */
function attributeValue(context: FlagContext, attr: string): FlagAttributeValue {
  const attributes = isRecord(context.attributes) ? context.attributes : {};
  if (Object.prototype.hasOwnProperty.call(attributes, attr)) {
    return attributes[attr] as FlagAttributeValue;
  }
  return attr === "userId" ? context.userId : undefined;
}

/** Numeric view of a value, or `null` when it is not a finite number. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Apply one operator. A missing attribute (or an unknown/malformed rule) never
 * matches a positive operator — the only operator that matches absence is
 * `not_exists`. That "fail closed" rule matters because a match enables the
 * flag.
 */
function applyOperator(
  op: FlagRuleOperator,
  actual: FlagAttributeValue,
  expected: FlagRuleValue | undefined,
): boolean {
  const present = actual !== undefined && actual !== null;
  switch (op) {
    case "exists":
      return present;
    case "not_exists":
      return !present;
    case "eq":
      return present && String(actual) === String(expected);
    case "neq":
      return present && String(actual) !== String(expected);
    case "in":
      return (
        present &&
        Array.isArray(expected) &&
        expected.some((entry) => String(entry) === String(actual))
      );
    case "contains":
      return present && expected !== undefined && expected !== null && String(actual).includes(String(expected));
    case "starts_with":
      return present && expected !== undefined && expected !== null && String(actual).startsWith(String(expected));
    case "ends_with":
      return present && expected !== undefined && expected !== null && String(actual).endsWith(String(expected));
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const left = toNumber(actual);
      const right = toNumber(expected);
      if (left === null || right === null) return false;
      if (op === "gt") return left > right;
      if (op === "lt") return left < right;
      if (op === "gte") return left >= right;
      return left <= right;
    }
    default:
      return false;
  }
}

/** Whether one untrusted rule matches the context. Never throws. */
function ruleMatches(rule: unknown, context: FlagContext): boolean {
  if (!isRecord(rule)) return false;
  const attr = rule.attr;
  const op = rule.op;
  if (typeof attr !== "string" || attr === "") return false;
  if (!isFlagRuleOperator(op)) return false;
  return applyOperator(op, attributeValue(context, attr), rule.value as FlagRuleValue | undefined);
}

/** Coerce an untrusted value to a user-id list; a non-array is treated as empty. */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Clamp an untrusted rollout to an integer 0..100, or `null` when unusable. */
function rolloutPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

/**
 * Decide one flag for one context. See the module header for the precedence;
 * the short version is denylist > allowlist > rules > planGate > rollout >
 * `enabled` (the plan-aware baseline reports as `"global"`).
 *
 * The same function serves the classic `Flag` engine and the plan-aware
 * `FlagDefinition` surface: a definition is recognised by a plan-aware field
 * (`planGate` / `rolloutPercent` / an object `allowlist`) or by a plan or a
 * workspace in the context. A flag that is not even an object fails closed to
 * `{ enabled: false, reason: "invalid" }`; malformed sub-fields (a non-array
 * allowlist, a bad rule) are ignored so a corrupt row can only narrow access,
 * never widen it.
 */
export function evaluateFlag(
  definition: FlagDefinition,
  context?: FlagEvaluationContext,
): FlagDecision;
export function evaluateFlag(
  definition: unknown,
  context?: FlagContext | FlagEvaluationContext,
): FlagDecision;
export function evaluateFlag(
  definition: unknown,
  context?: FlagContext | FlagEvaluationContext,
): FlagDecision {
  if (!isRecord(definition)) return { enabled: false, reason: "invalid" };
  const mode = flagMode(definition, context);
  const record: Record<string, unknown> = isRecord(context)
    ? (context as Record<string, unknown>)
    : {};
  const userId = typeof record.userId === "string" ? record.userId : "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : undefined;
  const plan = typeof record.plan === "string" ? record.plan : undefined;
  const targetingContext: FlagContext = isRecord(record.attributes)
    ? { userId, attributes: record.attributes as Record<string, FlagAttributeValue> }
    : { userId };

  if (idList(definition.denylist).includes(userId)) {
    return { enabled: false, reason: "denylist" };
  }
  if (allowlistMatches(definition.allowlist, userId, workspaceId)) {
    return { enabled: true, reason: "allowlist" };
  }

  const rules = Array.isArray(definition.rules) ? definition.rules : [];
  if (rules.length > 0 && rules.some((rule) => ruleMatches(rule, targetingContext))) {
    return { enabled: true, reason: "rules" };
  }

  if (definition.planGate !== undefined) {
    return { enabled: planGateAllows(definition.planGate, plan), reason: "planGate" };
  }

  const percent = rolloutPercent(definition.rolloutPercent ?? definition.rollout);
  if (percent !== null) {
    const bucket =
      definition.rolloutPercent !== undefined
        ? bucketOf(userId, typeof definition.key === "string" ? definition.key : "")
        : bucketFor(userId);
    return { enabled: bucket < percent, reason: "rollout" };
  }

  if (definition.enabled === true) {
    return { enabled: true, reason: mode === "definition" ? "global" : "enabled" };
  }
  return { enabled: false, reason: mode === "definition" ? "global" : "disabled" };
}

/**
 * Resolve a decision for `key` in a flag list. An absent key is a deliberate
 * `not_found` (disabled) — the fail-closed default for a feature that has not
 * been configured.
 */
export function resolveFlag(
  flags: readonly Flag[],
  key: string,
  context: FlagContext,
): FlagDecision {
  const list = Array.isArray(flags) ? flags : [];
  const flag = list.find((entry) => isRecord(entry) && entry.key === key);
  if (!flag) return { enabled: false, reason: "not_found" };
  return evaluateFlag(flag, context);
}

/** Whether `key` is enabled for `context` — the common call site. */
export function isEnabled(
  flags: readonly Flag[],
  key: string,
  context: FlagContext,
): boolean {
  return resolveFlag(flags, key, context).enabled;
}

export type FlagIssueCode =
  /** Not an object at all. */
  | "invalid_flag"
  /** No usable `key` — the flag cannot be looked up. */
  | "missing_key"
  /** `enabled` is not a boolean. */
  | "invalid_enabled"
  /** `rollout` is set but is not an integer 0..100. */
  | "invalid_rollout"
  /** `allowlist` is set but is not a string array. */
  | "invalid_allowlist"
  /** `denylist` is set but is not a string array. */
  | "invalid_denylist"
  /** `rules` is set but is not an array. */
  | "invalid_rules"
  /** A rule has a non-string (or empty) `attr`. */
  | "invalid_rule_attr"
  /** A rule names an operator this version does not know. */
  | "invalid_rule_op";

export type FlagIssue = {
  code: FlagIssueCode;
  message: string;
  /** Position in `rules`, for the two rule-level codes. */
  index?: number;
};

/** Short, safe rendering of an untrusted value for an issue message. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Report every problem with a stored flag: missing key, wrong types, an
 * out-of-range rollout, malformed lists or rules. Fail-safe by contract — it
 * never throws and never skips a broken field silently, so a flags editor can
 * list what to fix. An empty array means the flag is valid.
 */
export function validateFlag(flag: unknown): FlagIssue[] {
  if (!isRecord(flag)) {
    return [{ code: "invalid_flag", message: `Flag must be an object, got ${show(flag)}.` }];
  }
  const issues: FlagIssue[] = [];
  const report = (code: FlagIssueCode, message: string, index?: number) => {
    issues.push(index === undefined ? { code, message } : { code, message, index });
  };

  if (typeof flag.key !== "string" || flag.key.trim() === "") {
    report("missing_key", `Flag has no usable key (got ${show(flag.key)}).`);
  }
  if (typeof flag.enabled !== "boolean") {
    report("invalid_enabled", `Flag "enabled" must be a boolean (got ${show(flag.enabled)}).`);
  }
  if (flag.rollout !== undefined) {
    const percent = flag.rollout;
    const valid =
      typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100;
    if (!valid) {
      report("invalid_rollout", `Flag "rollout" must be an integer 0..100 (got ${show(percent)}).`);
    }
  }
  for (const field of ["allowlist", "denylist"] as const) {
    const value = flag[field];
    if (value === undefined) continue;
    const valid = Array.isArray(value) && value.every((entry) => typeof entry === "string");
    if (!valid) {
      report(
        field === "allowlist" ? "invalid_allowlist" : "invalid_denylist",
        `Flag "${field}" must be a string array (got ${show(value)}).`,
      );
    }
  }
  if (flag.rules !== undefined) {
    if (!Array.isArray(flag.rules)) {
      report("invalid_rules", `Flag "rules" must be an array (got ${show(flag.rules)}).`);
    } else {
      flag.rules.forEach((rule, index) => {
        if (!isRecord(rule)) {
          report("invalid_rule_attr", `Rule #${index} is not an object.`, index);
          return;
        }
        if (typeof rule.attr !== "string" || rule.attr === "") {
          report("invalid_rule_attr", `Rule #${index} has no usable attr (got ${show(rule.attr)}).`, index);
        }
        if (!isFlagRuleOperator(rule.op)) {
          report("invalid_rule_op", `Rule #${index} uses unknown operator ${show(rule.op)}.`, index);
        }
      });
    }
  }
  return issues;
}

/* ------------------------- plan-aware helpers ------------------------- */

/** Which baseline reason vocabulary a call should use. */
type FlagMode = "definition" | "targeting";

/**
 * Whether a stored value names the plan-aware definition surface rather than
 * the classic targeting engine. Keyed off fields only the definition surface
 * declares, so the two surfaces never collide.
 */
function looksLikeDefinition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.planGate !== undefined) return true;
  if (value.rolloutPercent !== undefined) return true;
  return isRecord(value.allowlist);
}

/** Whether a context names the plan-aware surface (it carries plan/workspace). */
function looksLikeDefinitionContext(value: unknown): boolean {
  return isRecord(value) && (value.workspaceId !== undefined || value.plan !== undefined);
}

/** Which baseline reason vocabulary applies to this call. */
function flagMode(definition: unknown, context: unknown): FlagMode {
  return looksLikeDefinition(definition) || looksLikeDefinitionContext(context)
    ? "definition"
    : "targeting";
}

/**
 * Whether the definition's allowlist admits this user/workspace. Accepts both
 * the plan-aware object form and the classic user-id array form; an empty or
 * malformed allowlist never matches.
 */
function allowlistMatches(
  allowlist: unknown,
  userId: string,
  workspaceId: string | undefined,
): boolean {
  if (Array.isArray(allowlist)) return idList(allowlist).includes(userId);
  if (!isRecord(allowlist)) return false;
  if (userId !== "" && idList(allowlist.userIds).includes(userId)) return true;
  return (
    workspaceId !== undefined &&
    workspaceId !== "" &&
    idList(allowlist.workspaceIds).includes(workspaceId)
  );
}

/** Whether a plan gate admits `plan`; a missing/empty plan fails closed. */
function planGateAllows(gate: unknown, plan: string | undefined): boolean {
  if (!isRecord(gate)) return false;
  return plan !== undefined && plan !== "" && idList(gate.plans).includes(plan);
}

/**
 * Deterministic 0..99 bucket for a `(userId, key)` pair (FNV-1a, 32-bit,
 * unsigned). The key salts the hash, so one user partitions independently per
 * flag; the mapping is a wire format pinned by the unit test — changing it
 * would move users, so treat it as stable.
 */
export function bucketOf(userId: string, key: string): number {
  const id = typeof userId === "string" ? userId : "";
  const name = typeof key === "string" ? key : "";
  const seed = `${name}\u0000${id}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

/* --------------------------- parsing helpers -------------------------- */

/** A normalised allowlist, or `undefined` when it names nobody. */
function parseAllowlist(value: unknown): FlagDefinition["allowlist"] {
  if (Array.isArray(value)) {
    const userIds = idList(value);
    return userIds.length > 0 ? { userIds } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const userIds = idList(value.userIds);
  const workspaceIds = idList(value.workspaceIds);
  if (userIds.length === 0 && workspaceIds.length === 0) return undefined;
  const allowlist: { userIds?: string[]; workspaceIds?: string[] } = {};
  if (userIds.length > 0) allowlist.userIds = userIds;
  if (workspaceIds.length > 0) allowlist.workspaceIds = workspaceIds;
  return allowlist;
}

/** A validated plan gate, or `undefined` when it names no usable plan. */
function parsePlanGate(value: unknown): FlagPlanGate | undefined {
  let source: unknown;
  if (Array.isArray(value)) source = value;
  else if (isRecord(value)) source = value.plans;
  else source = undefined;
  const plans = idList(source);
  return plans.length > 0 ? { plans } : undefined;
}

/** Parse one untrusted candidate into a definition, or `null` when unusable. */
function parseFlagDefinition(value: unknown, fallbackKey?: string): FlagDefinition | null {
  const record = isRecord(value) ? value : {};
  const rawKey = typeof record.key === "string" ? record.key : fallbackKey;
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (key === "") return null;

  const definition: FlagDefinition = { key, enabled: record.enabled === true };
  const percent = rolloutPercent(record.rolloutPercent);
  if (record.rolloutPercent !== undefined && percent !== null) {
    definition.rolloutPercent = percent;
  }
  const allowlist = parseAllowlist(record.allowlist);
  if (allowlist !== undefined) definition.allowlist = allowlist;
  const planGate = parsePlanGate(record.planGate);
  if (planGate !== undefined) definition.planGate = planGate;
  return definition;
}

/**
 * Parse untrusted `raw` into plan-aware definitions. Accepts an array of
 * candidate objects or a `{ key: candidate }` map (the map key is the
 * fallback). Entries without a usable key are dropped, duplicate keys keep the
 * first, unknown fields are ignored, and a bad entry never throws.
 */
export function parseFlags(raw: unknown): FlagDefinition[] {
  const parsed: FlagDefinition[] = [];
  const seen = new Set<string>();
  const accept = (value: unknown, fallbackKey?: string) => {
    const definition = parseFlagDefinition(value, fallbackKey);
    if (definition === null || seen.has(definition.key)) return;
    seen.add(definition.key);
    parsed.push(definition);
  };
  if (Array.isArray(raw)) {
    for (const value of raw) accept(value);
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) accept(value, key);
  }
  return parsed;
}

/* --------------------------- env overrides ---------------------------- */

/** The environment prefix that overrides a flag: `FLAG_<KEY>`. */
export const FLAG_OVERRIDE_PREFIX = "FLAG_";

const OVERRIDE_TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
const OVERRIDE_FALSE_TOKENS = new Set(["false", "0", "no", "off"]);

/** Parse one env value to a boolean, or `null` when it names neither state. */
function envBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (OVERRIDE_TRUE_TOKENS.has(token)) return true;
  if (OVERRIDE_FALSE_TOKENS.has(token)) return false;
  return null;
}

/**
 * Derive `key -> boolean` overrides from environment variables named
 * `FLAG_<KEY>` (case-insensitive). The key is the lower-cased suffix, so
 * `FLAG_BETA_UI=on` overrides `beta_ui`. Unknown names and unparseable values
 * are ignored; junk input yields `{}` rather than throwing.
 */
export function overridesFromEnv(env: unknown): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (!isRecord(env)) return overrides;
  for (const [name, raw] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith(FLAG_OVERRIDE_PREFIX)) continue;
    const suffix = name.slice(FLAG_OVERRIDE_PREFIX.length).trim();
    if (suffix === "") continue;
    const value = envBoolean(raw);
    if (value === null) continue;
    overrides[suffix.toLowerCase()] = value;
  }
  return overrides;
}

/* --------------------------- describing ------------------------------- */

/** `n` with a singular/plural noun, for a human summary. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The plan list for a summary label, or `null` when there is no gate. */
function describePlans(gate: unknown): string | null {
  if (gate === undefined) return null;
  const plans = parsePlanGate(gate);
  return plans === undefined ? "gated" : plans.plans.join("/");
}

/**
 * A short, deterministic, human-readable summary of a definition, safe for
 * logs and admin UIs. Malformed input yields `"unknown flag"` rather than
 * throwing.
 */
export function describeFlag(definition: unknown): string {
  if (!isRecord(definition)) return "unknown flag";
  const key =
    typeof definition.key === "string" && definition.key.trim() !== ""
      ? definition.key.trim()
      : "?";
  const parts: string[] = [];

  const allowlist = definition.allowlist;
  if (Array.isArray(allowlist)) {
    const users = idList(allowlist).length;
    if (users > 0) parts.push(`allowlist ${countLabel(users, "user")}`);
  } else if (isRecord(allowlist)) {
    const users = idList(allowlist.userIds).length;
    const workspaces = idList(allowlist.workspaceIds).length;
    if (users > 0) parts.push(`allowlist ${countLabel(users, "user")}`);
    if (workspaces > 0) parts.push(countLabel(workspaces, "workspace"));
  }

  const plans = describePlans(definition.planGate);
  if (plans !== null) parts.push(`plans ${plans}`);

  const percent = rolloutPercent(definition.rolloutPercent ?? definition.rollout);
  if (percent !== null) parts.push(`rollout ${percent}%`);

  const state = definition.enabled === true ? "on" : "off";
  return parts.length === 0 ? `${key}: ${state}` : `${key}: ${state} (${parts.join(", ")})`;
}
