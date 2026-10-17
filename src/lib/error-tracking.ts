/**
 * Error tracking engine — pure core (docs/FEATURE_MATRIX.md §17 "Error tracking").
 *
 * The planned error-tracking panel needs a framework-free heart it can share
 * between the browser error boundary and any future server/route handler. This
 * module is that heart: no Prisma, no React, no network, no ambient clock and
 * no RNG. Given any thrown value and a caller-supplied event stream it produces
 * a normalised error, a stable grouping fingerprint, a sampling decision, and a
 * triage report. Every helper is *total* — it returns a value for any input
 * (strings, plain objects, `null`, circular records, hostile throwing getters)
 * and never throws, because error reporting must not throw while reporting an
 * error.
 *
 * The pieces:
 *
 * - `normalizeError` turns `unknown` into a stable `{ name, message, stack?,
 *   code?, cause? }`. Missing fields are omitted (never emitted as
 *   `undefined`), a blank message falls back to the resolved name, both message
 *   and stack are truncated, and a nested `cause` is flattened to its message.
 * - `fingerprint` hashes the normalised error plus optional `route`/`action`,
 *   collapsing volatile ids (UUIDs, long hex, 3+ digit runs) and source line
 *   numbers so recurrences of one bug share a key.
 * - `shouldSample` maps a fingerprint to a fixed bucket and compares it to a
 *   clamped rate — deterministic, no RNG, and monotonic in the rate.
 * - `groupErrors` folds an event stream by fingerprint, tracking `count`,
 *   `firstSeen`, `lastSeen` and a bounded list of sample ids.
 * - `redactMessage` strips emails, credentials and file-system paths; the
 *   credential shapes come from the shared list in `value-scrubbing.ts`.
 * - `buildReport` derives a severity from a group's event count.
 * - `toBreadcrumb` produces a redacted, serialisable breadcrumb.
 *
 * Wiring this into a `/api/errors` sink is a follow-up; this module is the
 * additive, unit-pinned core.
 */

import { REDACTED, scrubSecretValues } from "./value-scrubbing";

/** Fallback message for a value that carries no usable text. */
export const UNKNOWN_MESSAGE = "Unknown error";

/** Marker that replaces a credential-shaped value. */
export { REDACTED };

/** Marker that replaces a redacted email address. */
export const EMAIL_MARKER = "<email>";

/** Marker that replaces a redacted file-system path. */
export const PATH_MARKER = "<path>";

/** Placeholder for a value that cannot be JSON-serialised (cycles, getters). */
const UNSERIALIZABLE = "[unserializable object]";

/** Message/stack caps: large enough to be useful, small enough to bound size. */
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_STACK_LENGTH = 8192;

/** Deepest `cause` chain followed before the message is taken as-is. */
const MAX_CAUSE_DEPTH = 2;

/** Most recent distinct event ids retained per group. */
export const MAX_SAMPLE_IDS = 5;

/** Lowest event count that reads as "medium" severity. */
export const SEVERITY_MEDIUM_AT = 5;

/** Lowest event count that reads as "high" severity. */
export const SEVERITY_HIGH_AT = 20;

/** Lowest event count that reads as "critical" severity. */
export const SEVERITY_CRITICAL_AT = 100;

/** A thrown value reduced to plain, serialisable fields. */
export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** Error/cause code (`ENOENT`, `503`, …) when the value carried one. */
  readonly code?: string;
  /** The nested `cause`'s message, flattened for storage. */
  readonly cause?: string;
}

/** Optional context folded into a fingerprint. */
export interface FingerprintOptions {
  /** Route the error occurred on (e.g. `/w/demo`). */
  readonly route?: string;
  /** Action being attempted when it failed (e.g. `save`). */
  readonly action?: string;
}

/** One captured error occurrence, as fed to `groupErrors`/`toBreadcrumb`. */
export interface ErrorEvent {
  /** Stable event id; used as a sample id, never for grouping. */
  readonly id?: string;
  /** The raw thrown value (anything — never assumed to be an `Error`). */
  readonly error: unknown;
  /** Route the error occurred on. */
  readonly route?: string;
  /** Action being attempted when it failed. */
  readonly action?: string;
  /** Epoch ms the event was captured; missing/non-finite values read as `0`. */
  readonly timestamp?: number;
  /** Pre-computed fingerprint; when absent it is derived from `error`. */
  readonly fingerprint?: string;
}

