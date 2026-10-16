/**
 * A pure session store over the feature-flag engine (`feature-flags.ts`).
 *
 * The engine answers *one* flag for *one* context. A running app needs three
 * more things, all of which live here and none of which touch the engine:
 *
 *   1. **A registry.** `defineFlag` validates a candidate with `validateFlag`
 *      and keeps a canonical, isolated copy. A malformed *definition* is a
 *      programmer error, so it throws a {@link FlagStoreError} carrying the
 *      engine's issues — the fail-closed `evaluateFlag` still guards everything
 *      that reaches the resolver.
 *   2. **A resolver.** `resolveAll` returns one decision per registered key, in
 *      registry order, stamped with the layer that decided it (`source`).
 *   3. **Two override layers.** `override` sets or clears a *session* override
 *      (a kill switch / dev toggle); `parseFlagEnv` and `applyFlagEnv` derive
 *      an *env* layer from `FLAG_*` variables. Precedence is fixed and total:
 *
 *        session override  >  env override  >  the flag definition
 *
 *      so an operator's `FLAG_X=false` always wins over targeting, and a
 *      session's explicit `override("x", false)` always wins over the env.
 *
 * Everything is a value: `createFlagStore` / `defineFlag` / `override` /
 * `applyFlagEnv` return a fresh store and never mutate (or alias the arrays
 * of) their input, so a sequence of edits is reproducible in a unit test. No
 * prisma, no `node:*`, no clock, no randomness, no I/O. Buttons pinned red-first
 * by `src/lib/feature-flag-store.test.ts`.
 */

import {
  evaluateFlag,
  validateFlag,
  type Flag,
  type FlagContext,
  type FlagIssue,
  type FlagReason,
  type FlagRule,
} from "@/lib/feature-flags";

/** The environment-variable prefix that names a flag: `FLAG_<KEY>`. */
export const FLAG_ENV_PREFIX = "FLAG_";

/** A `key -> boolean` override layer. Records are treated as immutable. */
export type FlagOverrides = Readonly<Record<string, boolean>>;

/**
 * The session configuration: a validated registry plus both override layers.
 * Every field is a fresh value; callers never mutate a store in place.
 */
export type FlagStore = {
  /** Validated flags in registry order; re-defining a key replaces in place. */
  readonly flags: readonly Flag[];
  /** Session overrides — the highest-precedence layer. */
  readonly overrides: FlagOverrides;
  /** Environment-derived overrides — the middle layer. */
  readonly env: FlagOverrides;
};

/** Which layer produced a resolution. */
export type FlagResolutionSource = "flag" | "override" | "env";

/** The engine's reasons plus the two override layers. */
export type FlagStoreReason = FlagReason | "override" | "env";

/** One key's decision, with the layer that produced it. */
export type FlagResolution = {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason: FlagStoreReason;
  readonly source: FlagResolutionSource;
};

/** A deep-ish copy of a store, safe to serialise. */
export type FlagStoreSnapshot = {
  readonly flags: readonly Flag[];
  readonly overrides: FlagOverrides;
  readonly env: FlagOverrides;
};

/** Options accepted by {@link createFlagStore}. Values are untrusted. */
export type FlagStoreInit = {
  flags?: readonly unknown[];
  overrides?: unknown;
  env?: unknown;
};

/** Thrown by {@link defineFlag} when a definition is not a valid flag. */
export class FlagStoreError extends Error {
  /** The engine's problems, in first-seen order; never empty in practice. */
  readonly issues: readonly FlagIssue[];

  constructor(issues: readonly FlagIssue[]) {
    const summary = issues.map((issue) => issue.code).join(", ");
    super(`Invalid feature flag definition: ${summary}`);
    this.name = "FlagStoreError";
    this.issues = issues;
  }
}

/** Non-null, non-array object — the only shape trusted as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable override key: a trimmed non-empty string, else `null`. */
function normalizeKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const name = key.trim();
  return name === "" ? null : name;
}

/** Copy one rule so a definition never aliases the caller's value array. */
function cloneRule(rule: FlagRule): FlagRule {
  const clone: FlagRule = { attr: rule.attr, op: rule.op };
  if (Array.isArray(rule.value)) clone.value = [...rule.value];
  else if (rule.value !== undefined) clone.value = rule.value;
  return clone;
}

