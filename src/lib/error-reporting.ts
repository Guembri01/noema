/**
 * Error tracking — pure core (docs/FEATURE_MATRIX.md "Error tracking").
 *
 * The planned error-tracking panel needs a framework-free heart it can share
 * between the browser error boundary (`src/app/error.tsx`, which already types
 * the Next.js `digest`) and any future server/route handler. This module is
 * that heart: it never touches Prisma, React or the network, and every helper
 * is total — given any thrown value (an `Error`, a bare string, `null`, a
 * circular record, a hostile getter or a throwing proxy) it returns a value
 * instead of throwing. That is the whole point: error reporting must not throw
 * while reporting an error.
 *
 * The pieces:
 *
 * - `normalizeError` turns `unknown` into a stable `{ name, message, stack?,
 *   digest? }`. Missing fields are omitted (never emitted as `undefined`), a
 *   blank message falls back to the resolved name, and both message and stack
 *   are truncated so one runaway error cannot blow up a payload.
 * - `redactSecrets` scrubs credentials before anything leaves the process. It
 *   is key-based (a deliberately over-broad substring match, plus caller
 *   `redactKeys`) AND value-based (Bearer/Basic/JWT/`sk-`/`ghp_`/`xox`/`AKIA`
 *   shapes and credential query params — the shared list in
 *   `value-scrubbing.ts`), cycle-safe and depth-capped, and never mutates its
 *   input.
 * - `dedupeKey` groups repeats: it ignores stack traces and collapses volatile
 *   ids (UUIDs, long hex runs, 3+ digit runs) so the same bug maps to one key.
 * - `sampleRate` is a pure comparison, clamped to `[0, 1]`; the draw is passed
 *   in by the caller, so there is no clock or RNG hidden here.
 * - `buildReport` composes the above and redacts the error fields too, since a
 *   token can just as easily be in "failed to authenticate with Bearer …" as
 *   in a context value.
 *
 * Wiring this into `error.tsx` and a `/api/errors` sink is a follow-up; this
 * module is the additive, unit-pinned core.
 */

import { REDACTED, scrubSecretValues } from "./value-scrubbing";

/** Shape `parseDatabaseJson`-style version tag, stamped on every report. */
export const REPORT_SCHEMA_VERSION = 1;

/** Marker that replaces a value whose key is secret-shaped. */
export { REDACTED };

/** Marker for a back-reference that would otherwise recurse forever. */
export const CIRCULAR = "[circular]";

/** Marker for a value dropped because it exceeded the depth cap. */
export const TRUNCATED = "[truncated]";

/** Fallback message for a value that carries no usable text. */
export const UNKNOWN_MESSAGE = "Unknown error";

/** Placeholder for a value that cannot be JSON-serialised (cycles, getters). */
const UNSERIALIZABLE = "[unserializable object]";

/** Message/stack caps: large enough to be useful, small enough to bound size. */
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_STACK_LENGTH = 8192;

/** Longest `dedupeKey` returned before it is elided with an ellipsis. */
export const MAX_DEDUPE_KEY_LENGTH = 300;

/** Default recursion depth for `redactSecrets`. */
export const DEFAULT_MAX_DEPTH = 6;

/** A thrown value reduced to plain, serialisable fields. */
export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** Next.js server-render digest, when the framework attached one. */
  readonly digest?: string;
}

/** Options for `redactSecrets`. */
export interface RedactOptions {
  /**
   * Extra key names treated as secret, matched by exact lowercased equality.
   * The built-in rules are far broader (substring); this adds precision for
   * names the built-ins do not cover (e.g. `ssn`).
   */
  readonly redactKeys?: readonly string[];
  /** Maximum object depth walked before values become `TRUNCATED`. */
  readonly maxDepth?: number;
}

/** The serialisable fault report produced by `buildReport`. */
export interface ErrorReport {
  readonly schemaVersion: number;
  readonly dedupeKey: string;
  readonly error: NormalizedError;
  /** Redacted caller context; shape is intentionally open. */
  readonly context: unknown;
}

/**
 * Keys whose value never leaves the process. Matched by substring on purpose:
 * over-redacting a field called `tokenCount` is preferable to leaking a real
 * `token`, and the rule is trivial to reason about. Mirrors the intent of
 * `SECRET_KEY_PATTERN` in `json-export.ts`.
 */
const SECRET_KEY_PATTERN =
  /(password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential|session[_-]?id)/i;

/** Volatile fragments collapsed by `dedupeKey` so one bug is one group. */
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PATTERN = /\b[0-9a-f]{8,}\b/gi;
const NUMBER_PATTERN = /\b\d{3,}\b/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `text` cut to `max` characters, with an ellipsis marking the cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}

/** Best-effort stringify that never throws (cycles, functions, symbols). */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Reduce any thrown value to `{ name, message, stack?, digest? }` without
 * throwing. Reads `name`/`message`/`stack`/`digest` defensively so a throwing
 * getter degrades to a serialisation fallback. `stack`/`digest` are only
 * present when a non-empty string was found.
 */
