/**
 * Verification property engine (`docs/specs/database-deep.md` R89.28; the
 * feature-matrix row "Verification property", §4 `:303`).
 *
 * A VERIFICATION cell stores `{ verifiedById, verifiedAt, note? }`: the id of
 * the user who stamped it, an ISO-8601 instant, and an optional free-text note.
 * This module is the pure state machine around that value — it normalises
 * untrusted stored JSON ({@link parseVerification}), decides whether a value
 * currently counts as verified, optionally only within a freshness window
 * ({@link isVerified}), flips it with the acting session user
 * ({@link toggleVerification}), reports shape problems
 * ({@link validateVerification}) and renders the chip label
 * ({@link describeVerification}).
 *
 * Design rules:
 *
 * - **No ambient clock.** Every time-dependent helper takes `now` explicitly,
 *   so a stored value can be replayed against a fixed timeline in tests.
 * - **Fail-safe, never throws.** Stored values round-trip through the DB as
 *   untrusted JSON; a null, an array, a cycle or an unparseable timestamp is
 *   tolerated and normalised to "not verified" rather than raising.
 * - **The session owns the stamp.** {@link toggleVerification} only ever writes
 *   the `userId` it is handed. A stamp left by a *different* user is refused
 *   (R89.28 "foreign actor rejected"), so a client can neither forge an actor
 *   nor clear somebody else's verification.
 * - **Un-verifying clears the pair** (`verifiedById` + `verifiedAt`) while any
 *   `note` is preserved (R89.28).
 */

/** The stored shape of a VERIFICATION cell; every field is absent when unset. */
export type VerificationValue = {
  /** Id of the user who stamped the verification; absent when not verified. */
  verifiedById?: string;
  /** ISO-8601 instant the verification was stamped; absent when not verified. */
  verifiedAt?: string;
  /** Optional free-text note carried alongside the stamp. */
  note?: string;
};

/** Longest note accepted by {@link validateVerification}, in characters. */
export const VERIFICATION_NOTE_MAX = 2000;

/** Machine-readable reason a stored verification value was rejected. */
export type VerificationErrorCode =
  /** The value is not a plain object. */
  | "INVALID_SHAPE"
  /** `verifiedById` is neither a non-empty string nor `null`/absent. */
  | "INVALID_ACTOR"
  /** `verifiedAt` is neither a parseable ISO string nor `null`/absent. */
  | "INVALID_TIMESTAMP"
  /** Only one of `verifiedById`/`verifiedAt` is present. */
  | "INCOMPLETE_STAMP"
  /** `note` is present but not a string. */
  | "INVALID_NOTE"
  /** `note` exceeds {@link VERIFICATION_NOTE_MAX} characters. */
  | "NOTE_TOO_LONG";

export type VerificationError = {
  code: VerificationErrorCode;
  message: string;
};

/** `ok: true` when the stored value is coherent; otherwise the failures. */
export type VerificationValidation =
  | { ok: true }
  | { ok: false; errors: VerificationError[] };

/** A point in time, as epoch millis or a `Date`. */
export type VerificationInstant = number | Date;

/** Options for {@link isVerified}. */
export type IsVerifiedOptions = {
  /** The instant to evaluate against (injected, never the ambient clock). */
  now: VerificationInstant;
  /** Optional freshness window; a stamp older than this is not verified. */
  maxAgeMs?: number;
};

/** Options for {@link toggleVerification}. */
export type ToggleVerificationOptions = {
  /** The acting session user; the only actor this function will ever stamp. */
  userId: string;
  /** The instant to stamp when verifying (injected). */
  now: VerificationInstant;
};

/** Options for {@link describeVerification}. */
export type DescribeVerificationOptions = {
  /** Display name for the actor; falls back to the stored id when blank. */
  actorName?: string;
  /** Paired with `maxAgeMs`, an aged-out stamp is labelled stale. */
  now?: VerificationInstant;
  /** Freshness window used to detect a stale stamp. */
  maxAgeMs?: number;
};

/** Read a value as a plain record; `null` for arrays, nulls and scalars. */
function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Read an instant as epoch millis (a `Date` is unwrapped; junk stays `NaN`). */
function toMillis(value: VerificationInstant): number {
  return value instanceof Date ? value.getTime() : value;
}

/** A non-blank string, trimmed; `null` for anything else. */
function toId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Normalise a stored timestamp to canonical ISO, or `null` when unparseable. */
function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Coerce untrusted stored JSON into a {@link VerificationValue}. Only fields
 * that survive scrutiny are kept: a blank actor id and an unparseable timestamp
 * are dropped, a padded actor id is trimmed, and a valid timestamp is
 * normalised to canonical ISO. Anything that is not a plain object — including
 * a legacy `{ verified: true }` boolean alias, which carries no actor — becomes
 * `{}`, i.e. "not verified". Never throws.
 */
export function parseVerification(raw: unknown): VerificationValue {
  const record = asRecord(raw);
  if (!record) return {};
  const out: VerificationValue = {};
  const actor = toId(record.verifiedById);
  if (actor !== null) out.verifiedById = actor;
  const iso = toIso(record.verifiedAt);
  if (iso !== null) out.verifiedAt = iso;
  const note = record.note;
  if (typeof note === "string" && note.trim() !== "") out.note = note;
  return out;
}

/**
 * Whether `value` counts as verified at `now`. A value must carry both an actor
 * id and a parseable timestamp to be verified at all. When `maxAgeMs` is given
 * the stamp must also be no older than that window (the boundary instant itself
 * is still fresh, and a future-stamped value is always fresh). An unusable
 * window or clock is treated as "no limit", so a bad option can never downgrade
 * a real verification on its own. Never throws.
 */