/** Copy a flag, dropping unknown fields and detaching every nested array. */
function cloneFlag(flag: Flag): Flag {
  const clone: Flag = { key: flag.key, enabled: flag.enabled };
  if (flag.rollout !== undefined) clone.rollout = flag.rollout;
  if (flag.allowlist !== undefined) clone.allowlist = [...flag.allowlist];
  if (flag.denylist !== undefined) clone.denylist = [...flag.denylist];
  if (flag.rules !== undefined) clone.rules = flag.rules.map(cloneRule);
  return clone;
}

/**
 * Validate a candidate flag and return a canonical copy: a trimmed key, only
 * the known fields, and fresh nested arrays. Throws {@link FlagStoreError}
 * listing every issue when the engine rejects it.
 */
function canonicalFlag(value: unknown): Flag {
  const issues = validateFlag(value);
  if (issues.length > 0) throw new FlagStoreError(issues);
  const record = value as Record<string, unknown>;
  return cloneFlag({
    key: (record.key as string).trim(),
    enabled: record.enabled as boolean,
    rollout: record.rollout as number | undefined,
    allowlist: record.allowlist as string[] | undefined,
    denylist: record.denylist as string[] | undefined,
    rules: record.rules as FlagRule[] | undefined,
  });
}

/** Register `flag`, replacing an existing entry with the same key in place. */
function appendFlag(flags: readonly Flag[], flag: Flag): Flag[] {
  const index = flags.findIndex((entry) => entry.key === flag.key);
  if (index === -1) return [...flags, flag];
  const next = [...flags];
  next[index] = flag;
  return next;
}

/** Keep only boolean entries under non-empty keys from an untrusted record. */
function normalizeOverrides(value: unknown): FlagOverrides {
  if (!isRecord(value)) return {};
  const overrides: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "" && typeof entry === "boolean") overrides[key] = entry;
  }
  return overrides;
}

/** A copy of `record` with its keys in sorted order, for a stable snapshot. */
function sortedRecord(record: FlagOverrides): FlagOverrides {
  const sorted: Record<string, boolean> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/**
 * Build a store: validate and canonicalise `init.flags`, and keep the boolean
 * entries of `init.overrides` / `init.env`. Unknown or malformed init values are
 * ignored rather than thrown; only a malformed *flag* is loud.
 */
export function createFlagStore(init: FlagStoreInit = {}): FlagStore {
  const source = isRecord(init) ? init : {};
  let flags: Flag[] = [];
  if (Array.isArray(source.flags)) {
    for (const entry of source.flags) flags = appendFlag(flags, canonicalFlag(entry));
  }
  return {
    flags,
    overrides: normalizeOverrides(source.overrides),
    env: normalizeOverrides(source.env),
  };
}

/**
 * Add `flag` to the registry, in place when its (trimmed) key already exists so
 * registry order stays stable. Returns a fresh store; the input is untouched.
 * Throws {@link FlagStoreError} for a malformed definition.
 */
export function defineFlag(store: FlagStore, flag: unknown): FlagStore {
  const canonical = canonicalFlag(flag);
  return {
    flags: appendFlag(store.flags, canonical),
    overrides: store.overrides,
    env: store.env,
  };
}

/**
 * Set (`true` / `false`) or clear (`null`) the session override for `key`.
 * An unusable key, or a value that is neither a boolean nor `null`, is a no-op
 * that returns the input store unchanged. Always returns a fresh store on a
 * real change; the input is never mutated.
 */
export function override(store: FlagStore, key: unknown, value: unknown): FlagStore {
  const name = normalizeKey(key);
  if (name === null) return store;
  if (value !== true && value !== false && value !== null) return store;
  const overrides = { ...store.overrides };
  if (value === null) delete overrides[name];
  else overrides[name] = value;
  return { flags: store.flags, overrides, env: store.env };
}

/** Clear the session override for `key` — `override(store, key, null)`. */
export function clearOverride(store: FlagStore, key: unknown): FlagStore {
  return override(store, key, null);
}

/**
 * The `FLAG_<KEY>` variable name for a flag key, or `null` when the key cannot
 * be env-gated. Only `[A-Za-z][A-Za-z0-9_]*` keys map cleanly (upper-cased), so
 * the mapping never collides two distinct keys onto one variable.
 */
export function envKeyFor(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const name = key.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return null;
  return `${FLAG_ENV_PREFIX}${name.toUpperCase()}`;
}

const TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "off"]);

