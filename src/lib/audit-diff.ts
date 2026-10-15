/**
 * Audit field diffs (F9) — pure, deterministic, secret-aware.
 *
 * `audit-log.ts` answers "what happened, when and to what"; the missing half is
 * "which fields changed". Activity rows carry `meta` snapshots, this module
 * turns a `before`/`after` pair into an ordered field list a surface can render
 * directly, masking secrets so a diff line never leaks a credential.
 *
 * This is the *object* sibling of `version-history.ts` (block-id diff) and
 * `text-diff.ts` (character diff): same no-Prisma, unit-sandbox discipline.
 *
 * DESIGN NOTES
 *  - SHALLOW BY DEFAULT: only top-level keys are compared unless `maxDepth`
 *    opts into walking nested plain objects, which are then reported as dotted
 *    paths (`user.name`). Arrays are always leaves — reordering a list is one
 *    change, not N.
 *  - DETERMINISM: the key union is visited ASCII-ascending, so equal input
 *    always yields an identical entry list; nested keys are visited in the same
 *    order under their parent (pre-order).
 *  - RAW CHANGE / MASKED DISPLAY: equality is decided on the raw values, then
 *    only the emitted before/after are passed through `redactValue`. Two
 *    different secrets therefore still read as `changed` even when their masks
 *    coincide.
 *  - GRACEFUL: anything that is not a plain record is treated as `{}`, so the
 *    helpers never throw on `null`/`undefined`/scalar input.
 *
 * Unit-pinned red-first by `src/lib/audit-diff.test.ts`.
 */

export type DiffOp = "added" | "removed" | "changed";

/** One field-level difference; `before`/`after` only where meaningful. */
export type DiffEntry = {
  /** Top-level key, or dotted path when nested walking is enabled. */
  readonly field: string;
  readonly op: DiffOp;
  /** Raw (then masked) value before the change; omitted for `added`. */
  readonly before?: unknown;
  /** Raw (then masked) value after the change; omitted for `removed`. */
  readonly after?: unknown;
};

export type DiffOptions = {
  /**
   * Extra field names (or dotted paths) to mask, on top of the built-in secret
   * heuristics. Compared case-insensitively and ignoring `_`/`-`/spaces, so
   * `"apiKey"`, `"api_key"` and `"API KEY"` all match a `"apikey"` entry.
   */
  readonly redactKeys?: readonly string[];
  /**
   * Object levels to walk. `1` (default) compares shallowly; `Infinity` walks
   * the whole tree. Values below 1 are clamped to 1.
   */
  readonly maxDepth?: number;
};

/** A JSON-shaped record as stored in an activity payload. */
export type AuditRecord = Readonly<Record<string, unknown>>;

/**
 * Normalised secret-field fragments. The field (whole dotted path) is
 * lower-cased and stripped of non-alphanumerics before matching, so `apiKey`,
 * `api_key` and `access-token` all normalise onto their fragment.
 */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "privatekey",
  "accesskey",
  "clientsecret",
  "cookie",
  "salt",
  "bearer",
];

/** Mask for a redacted value; `[redacted]` for anything that is not a string. */
const NON_STRING_MASK = "[redacted]";
const STRING_MASK = "\u2022\u2022\u2022\u2022";

/** Collapse a field/path to a stable comparison key. */
function normalizeKey(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when `field` names something that should not be shown verbatim:
 * `password`, `apiKey`, `access_token`, `user.password`, `x-client-secret`, …
 * Deliberately conservative — `author`/`authorId`/`publicKey` are NOT secret.
 */
export function isSensitiveKey(field: string): boolean {
  const normalized = normalizeKey(field);
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Mask a value: strings keep a small shape hint, everything else is opaque. */
function maskValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) return STRING_MASK;
    return `${value.slice(0, 4)}\u2026${value.slice(-2)}`;
  }
  return NON_STRING_MASK;
}

/**
 * Return `value` unchanged unless `field` is sensitive (see
 * {@link isSensitiveKey}), in which case it is replaced by a mask. `field` is
 * used only to decide; the value itself is never inspected for secrets.
 */
