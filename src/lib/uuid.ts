/**
 * UUID helpers — the pure half of identifier handling.
 *
 * Generation wraps Node's `crypto`: `uuidv4` is a plain random v4, while
 * `uuidv7` is time-ordered (RFC 9562) and takes an injected timestamp so its
 * 48-bit time prefix is deterministic and replayable in tests. Inspection
 * (`isUuid`, `parseUuid`, `normalizeUuid`, `isUuidV7`) is deliberately
 * defensive over untrusted input and accepts the common wire forms — canonical,
 * braced, compact 32-char hex, raw 16-byte binary and `urn:uuid:` — in any
 * case, but only RFC 4122 UUIDs of versions 1 through 7 with the RFC variant.
 *
 * Everything here is pure and deterministic when a timestamp is supplied: no
 * DB, requests, React or ambient clock beyond `uuidv4`/`uuidv7` defaults.
 */

import { randomBytes, randomUUID } from "node:crypto";

/** The UUID versions this module recognises: 1 (time) through 7 (Unix time). */
export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Lowest recognised version. */
export const MIN_UUID_VERSION = 1;
/** Highest recognised version. */
export const MAX_UUID_VERSION = 7;

/**
 * Largest value the 48-bit millisecond field of a uuidv7 can hold. The whole
 * range fits in a JS number (`2^48 - 1 < Number.MAX_SAFE_INTEGER`), so no
 * BigInt is needed.
 */
export const UUID_V7_MAX_TIMESTAMP = 2 ** 48 - 1;

/**
 * Why a value could not be parsed: empty/nullish input, a value that is not
 * UUID-shaped (wrong length, non-hex characters, an unsupported variant), or a
 * structurally valid UUID of a version outside 1–7.
 */
export type UuidParseError = "empty" | "malformed" | "unsupported_version";

/** A successfully parsed UUID. */
export interface ParsedUuid {
  readonly ok: true;
  /** Lowercase canonical `8-4-4-4-12` form. */
  readonly canonical: string;
  /** The decoded version nibble (1–7). */
  readonly version: UuidVersion;
  /** The 16 raw bytes, big-endian, in canonical field order. */
  readonly bytes: Uint8Array;
}

/** Result of {@link parseUuid}: the decoded UUID, or the first failure reason. */
export type UuidParseResult =
  | ParsedUuid
  | { readonly ok: false; readonly error: UuidParseError };

/** Exactly 32 lowercase hex characters, the canonical field payload. */
const HEX32 = /^[0-9a-f]{32}$/;

/** RFC 4122 variant: the top two bits of nibble 16 are `10` (`8`–`b`). */
const RFC_VARIANT_MASK = 0b1100;
const RFC_VARIANT_VALUE = 0b1000;

/**
 * Reduce any accepted input form to 32 lowercase hex characters, or `null`.
 *
 * Strings may carry an optional `urn:uuid:` scheme and/or one pair of wrapping
 * braces; hyphens are stripped so canonical and compact forms are equivalent.
 * A {@link Uint8Array} of exactly 16 bytes is treated as the raw binary form.
 * Surrounding whitespace is not tolerated — a padded value is malformed.
 */
function toHex(value: unknown): string | null {
  if (value instanceof Uint8Array) {
    if (value.length !== 16) return null;
    let hex = "";
    for (let i = 0; i < value.length; i += 1) {
      hex += value[i].toString(16).padStart(2, "0");
    }
    return hex;
  }
  if (typeof value !== "string") return null;
  if (value.trim() === "") return null;

  let body = value;
  if (/^urn:uuid:/i.test(body)) body = body.slice("urn:uuid:".length);
  if (body.startsWith("{") && body.endsWith("}")) body = body.slice(1, -1);

  const compact = body.replace(/-/g, "").toLowerCase();
  return HEX32.test(compact) ? compact : null;
}

/** Render a 32-char hex payload as canonical `8-4-4-4-12` lowercase. */
function formatCanonical(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

/**
 * Whether `value` is a UUID of a supported version (1–7) with the RFC 4122
 * variant, in canonical, braced, compact-hex, binary or `urn:uuid:` form, any
 * case. Any non-string (other than a 16-byte `Uint8Array`) or unknown version
 * is `false`, never a throw.
 */
export function isUuid(value: unknown): boolean {
  return parseUuid(value).ok;
}

/**
 * Parse `value` into its canonical form, version and bytes.
 *
 * Returns a {@link UuidParseResult} rather than throwing, so callers can
 * distinguish empty, malformed and unsupported-version input.
 */
export function parseUuid(value: unknown): UuidParseResult {
  if (value === null || value === undefined) return { ok: false, error: "empty" };
  if (typeof value === "string" && value.trim() === "") {
    return { ok: false, error: "empty" };
  }

  const hex = toHex(value);
  if (hex === null) return { ok: false, error: "malformed" };

  const version = Number.parseInt(hex[12], 16);
  const variant = Number.parseInt(hex[16], 16);
  if (version < MIN_UUID_VERSION || version > MAX_UUID_VERSION) {
    return { ok: false, error: "unsupported_version" };
  }
  if ((variant & RFC_VARIANT_MASK) !== RFC_VARIANT_VALUE) {
    return { ok: false, error: "malformed" };
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return {
    ok: true,
    canonical: formatCanonical(hex),
    version: version as UuidVersion,
    bytes,
  };
}

/**
 * Canonicalise `value` to lowercase `8-4-4-4-12`, or `null` when it is not a
 * supported UUID. Idempotent: normalising a canonical value returns it
 * unchanged.
 */
export function normalizeUuid(value: unknown): string | null {
  const parsed = parseUuid(value);
  return parsed.ok ? parsed.canonical : null;
}

/** Whether `value` is specifically a version 7 UUID. */
export function isUuidV7(value: unknown): boolean {
  const parsed = parseUuid(value);
  return parsed.ok && parsed.version === 7;
}

/** Mint a random version 4 UUID in canonical lowercase form. */
export function uuidv4(): string {
  return randomUUID();
}

/** Resolve an injected uuidv7 timestamp, rejecting anything off the 48-bit grid. */
function resolveTimestamp(at: number | Date | undefined): number {
  const ms = at instanceof Date ? at.getTime() : (at ?? Date.now());
  if (!Number.isInteger(ms) || ms < 0 || ms > UUID_V7_MAX_TIMESTAMP) {
    throw new RangeError(
      `uuidv7 timestamp must be an integer in [0, ${UUID_V7_MAX_TIMESTAMP}] ms (got ${ms}).`,
    );
  }
  return ms;
}

/**
 * Mint a time-ordered version 7 UUID in canonical lowercase form.
 *
 * The first 48 bits are `at` milliseconds since the Unix epoch; the remaining
 * bits are random. Ordering by `at` therefore orders the resulting strings
 * lexicographically. `at` defaults to the current clock; pass a number or a
 * `Date` for a deterministic prefix. A timestamp that is not an integer within
 * `[0, UUID_V7_MAX_TIMESTAMP]` throws a `RangeError`.
 */
export function uuidv7(at?: number | Date): string {
  let ms = resolveTimestamp(at);
  const bytes = randomBytes(16);

  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  return formatCanonical(bytes.toString("hex"));
}
