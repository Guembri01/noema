import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure, dependency-free webhook payload signing (Stripe-style, timestamped and
 * versioned). No prisma, no network, no React — safe to import from either the
 * server dispatch path or a unit test.
 *
 * Header format:
 *
 *     t=<unixMs>,<scheme>=<hex>
 *
 * where `<hex> = HMAC-SHA256(secret, "<unixMs>.<body>")`. The timestamp is bound
 * into the MAC, so a captured signature cannot be re-stamped to defeat the
 * freshness window (see docs/specs/integrations-api.md, D24 signature format).
 */

export type SignaturePayload = string | Record<string, unknown>;

export interface SignOptions {
  /** Unix milliseconds bound into the MAC. Defaults to `Date.now()`. */
  timestamp?: number;
  /** Signature scheme label. Defaults to `"v1"`. */
  scheme?: string;
}

export interface VerifyOptions {
  /** Freshness window in seconds (symmetric around `now`). Defaults to 300. */
  toleranceSeconds?: number;
  /** Unix milliseconds treated as "now". Defaults to `Date.now()`. */
  now?: number;
}

export type VerifyFailureReason = "bad_format" | "no_match" | "expired" | "future";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export type ParseSignatureResult =
  | { ok: true; timestamp: number; signatures: Record<string, string[]> }
  | { ok: false; reason: "bad_format" };

/** Recursively sort object keys so equivalent payloads hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON for the signed body: strings pass through untouched; objects
 * are serialised with recursively sorted keys so key ordering never changes the
 * signature.
 */
export function canonicalJson(payload: SignaturePayload): string {
  return typeof payload === "string" ? payload : JSON.stringify(canonicalize(payload));
}

/** Constant-time string comparison, safe when lengths differ. */
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Constant-time comparison of two hex digests. Case-insensitive; a length
 * mismatch short-circuits to `false` without ever calling `timingSafeEqual`
 * with unequal buffers (which would throw).
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length !== right.length) return false;
  return secureCompare(left, right);
}

function hmacHex(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Sign a payload, returning the value for the signature header —
 * `t=<ts>,<scheme>=<hex>`.
 */
export function signPayload(
  payload: SignaturePayload,
  secret: string,
  options: SignOptions = {},
): string {
  const timestamp = options.timestamp ?? Date.now();
  const scheme = options.scheme ?? "v1";
  const body = canonicalJson(payload);
  return `t=${timestamp},${scheme}=${hmacHex(secret, timestamp, body)}`;
}

/**
 * Parse a signature header tolerantly: surrounding/embedded whitespace is
 * ignored and repeated scheme keys accumulate into a list (`v1=a,v1=b` ⇒
 * `{ v1: ["a", "b"] }`). A missing/non-numeric `t` or a header with no
 * signatures at all is a `bad_format`.
 */
export function parseSignatureHeader(
  header: string | null | undefined,
): ParseSignatureResult {
  if (typeof header !== "string" || header.trim() === "") {
    return { ok: false, reason: "bad_format" };
  }

  let timestamp: number | null = null;
  const signatures: Record<string, string[]> = {};

  for (const rawPart of header.split(",")) {
    const part = rawPart.trim();
    if (part === "") continue;

    const separator = part.indexOf("=");
    if (separator <= 0) return { ok: false, reason: "bad_format" };

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "" || value === "") return { ok: false, reason: "bad_format" };

    if (key === "t") {
      if (!/^\d+$/.test(value)) return { ok: false, reason: "bad_format" };
      timestamp = Number(value);
      continue;
    }

    (signatures[key] ??= []).push(value);
  }

  if (timestamp === null || Object.keys(signatures).length === 0) {
    return { ok: false, reason: "bad_format" };
  }

  return { ok: true, timestamp, signatures };
}

/**
 * Verify a payload against a signature header.
 *
 * Order of checks: format → freshness → MAC. Freshness is rejected before the
 * MAC so a stale (or future-dated) header never gets a signature oracle; the
 * boundary is inclusive (`|now − t| === tolerance` still verifies).
 */
export function verifySignature(
  payload: SignaturePayload,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): VerifyResult {
  const toleranceMs = (options.toleranceSeconds ?? 300) * 1000;
  const now = options.now ?? Date.now();

  const parsed = parseSignatureHeader(header);
  if (!parsed.ok) return { ok: false, reason: "bad_format" };

  const age = now - parsed.timestamp;
  if (age > toleranceMs) return { ok: false, reason: "expired" };
  if (age < -toleranceMs) return { ok: false, reason: "future" };

  const expected = hmacHex(secret, parsed.timestamp, canonicalJson(payload));
  const candidates = Object.values(parsed.signatures).flat();
  const matched = candidates.some((candidate) => constantTimeEqualHex(candidate, expected));
  if (!matched) return { ok: false, reason: "no_match" };

  return { ok: true };
}
