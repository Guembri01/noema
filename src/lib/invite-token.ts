import { randomBytes } from "node:crypto";

/**
 * The digest an invite token is stored under — the *same* one the server uses
 * to mint and verify, re-exported rather than reimplemented. See the module
 * note below.
 */
export { hashToken } from "@/lib/secrets";

/**
 * Invite tokens — the pure half of self-serve invite links.
 *
 * A raw token is minted once (`generateInviteToken`), embedded in a link and
 * emailed. Only its digest is persisted ({@link hashToken}), so a database dump
 * cannot be replayed as a live invite. That digest is **re-exported from
 * `@/lib/secrets`**, not reimplemented: the server mints and verifies invites
 * with the domain-separated `sha256("noema:token:" + token)`, and this module
 * used to carry its own bare `sha256(token)` — digests that no stored invite
 * could ever be matched against. Redemption is gated by three independent facts
 * — expiry, an already-used marker and a redemption budget (`canRedeem`) — and
 * the raw token is never echoed back to a UI (`maskToken`, which mirrors
 * `maskSecret`).
 *
 * Everything here is pure and deterministic over Node's `crypto` builtin: no
 * DB, requests, React or ambient clock — callers pass `now` explicitly so the
 * same invite can be replayed against a fixed timeline in tests. Storage,
 * email and route wiring are follow-ups; this module is the logic they share.
 */

/** Default entropy for a fresh token: 32 bytes (256 bits, 43 base64url chars). */
export const DEFAULT_TOKEN_BYTES = 32;
/** Smallest accepted token: 16 bytes ≈ 128 bits of entropy (22 base64url chars). */
export const MIN_TOKEN_BYTES = 16;
/** Largest accepted token, so a stored value can never grow without bound. */
export const MAX_TOKEN_BYTES = 128;

/** Minimum well-formed token length: the base64url length of 16 bytes. */
export const MIN_TOKEN_LENGTH = 22;
/** Maximum well-formed token length: the base64url length of 128 bytes. */
export const MAX_TOKEN_LENGTH = 171;

/** Default redemption budget for an invite (`maxUses`). */
export const DEFAULT_MAX_USES = 1;

/**
 * Unpadded base64url alphabet (`-`/`_` in place of `+`/`/`, no `=`), which is
 * URL- and filename-safe. Standard-base64 characters and padding are rejected
 * so a token cannot silently round-trip through a different codec.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface GenerateInviteTokenOptions {
  /** Entropy in bytes; defaults to {@link DEFAULT_TOKEN_BYTES}. */
  readonly bytes?: number;
}

/**
 * Mint a new raw invite token as unpadded base64url. The result is URL-safe
 * and, unlike a UUID, carries full cryptographic entropy — callers should
 * email it once and store only {@link hashToken}.
 *
 * `bytes` is validated (integer within {@link MIN_TOKEN_BYTES}…
 * {@link MAX_TOKEN_BYTES}); a bad value throws rather than silently minting a
 * weak or oversized token.
 */
export function generateInviteToken(
  options: GenerateInviteTokenOptions = {},
): string {
  const bytes = options.bytes ?? DEFAULT_TOKEN_BYTES;
  if (
    !Number.isInteger(bytes) ||
    bytes < MIN_TOKEN_BYTES ||
    bytes > MAX_TOKEN_BYTES
  ) {
    throw new RangeError(
      `Invite token entropy must be an integer in [${MIN_TOKEN_BYTES}, ${MAX_TOKEN_BYTES}] bytes (got ${bytes}).`,
    );
  }
  return randomBytes(bytes).toString("base64url");
}

/** Whether `token` has the shape of a token minted by
 * {@link generateInviteToken}: a string of unpadded base64url characters
 * within the accepted length range. Defensive about untrusted input — any
 * non-string, blank, padded, standard-base64 or out-of-range value is `false`.
 */
export function isWellFormedToken(token: unknown): boolean {
  return (
    typeof token === "string" &&
    token.length >= MIN_TOKEN_LENGTH &&
    token.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(token)
  );
}

/** Normalise a stored expiry to epoch millis; `NaN` when unparseable. */
function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/**
 * Whether an expiry has passed relative to `now` (epoch millis, default the
 * current clock). A `null`/`undefined` expiry means the invite never expires
 * (`false`); the boundary instant itself counts as expired and an
 * unparseable expiry fails closed (`true`), so a corrupt timestamp can never
 * keep an invite alive.
 */
export function isExpired(
  expiresAt: Date | string | number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const ms = toEpochMs(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return now >= ms;
}

/** The state `canRedeem` reads off a persisted invite. */
export interface RedeemableInvite {
  /** When the invite stops being redeemable; `null`/absent means never. */
  readonly expiresAt?: Date | string | number | null;
  /** Set once the invite was consumed (e.g. `acceptedAt`/`usedAt`). */
  readonly usedAt?: Date | string | number | null;
  /** Redemptions so far; defaults to `0`. */
  readonly usedCount?: number | null;
  /** Total allowed redemptions; defaults to {@link DEFAULT_MAX_USES}. */
  readonly maxUses?: number | null;
}

/** Why an invite cannot be redeemed; `null` when it can. */
export type RedeemBlockedReason = "expired" | "already_used" | "exhausted";

/** The verdict returned by {@link canRedeem}. */
export interface RedeemDecision {
  /** `true` when the invite may be redeemed right now. */
  readonly ok: boolean;
  /** The blocking reason, or `null` when `ok` is `true`. */
  readonly reason: RedeemBlockedReason | null;
  /** Redemptions left after this one (never negative). */
  readonly remainingUses: number;
}

export interface CanRedeemOptions {
  /** Epoch millis to evaluate against; defaults to the current clock. */
  readonly now?: number;
}

/** Clamp a stored use count to a non-negative integer, falling back when absent. */
function normalizeCount(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/** Any present, non-blank marker means the invite has already been consumed. */
function hasBeenUsed(usedAt: Date | string | number | null | undefined): boolean {
  return usedAt !== null && usedAt !== undefined && usedAt !== "";
}

/**
 * Decide whether an invite may be redeemed at `now`, checking expiry first,
 * then an already-used marker, then the remaining redemption budget. Returns
 * a {@link RedeemDecision} rather than a bare boolean so callers can surface
 * *why* (and how many uses remain) without re-deriving the rules. The reason
 * precedence is `expired` → `already_used` → `exhausted`.
 */
export function canRedeem(
  invite: RedeemableInvite,
  options: CanRedeemOptions = {},
): RedeemDecision {
  const now = options.now ?? Date.now();
  const maxUses = normalizeCount(invite.maxUses, DEFAULT_MAX_USES);
  const usedCount = normalizeCount(invite.usedCount, 0);
  const remainingUses = Math.max(0, maxUses - usedCount);

  if (isExpired(invite.expiresAt, now)) {
    return { ok: false, reason: "expired", remainingUses };
  }
  if (hasBeenUsed(invite.usedAt)) {
    return { ok: false, reason: "already_used", remainingUses };
  }
  if (remainingUses <= 0) {
    return { ok: false, reason: "exhausted", remainingUses };
  }
  return { ok: true, reason: null, remainingUses };
}

/**
 * Show only the shape of a token for logs and UI: `abcde…BCDE`. Values too
 * short to mask safely (8 characters or fewer) collapse to `••••`, and empty
 * or missing input returns `null` — matching `maskSecret`.
 */
export function maskToken(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}