export function isVerified(value: unknown, options: IsVerifiedOptions): boolean {
  const parsed = parseVerification(value);
  if (parsed.verifiedById === undefined || parsed.verifiedAt === undefined) {
    return false;
  }
  const maxAgeMs = options.maxAgeMs;
  if (maxAgeMs === undefined || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return true;
  }
  const now = toMillis(options.now);
  if (!Number.isFinite(now)) return true;
  const stampedAt = Date.parse(parsed.verifiedAt);
  return now - stampedAt <= maxAgeMs;
}

/**
 * Flip the verification state of `value` as the acting `userId`, stamping `now`
 * when verifying:
 *
 * - **Not verified** → stamped `{ verifiedById: userId, verifiedAt: now }`.
 * - **Verified by `userId`** → cleared: the `verifiedById`/`verifiedAt` pair is
 *   removed.
 * - **Verified by someone else** → refused, returned unchanged ("foreign actor
 *   rejected", R89.28).
 *
 * A `note` is preserved in every case. The input is never mutated, and a blank
 * `userId` or an unusable `now` refuses to verify (returning the parsed value).
 */
export function toggleVerification(
  value: unknown,
  options: ToggleVerificationOptions,
): VerificationValue {
  const parsed = parseVerification(value);
  const actor = toId(options.userId);
  const ms = toMillis(options.now);
  const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : null;

  const hasStamp =
    parsed.verifiedById !== undefined || parsed.verifiedAt !== undefined;
  if (hasStamp) {
    // Only the actor who stamped it may remove it.
    if (parsed.verifiedById !== undefined && parsed.verifiedById !== actor) {
      return parsed;
    }
    const cleared: VerificationValue = {};
    if (parsed.note !== undefined) cleared.note = parsed.note;
    return cleared;
  }

  // Verifying: the stamp must come from a real session actor at a real instant.
  if (actor === null || iso === null) return parsed;
  const stamped: VerificationValue = { verifiedById: actor, verifiedAt: iso };
  if (parsed.note !== undefined) stamped.note = parsed.note;
  return stamped;
}

/**
 * Check that a stored value is a coherent stamp, returning every problem found.
 * An empty value (`null`/`undefined`/`{}`) and the canonical cleared shape
 * (`{ verifiedById: null, verifiedAt: null }`) are valid — "not verified". A
 * present actor and timestamp must each be well-formed and must appear
 * together; a note must be a string within {@link VERIFICATION_NOTE_MAX}.
 * Unknown extra keys are ignored (permissive), and this never throws.
 */
export function validateVerification(raw: unknown): VerificationValidation {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        { code: "INVALID_SHAPE", message: "A verification value must be an object." },
      ],
    };
  }

  const record = raw as Record<string, unknown>;
  const errors: VerificationError[] = [];

  const actor = toId(record.verifiedById);
  const timestamp = toIso(record.verifiedAt);

  // A field that is present but malformed is reported by its own code; only a
  // genuinely absent/null field on one side of an otherwise-valid stamp is
  // "incomplete", so the two errors never pile on the same field.
  const rawActor = record.verifiedById;
  const actorMalformed =
    "verifiedById" in record && actor === null && rawActor !== null && rawActor !== undefined;
  if (actorMalformed) {
    errors.push({
      code: "INVALID_ACTOR",
      message: "verifiedById must be a non-empty string, null, or absent.",
    });
  }
  const rawTimestamp = record.verifiedAt;
  const timeMalformed =
    "verifiedAt" in record &&
    timestamp === null &&
    rawTimestamp !== null &&
    rawTimestamp !== undefined;
  if (timeMalformed) {
    errors.push({
      code: "INVALID_TIMESTAMP",
      message: "verifiedAt must be an ISO-8601 string, null, or absent.",
    });
  }
  if ((actor !== null) !== (timestamp !== null) && !actorMalformed && !timeMalformed) {
    errors.push({
      code: "INCOMPLETE_STAMP",
      message: "A verification needs both verifiedById and verifiedAt, or neither.",
    });
  }

  if ("note" in record) {
    const note = record.note;
    if (note !== null && note !== undefined) {
      if (typeof note !== "string") {
        errors.push({ code: "INVALID_NOTE", message: "note must be a string." });
      } else if (note.length > VERIFICATION_NOTE_MAX) {
        errors.push({
          code: "NOTE_TOO_LONG",
          message: `note must be at most ${VERIFICATION_NOTE_MAX} characters.`,
        });
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * The chip label for a stored value: `"Not verified"`, or
 * `"Verified ✓ · <actor> · <YYYY-MM-DD>"` using `actorName` when supplied and
 * otherwise the stored id. When both `now` and `maxAgeMs` are given and the
 * stamp has aged out, the label becomes `"Verification stale · …"`.
 */
export function describeVerification(
  raw: unknown,
  options: DescribeVerificationOptions = {},
): string {
  const parsed = parseVerification(raw);
  if (parsed.verifiedById === undefined || parsed.verifiedAt === undefined) {
    return "Not verified";
  }
  const actor =
    typeof options.actorName === "string" && options.actorName.trim() !== ""
      ? options.actorName.trim()
      : parsed.verifiedById;
  const date = parsed.verifiedAt.slice(0, 10);
  const stale =
    options.now !== undefined &&
    options.maxAgeMs !== undefined &&
    !isVerified(parsed, { now: options.now, maxAgeMs: options.maxAgeMs });
  return stale
    ? `Verification stale · ${actor} · ${date}`
    : `Verified ✓ · ${actor} · ${date}`;
}