/** Repeats of one bug, folded under a shared fingerprint. */
export interface ErrorGroup {
  readonly fingerprint: string;
  readonly count: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** Up to {@link MAX_SAMPLE_IDS} distinct event ids, oldest first. */
  readonly sampleIds: readonly string[];
  readonly name: string;
  readonly message: string;
  readonly route?: string;
  readonly action?: string;
}

/** Triage severity derived from a group's event count. */
export type Severity = "low" | "medium" | "high" | "critical";

/** The triage report produced by `buildReport`. */
export interface ErrorReport {
  readonly fingerprint: string;
  readonly severity: Severity;
  readonly count: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly sampleIds: readonly string[];
  /** Redacted `Name: message (count)` one-liner. */
  readonly title: string;
}

/** Optional `data` payload attached to a breadcrumb. */
export interface BreadcrumbData {
  readonly fingerprint: string;
  readonly route?: string;
  readonly action?: string;
}

/** A redacted, serialisable breadcrumb for an event stream. */
export interface Breadcrumb {
  readonly category: "error";
  readonly level: "error";
  readonly message: string;
  readonly timestamp: number;
  readonly data: BreadcrumbData;
}

/** `text` cut to `max` characters, with an ellipsis marking the cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}

/** Read a property without letting a throwing getter escape. */
function readProp(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Whether `value` is a non-null object (arrays and functions included). */
function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Best-effort `String()` that never throws. */
function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** Best-effort `JSON.stringify` that never throws (cycles, getters, symbols). */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : safeToString(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** A non-blank string, or `undefined` for anything else. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Recursive core of `normalizeError`. `seen` guards self-referential `cause`
 * chains; `depth` caps how far a nested cause is followed.
 */
function normalizeErrorInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): NormalizedError {
  if (value === null || value === undefined) {
    return { name: "Error", message: UNKNOWN_MESSAGE };
  }

  if (typeof value === "string") {
    return {
      name: "Error",
      message: truncate(value.trim() === "" ? "Error" : value, MAX_MESSAGE_LENGTH),
    };
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { name: "Error", message: String(value) };
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return { name: "Error", message: truncate(safeToString(value), MAX_MESSAGE_LENGTH) };
  }

  if (!isObject(value)) {
    return { name: "Error", message: truncate(safeToString(value), MAX_MESSAGE_LENGTH) };
  }
  if (seen.has(value)) {
    return { name: "Error", message: UNSERIALIZABLE };
  }

  const rawName = readProp(value, "name");
  const rawMessage = readProp(value, "message");
  const errorLike = value instanceof Error || typeof rawMessage === "string";
  if (!errorLike) {
    return { name: "Error", message: truncate(safeStringify(value), MAX_MESSAGE_LENGTH) };
  }

  seen.add(value);
  const name = nonEmptyString(rawName) ?? "Error";
  const message = nonEmptyString(rawMessage) ?? name;
  const rawStack = readProp(value, "stack");
  const rawCode = readProp(value, "code");
  const rawCause = readProp(value, "cause");

  let cause: string | undefined;
  if (depth < MAX_CAUSE_DEPTH && rawCause !== null && rawCause !== undefined) {
    cause = normalizeErrorInternal(rawCause, depth + 1, seen).message;
  }

  seen.delete(value);

  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? nonEmptyString(String(rawCode))
      : undefined;

  return {
    name,
    message: truncate(message, MAX_MESSAGE_LENGTH),
    ...(nonEmptyString(rawStack) ? { stack: truncate(rawStack as string, MAX_STACK_LENGTH) } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * Reduce any thrown value to `{ name, message, stack?, code?, cause? }` without
 * throwing. Reads fields defensively so a throwing getter degrades to a
 * serialisation fallback, and only emits `stack`/`code`/`cause` when a usable
 * value was found.
 */
export function normalizeError(value: unknown): NormalizedError {
  try {
    return normalizeErrorInternal(value, 0, new WeakSet<object>());
  } catch {
    return { name: "Error", message: UNKNOWN_MESSAGE };
  }
}

/** Volatile fragments collapsed by `fingerprint` so one bug is one key. */
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PATTERN = /\b[0-9a-f]{8,}\b/gi;
const NUMBER_PATTERN = /\b\d{3,}\b/g;
const FILE_LINE_PATTERN =
  /(?<=\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs|json|css|html)):\d+(?::\d+)?/gi;

/** Canonicalise a string for hashing: volatile ids/lines out, whitespace flat. */
function normalizeForKey(text: string): string {
  return text
    .replace(UUID_PATTERN, "<id>")
    .replace(HEX_PATTERN, "<id>")
    .replace(FILE_LINE_PATTERN, "")
    .replace(NUMBER_PATTERN, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** 32-bit FNV-1a hash, seeded so two passes can be combined. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A 16-hex-digit hash: two independently-seeded FNV-1a passes. */
function hashHex(input: string): string {
  const first = fnv1a(input, 0x811c9dc5).toString(16).padStart(8, "0");
  const second = fnv1a(input, 0x9e3779b9).toString(16).padStart(8, "0");
  return `${first}${second}`;
}

/**
 * Stable grouping key for a thrown value plus optional context. Volatile ids
 * and source line numbers are collapsed, and stacks are not read at all, so
 * repeat occurrences of one bug map to one `fp_…` hash. Total: returns a string
 * for any input.
 */
export function fingerprint(
  error: unknown,
  options: FingerprintOptions = {},
): string {
  try {
    const { name, message } = normalizeError(error);
    const route = typeof options.route === "string" ? normalizeForKey(options.route) : "";
    const action = typeof options.action === "string" ? normalizeForKey(options.action) : "";
    const canonical = `${name}\u0000${normalizeForKey(message)}\u0000${route}\u0000${action}`;
    return `fp_${hashHex(canonical)}`;
  } catch {
    return "fp_00000000";
  }
}

/**
 * Decide whether to capture an event for `fingerprintValue`. The fingerprint is
 * mapped to a fixed bucket in `[0, 1)` and compared to `rate` (clamped to
 * `[0, 1]`), so the same fingerprint always yields the same decision for a
 * given rate and increasing the rate can only add captures — no RNG, no clock.
 */
export function shouldSample(fingerprintValue: string, rate: number): boolean {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return false;
  const clamped = Math.min(1, Math.max(0, rate));
  if (clamped <= 0) return false;
  if (clamped >= 1) return true;
  const key = typeof fingerprintValue === "string" ? fingerprintValue : safeToString(fingerprintValue);
  const bucket = fnv1a(key, 0x811c9dc5) / 0x1_0000_0000;
  return bucket < clamped;
}

/** Mutable accumulator used while folding events into groups. */
interface MutableGroup {
  fingerprint: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  sampleIds: string[];
  seenIds: Set<string>;
  name: string;
  message: string;
  route?: string;
  action?: string;
}

/**
 * Fold an event stream into one `ErrorGroup` per fingerprint, tracking `count`,
 * `firstSeen` (min timestamp), `lastSeen` (max timestamp) and up to
 * {@link MAX_SAMPLE_IDS} distinct sample ids. Missing/non-finite timestamps
 * read as `0`. Groups are returned most-frequent first, ties broken by recency
 * then fingerprint, so the order is deterministic. Never throws.
 */
export function groupErrors(events: readonly ErrorEvent[]): readonly ErrorGroup[] {
  const groups = new Map<string, MutableGroup>();
  if (!Array.isArray(events)) return [];

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const route = typeof event.route === "string" ? event.route : undefined;
    const action = typeof event.action === "string" ? event.action : undefined;
    const key =
      nonEmptyString(event.fingerprint) ??
      fingerprint(event.error, { route, action });
    const timestamp =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : 0;

    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (timestamp < existing.firstSeen) existing.firstSeen = timestamp;
      if (timestamp > existing.lastSeen) existing.lastSeen = timestamp;
      const id = nonEmptyString(event.id);
      if (id !== undefined && !existing.seenIds.has(id) && existing.sampleIds.length < MAX_SAMPLE_IDS) {
        existing.sampleIds.push(id);
        existing.seenIds.add(id);
      }
      continue;
    }

    const normalized = normalizeError(event.error);
    const id = nonEmptyString(event.id);
    groups.set(key, {
      fingerprint: key,
      count: 1,
      firstSeen: timestamp,
      lastSeen: timestamp,
      sampleIds: id !== undefined ? [id] : [],
      seenIds: new Set(id !== undefined ? [id] : []),
      name: normalized.name,
      message: normalized.message,
      ...(route !== undefined ? { route } : {}),
      ...(action !== undefined ? { action } : {}),
    });
  }

  const list = [...groups.values()];
  list.sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeen - a.lastSeen ||
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
  );

  return list.map((group) => ({
    fingerprint: group.fingerprint,
    count: group.count,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    sampleIds: group.sampleIds,
    name: group.name,
    message: group.message,
    ...(group.route !== undefined ? { route: group.route } : {}),
    ...(group.action !== undefined ? { action: group.action } : {}),
  }));
}

/** Email addresses anywhere in a message. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Absolute Windows (`C:\Users\…`) and Unix (`/home/…`) file paths. */
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'<>|]+/g;
const UNIX_PATH_PATTERN = /(?<![:\w/])(?:\/[\w.@-]+){2,}\/?/g;

/**
 * Strip emails, credentials and file-system paths from a message so free-text
 * error output is safe to persist. Idempotent and total: a value that is not a
 * string is coerced once, and the function never throws. The credential shapes
 * come from the shared list in `value-scrubbing.ts`.
 */
export function redactMessage(message: string): string {
  const text = typeof message === "string" ? message : safeToString(message);
  try {
    return scrubSecretValues(text)
      .replace(EMAIL_PATTERN, EMAIL_MARKER)
      .replace(WINDOWS_PATH_PATTERN, PATH_MARKER)
      .replace(UNIX_PATH_PATTERN, PATH_MARKER);
  } catch {
    return text;
  }
}

/** Map an event count to its triage severity. */
export function severityForCount(count: number): Severity {
  const value =
    typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (value >= SEVERITY_CRITICAL_AT) return "critical";
  if (value >= SEVERITY_HIGH_AT) return "high";
  if (value >= SEVERITY_MEDIUM_AT) return "medium";
  return "low";
}

/**
 * Build the triage report for a group: identity and timing carried through, a
 * severity derived from `count`, and a redacted `Name: message (count)` title.
 * Total: fits hostile input and never throws.
 */
export function buildReport(group: ErrorGroup): ErrorReport {
  try {
    const count =
      typeof group.count === "number" && Number.isFinite(group.count)
        ? Math.max(0, Math.floor(group.count))
        : 0;
    return {
      fingerprint: group.fingerprint,
      severity: severityForCount(count),
      count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      sampleIds: Array.isArray(group.sampleIds) ? group.sampleIds : [],
      title: redactMessage(`${group.name}: ${group.message} (${count})`),
    };
  } catch {
    return {
      fingerprint: "fp_00000000",
      severity: "low",
      count: 0,
      firstSeen: 0,
      lastSeen: 0,
      sampleIds: [],
      title: UNKNOWN_MESSAGE,
    };
  }
}

/**
 * Turn one captured event into a redacted, serialisable breadcrumb. The
 * fingerprint is taken from the event when present, otherwise derived from the
 * error plus its route/action; the message is scrubbed with `redactMessage`.
 * Total: never throws.
 */
export function toBreadcrumb(event: ErrorEvent): Breadcrumb {
  try {
    const route = typeof event.route === "string" ? event.route : undefined;
    const action = typeof event.action === "string" ? event.action : undefined;
    const key =
      nonEmptyString(event.fingerprint) ??
      fingerprint(event.error, { route, action });
    const normalized = normalizeError(event.error);
    const timestamp =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : 0;
    return {
      category: "error",
      level: "error",
      message: redactMessage(`${normalized.name}: ${normalized.message}`),
      timestamp,
      data: {
        fingerprint: key,
        ...(route !== undefined ? { route } : {}),
        ...(action !== undefined ? { action } : {}),
      },
    };
  } catch {
    return {
      category: "error",
      level: "error",
      message: UNKNOWN_MESSAGE,
      timestamp: 0,
      data: { fingerprint: "fp_00000000" },
    };
  }
}
