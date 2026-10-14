import { randomInt } from "node:crypto";

/**
 * Short share links — the pure code space behind `/s/<code>` style URLs.
 *
 * A short code is a fixed-width base62 token. The functions here are
 * side-effect free (the only impure branch is the unseeded generator, which
 * draws from the CSPRNG so codes are not enumerable); the storage/DB lookup
 * that turns a code into a document is deliberately *not* here — callers pass
 * an `exists` probe to `withCollisionRetry`, which keeps this module unit-
 * testable and free of a prisma dependency.
 *
 * Seeded generation is deterministic: the same seed yields the same code, so
 * tests and fixtures can pin allocations without stubbing the RNG.
 */

/** base62, in the conventional `0-9A-Za-z` order. */
export const SHORT_CODE_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Default code width. 62^7 ≈ 3.5e12, plenty for a self-hosted deployment. */
export const SHORT_CODE_LENGTH = 7;

/**
 * Codes shorter than this are rejected by `isValidShortCode` — below ~4 chars
 * the space is small enough to enumerate and collides with real paths.
 */
export const MIN_SHORT_CODE_LENGTH = 4;

/** Upper bound so a bad caller cannot mint unbounded tokens. */
export const MAX_SHORT_CODE_LENGTH = 32;

/**
 * Words that must never be handed out as short codes, because they shadow an
 * existing route (`/admin`, `/api`, static assets, …). Matching is exact and
 * case-sensitive: the alphabet is case-sensitive, so `Admin` is a distinct,
 * non-reserved code.
 */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "assets",
  "auth",
  "dashboard",
  "health",
  "help",
  "login",
  "logout",
  "new",
  "settings",
  "signup",
  "static",
  "status",
  "support",
]);

/** Fixed radix for base62. */
const BASE = 62;

/**
 * Encode a non-negative safe integer as a base62 string (`0` → `"0"`, `62` →
 * `"10"`). Rejects negatives and non-integers rather than silently mangling
 * them, since callers use this to derive seeds and offsets.
 */
export function base62(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`base62 expects a non-negative safe integer, got ${n}`);
  }
  if (n === 0) return SHORT_CODE_ALPHABET[0]!;
  let value = n;
  let out = "";
  while (value > 0) {
    out = SHORT_CODE_ALPHABET[value % BASE]! + out;
    value = Math.floor(value / BASE);
  }
  return out;
}

/** FNV-1a over the string form of a seed → 32-bit unsigned integer. */
function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * mulberry32: a small, fast, fully deterministic PRNG. Enough for fixtures —
 * *not* a security primitive, which is why unseeded generation uses
 * `crypto.randomInt` instead.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GenerateShortCodeOptions = {
  /** Code width. Defaults to `SHORT_CODE_LENGTH`. */
  length?: number;
  /**
   * When present, generation is deterministic (same seed → same code). When
   * omitted, each character is drawn from the CSPRNG.
   */
  seed?: string | number;
};

function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`short code length must be a positive integer, got ${length}`);
  }
}

/** Map a uniform [0,1) draw onto the alphabet. */
function charAt(rand: number): string {
  return SHORT_CODE_ALPHABET[Math.floor(rand * BASE) % BASE]!;
}

function buildCode(length: number, rand: () => number): string {
  let code = "";
  for (let i = 0; i < length; i += 1) code += charAt(rand());
  return code;
}

/**
 * Generate a short code. With a `seed` the result is deterministic; without
 * one it is drawn from `crypto.randomInt`, so codes are unguessable. Reserved
 * words are never returned: a blocked draw advances the deterministic stream
 * (or redraws) and tries again.
 */
export function generateShortCode(options: GenerateShortCodeOptions = {}): string {
  const length = options.length ?? SHORT_CODE_LENGTH;
  assertLength(length);

  if (options.seed === undefined) {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const code = Array.from({ length }, () =>
        charAt(randomInt(0, BASE) / BASE),
      ).join("");
      if (!RESERVED_CODES.has(code)) return code;
    }
    // 1000 reserved draws in a row is statistically impossible (and would
    // require the CSPRNG to be broken); surface it rather than loop forever.
    throw new Error("Could not generate a non-reserved short code");
  }

  const base = hashSeed(options.seed);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    // Vary the stream per attempt so a reserved first draw can still recover.
    const code = buildCode(length, mulberry32((base + attempt) >>> 0));
    if (!RESERVED_CODES.has(code)) return code;
  }
  throw new Error("Could not generate a non-reserved short code");
}

/**
 * Validate an externally supplied code: base62 charset, within the length
 * bounds, and not reserved. Non-strings (untrusted input) are rejected.
 */
export function isValidShortCode(code: string): boolean {
  if (typeof code !== "string") return false;
  if (code.length < MIN_SHORT_CODE_LENGTH || code.length > MAX_SHORT_CODE_LENGTH) {
    return false;
  }
  if (!/^[0-9A-Za-z]+$/.test(code)) return false;
  return !RESERVED_CODES.has(code);
}

export type CodeGenerator = () => string;
export type CodeExists = (code: string) => boolean;

export type CollisionRetryOptions = {
  /** How many times to call `generate` before giving up. Defaults to 5. */
  maxAttempts?: number;
};

/** Default retry budget; 5 draws already make collisions vanishingly rare. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Allocate a code that neither the store (`exists`) nor the reserved list
 * claims. Calls `generate` up to `maxAttempts` times; reserved codes are
 * skipped without consulting the store. Throws once the budget is spent so a
 * saturated space fails loudly instead of returning a duplicate.
 */
export function withCollisionRetry(
  generate: CodeGenerator,
  exists: CodeExists,
  options: CollisionRetryOptions = {},
): string {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `maxAttempts must be a positive integer, got ${maxAttempts}`,
    );
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generate();
    if (RESERVED_CODES.has(code)) continue;
    if (!exists(code)) return code;
  }
  throw new Error(
    `Could not generate a unique short code after ${maxAttempts} attempts`,
  );
}

/**
 * Build the public URL for a code. Tolerant of a trailing slash on the base
 * and a leading slash on the code, so callers can pass either shape.
 */
export function shortUrl(baseUrl: string, code: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = code.replace(/^\/+/, "");
  return `${base}/${path}`;
}