export function redactValue(field: string, value: unknown): unknown {
  return isSensitiveKey(field) ? maskValue(value) : value;
}

/** A plain object (not `null`, not an array, Object/`null` prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Treat non-records as an empty record so the walk never throws. */
function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** Deep equality over JSON-shaped values (order of object keys irrelevant). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  // Dates, Maps, and other exotic objects compare by identity (already handled
  // by Object.is above) — JSON-shaped audit payloads stay on the fast path.
  return false;
}

/** ASCII-ascending comparator for a total, locale-independent order. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type WalkContext = {
  readonly entries: DiffEntry[];
  readonly redactKeys: ReadonlySet<string>;
  readonly maxDepth: number;
};

/** True when `path` (or its leaf) is sensitive or explicitly listed. */
function isRedacted(path: string, leaf: string, context: WalkContext): boolean {
  if (isSensitiveKey(path)) return true;
  return context.redactKeys.has(normalizeKey(path)) || context.redactKeys.has(normalizeKey(leaf));
}

/** Mask `value` when `path`/`leaf` is redacted; otherwise pass it through. */
function maybeRedact(path: string, leaf: string, value: unknown, context: WalkContext): unknown {
  return isRedacted(path, leaf, context) ? maskValue(value) : value;
}

/** Compare two records at `depth`, appending differences to `context.entries`. */
function walk(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  prefix: string,
  depth: number,
  context: WalkContext,
): void {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareKeys);

  for (const key of keys) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
    const hasRight = Object.prototype.hasOwnProperty.call(right, key);
    const leftValue = left[key];
    const rightValue = right[key];

    if (!hasLeft) {
      context.entries.push({
        field: path,
        op: "added",
        after: maybeRedact(path, key, rightValue, context),
      });
      continue;
    }
    if (!hasRight) {
      context.entries.push({
        field: path,
        op: "removed",
        before: maybeRedact(path, key, leftValue, context),
      });
      continue;
    }
    if (depth < context.maxDepth && isPlainObject(leftValue) && isPlainObject(rightValue)) {
      walk(leftValue, rightValue, path, depth + 1, context);
      continue;
    }
    if (!deepEqual(leftValue, rightValue)) {
      context.entries.push({
        field: path,
        op: "changed",
        before: maybeRedact(path, key, leftValue, context),
        after: maybeRedact(path, key, rightValue, context),
      });
    }
  }
}

/**
 * Field-level diff of `before` -> `after`, deterministically ordered by field.
 * Shallow by default; pass `maxDepth` to walk nested plain objects (dotted
 * paths) and `redactKeys` to extend the built-in secret masking. Non-records
 * degrade to `{}`; neither input is mutated.
 */
export function diffObjects(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): DiffEntry[] {
  const redactKeys = new Set((options.redactKeys ?? []).map(normalizeKey));
  const maxDepth =
    options.maxDepth === undefined ? 1 : Math.max(1, options.maxDepth);
  const context: WalkContext = { entries: [], redactKeys, maxDepth };
  walk(asRecord(before), asRecord(after), "", 1, context);
  return context.entries;
}

/** True when a diff contains no entries. */
export function isEmptyDiff(entries: readonly DiffEntry[]): boolean {
  return entries.length === 0;
}

/**
 * One-line human summary, e.g.
 * `"3 fields: 1 added, 1 removed, 1 changed (b, c, a)"`, or `"No changes"`.
 * Counts are grouped in the fixed added/removed/changed order while the
 * parenthesised field list follows the entries' own order.
 */
export function summarizeDiff(entries: readonly DiffEntry[]): string {
  if (entries.length === 0) return "No changes";

  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const entry of entries) {
    if (entry.op === "added") added += 1;
    else if (entry.op === "removed") removed += 1;
    else changed += 1;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (changed > 0) parts.push(`${changed} changed`);

  const label = entries.length === 1 ? "1 field" : `${entries.length} fields`;
  const fields = entries.map((entry) => entry.field).join(", ");
  return `${label}: ${parts.join(", ")} (${fields})`;
}
