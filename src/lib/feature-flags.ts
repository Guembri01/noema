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
  | "enabled"
  | "disabled"
  | "invalid"
  | "not_found";

export type FlagDecision = {
  enabled: boolean;
  reason: FlagReason;
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
 * the short version is denylist > allowlist > rules > rollout > `enabled`.
 *
 * A flag that is not even an object fails closed to `{ enabled: false, reason:
 * "invalid" }`; malformed sub-fields (a non-array allowlist, a bad rule) are
 * ignored so a corrupt row can only narrow access, never widen it.
 */
export function evaluateFlag(flag: unknown, context: FlagContext): FlagDecision {
  if (!isRecord(flag)) return { enabled: false, reason: "invalid" };
  const ctx: FlagContext = isRecord(context)
    ? {
        userId: typeof context.userId === "string" ? context.userId : "",
        ...(isRecord(context.attributes)
          ? { attributes: context.attributes as Record<string, FlagAttributeValue> }
          : {}),
      }
    : { userId: "" };

  if (idList(flag.denylist).includes(ctx.userId)) {
    return { enabled: false, reason: "denylist" };
  }
  if (idList(flag.allowlist).includes(ctx.userId)) {
    return { enabled: true, reason: "allowlist" };
  }

  const rules = Array.isArray(flag.rules) ? flag.rules : [];
  if (rules.length > 0 && rules.some((rule) => ruleMatches(rule, ctx))) {
    return { enabled: true, reason: "rules" };
  }

  const rollout = rolloutPercent(flag.rollout);
  if (rollout !== null) {
    return { enabled: bucketFor(ctx.userId) < rollout, reason: "rollout" };
  }

  return flag.enabled === true
    ? { enabled: true, reason: "enabled" }
    : { enabled: false, reason: "disabled" };
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