/** Parse an env value to a boolean, or `null` when it names neither state. */
function parseEnvBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return null;
}

/**
 * Parse `FLAG_*` variables into an override map keyed by the upper-cased name
 * *after* the prefix (e.g. `FLAG_BETA_UI` -> `BETA_UI`). Truthy tokens are
 * `true` / `1` / `yes` / `on`; falsy are `false` / `0` / `no` / `off`
 * (case-insensitive). Every other name or value is ignored; junk input yields
 * `{}` rather than throwing.
 */
export function parseFlagEnv(env: unknown): FlagOverrides {
  const parsed: Record<string, boolean> = {};
  if (!isRecord(env)) return parsed;
  for (const [name, raw] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith(FLAG_ENV_PREFIX)) continue;
    const suffix = upper.slice(FLAG_ENV_PREFIX.length);
    if (suffix === "") continue;
    const value = parseEnvBoolean(raw);
    if (value !== null) parsed[suffix] = value;
  }
  return parsed;
}

/**
 * Replace the store's env layer with the overrides the given environment names
 * for *registered* flags. Re-applying with a smaller environment clears the
 * variables it no longer sets, so the layer always mirrors the last apply.
 * Returns a fresh store; the input is untouched.
 */
export function applyFlagEnv(store: FlagStore, env: unknown): FlagStore {
  const parsed = parseFlagEnv(env);
  const next: Record<string, boolean> = {};
  for (const flag of store.flags) {
    const variable = envKeyFor(flag.key);
    if (variable === null) continue;
    const suffix = variable.slice(FLAG_ENV_PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(parsed, suffix)) next[flag.key] = parsed[suffix];
  }
  return { flags: store.flags, overrides: store.overrides, env: next };
}

/** Whether `resolveAll` was handed a bare flag list rather than a store. */
function isFlagList(value: FlagStore | readonly Flag[]): value is readonly Flag[] {
  return Array.isArray(value);
}

/** Decide one registered flag through the override layers, then the engine. */
function resolveOne(key: string, flag: Flag, store: FlagStore, context: FlagContext): FlagResolution {
  const session = store.overrides[key];
  if (session === true || session === false) {
    return { key, enabled: session, reason: "override", source: "override" };
  }
  const environment = store.env[key];
  if (environment === true || environment === false) {
    return { key, enabled: environment, reason: "env", source: "env" };
  }
  const decision = evaluateFlag(flag, context);
  return { key, enabled: decision.enabled, reason: decision.reason, source: "flag" };
}

/**
 * Resolve every flag against `context`, in registry (or input) order, keeping
 * the first entry for a duplicated key. Pass a {@link FlagStore} to apply its
 * override layers, or a bare flag list to consult the engine alone. Malformed
 * entries are skipped; nothing here throws.
 */
export function resolveAll(
  source: FlagStore | readonly Flag[],
  context: FlagContext,
): readonly FlagResolution[] {
  const store: FlagStore = isFlagList(source)
    ? { flags: source, overrides: {}, env: {} }
    : source;
  const seen = new Set<string>();
  const resolved: FlagResolution[] = [];
  for (const flag of store.flags) {
    if (!isRecord(flag)) continue;
    const key = flag.key;
    if (typeof key !== "string" || key === "" || seen.has(key)) continue;
    seen.add(key);
    resolved.push(resolveOne(key, flag as unknown as Flag, store, context));
  }
  return resolved;
}

/**
 * A serialisable copy of the store: the registry, plus both override layers
 * with sorted keys so repeated snapshots compare equal. Everything is a fresh
 * value, so mutating the result cannot reach the store.
 */
export function snapshot(store: FlagStore): FlagStoreSnapshot {
  return {
    flags: store.flags.map(cloneFlag),
    overrides: sortedRecord(store.overrides),
    env: sortedRecord(store.env),
  };
}