export function normalizeError(value: unknown): NormalizedError {
  if (value === null || value === undefined) {
    return { name: "Error", message: UNKNOWN_MESSAGE };
  }

  if (typeof value === "string") {
    return {
      name: "Error",
      message: truncate(value.trim() === "" ? "Error" : value, MAX_MESSAGE_LENGTH),
    };
  }

  let rawName: unknown;
  let rawMessage: unknown;
  let rawStack: unknown;
  let rawDigest: unknown;
  try {
    if (isRecord(value)) {
      rawName = value.name;
      rawMessage = value.message;
      rawStack = value.stack;
      rawDigest = value.digest;
    }
  } catch {
    // A throwing getter: fall through to the serialisation branch.
  }

  const hasMessage = typeof rawMessage === "string";
  if (hasMessage || value instanceof Error) {
    const name =
      typeof rawName === "string" && rawName.trim() !== "" ? rawName : "Error";
    const message =
      hasMessage && (rawMessage as string).trim() !== ""
        ? (rawMessage as string)
        : name;
    return {
      name,
      message: truncate(message, MAX_MESSAGE_LENGTH),
      ...(typeof rawStack === "string" && rawStack !== ""
        ? { stack: truncate(rawStack, MAX_STACK_LENGTH) }
        : {}),
      ...(typeof rawDigest === "string" && rawDigest !== ""
        ? { digest: rawDigest }
        : {}),
    };
  }

  return {
    name: "Error",
    message: truncate(safeStringify(value), MAX_MESSAGE_LENGTH),
  };
}

function isSecretKey(key: string, extra: ReadonlySet<string>): boolean {
  return SECRET_KEY_PATTERN.test(key) || extra.has(key.toLowerCase());
}

interface WalkContext {
  readonly redactKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly seen: WeakSet<object>;
}

function walk(value: unknown, depth: number, context: WalkContext): unknown {
  if (typeof value === "string") return scrubSecretValues(value);
  if (value === null || typeof value !== "object") return value;
  if (context.seen.has(value)) return CIRCULAR;
  if (depth > context.maxDepth) return TRUNCATED;

  context.seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => walk(item, depth + 1, context));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSecretKey(key, context.redactKeys)
        ? REDACTED
        : walk(entry, depth + 1, context);
    }
    result = out;
  }
  context.seen.delete(value);
  return result;
}

/**
 * Deep-copy `payload` with secrets removed: secret-shaped keys (and any
 * `options.redactKeys`) become `REDACTED`, and credential-shaped substrings in
 * string values are scrubbed. Cycle-safe, depth-capped (values past
 * `maxDepth` become `TRUNCATED`), input never mutated. If walking fails on a
 * hostile object the whole payload fails closed to `REDACTED` rather than
 * leaking — and this function never throws.
 */
export function redactSecrets(
  payload: unknown,
  options: RedactOptions = {},
): unknown {
  const context: WalkContext = {
    redactKeys: new Set(
      (options.redactKeys ?? []).map((key) => key.toLowerCase()),
    ),
    maxDepth:
      typeof options.maxDepth === "number" && Number.isFinite(options.maxDepth)
        ? Math.max(0, Math.floor(options.maxDepth))
        : DEFAULT_MAX_DEPTH,
    seen: new WeakSet<object>(),
  };
  try {
    return walk(payload, 0, context);
  } catch {
    // Fail closed: an object we cannot inspect is an object we cannot scrub.
    return REDACTED;
  }
}

/** Collapse volatile ids so recurrences of one bug share a grouping key. */
function normalizeForGrouping(message: string): string {
  return message
    .replace(UUID_PATTERN, "<uuid>")
    .replace(HEX_PATTERN, "<hex>")
    .replace(NUMBER_PATTERN, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic grouping key for an error: the resolved name plus its message
 * with volatile ids collapsed. Stack traces and digests are deliberately
 * ignored — they differ per occurrence and would defeat deduplication.
 */
export function dedupeKey(error: unknown): string {
  const { name, message } = normalizeError(error);
  const key = `${name}: ${normalizeForGrouping(message)}`;
  return key.length > MAX_DEDUPE_KEY_LENGTH
    ? `${key.slice(0, MAX_DEDUPE_KEY_LENGTH - 1)}\u2026`
    : key;
}

/**
 * Decide whether to capture an event: true when the caller-supplied draw `rand`
 * (a value in `[0, 1)`) falls below `rate`. Pure and deterministic — the draw
 * is passed in, so there is no hidden RNG. `rate` is clamped to `[0, 1]` and a
 * non-finite rate or draw is treated as `0`/a miss.
 */
export function sampleRate(rate: number, rand: number): boolean {
  const clamped = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
  if (clamped <= 0) return false;
  if (clamped >= 1) return true;
  return Number.isFinite(rand) && rand < clamped;
}

/** Redact a normalized error field-by-field, preserving its exact shape. */
function redactNormalizedError(error: NormalizedError): NormalizedError {
  const scrubbed = redactSecrets(error);
  if (typeof scrubbed === "object" && scrubbed !== null && !Array.isArray(scrubbed)) {
    const record = scrubbed as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : error.name,
      message: typeof record.message === "string" ? record.message : error.message,
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
      ...(typeof record.digest === "string" ? { digest: record.digest } : {}),
    };
  }
  return error;
}

/**
 * Build the serialisable report for a thrown value plus caller context:
 * schema version, dedupe key (computed from the raw error, so redaction cannot
 * shift grouping), the normalized error (redacted), and the redacted context.
 * Total: returns a typed report for any input and never throws.
 */
export function buildReport(error: unknown, context: unknown = {}): ErrorReport {
  try {
    const normalized = normalizeError(error);
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      dedupeKey: dedupeKey(error),
      error: redactNormalizedError(normalized),
      context: redactSecrets(context),
    };
  } catch {
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      dedupeKey: "Error: Unknown error",
      error: { name: "Error", message: UNKNOWN_MESSAGE },
      context: REDACTED,
    };
  }
}
