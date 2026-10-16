/**
 * Verification cell adapter (`docs/specs/database-deep.md` R89.28; the §4
 * "Verification property" row). The pure state machine already lives in
 * `@/lib/verification`; this module is the thin, pure seam that finally wires
 * it to the places it was missing:
 *
 * - **The legacy inline cell.** `PropertyValue.value` currently stores a
 *   pre-engine cell (`{ verified: boolean, verifiedById?, verifiedAt?, note? }`
 *   — see `view-parts.tsx`), while the engine speaks the canonical
 *   `{ verifiedById, verifiedAt, note? }` {@link VerificationValue}. Of the two
 *   legacy variants, only the stamped one can be lifted into a canonical value:
 *   a bare `{ verified: true }` carries no actor, so it maps to "not verified"
 *   exactly as {@link parseVerification} documents. {@link cellToValue} and
 *   {@link valueToCell} convert in each direction.
 * - **The chip.** {@link cellDisplay} renders the label plus a `verified | stale
 *   | none` tone for the table/gallery/peek cell.
 * - **The toggle.** {@link toggleCell} flips a stored cell as the acting session
 *   user; a stamp left by someone else is refused.
 * - **CSV.** {@link parseCsvVerification} / {@link toCsvVerification} round-trip
 *   the `yes`/`no` column (R89.28 "CSV round-trip").
 * - **Validation & roll-ups.** {@link validateCell} reports shape/note problems
 *   and {@link aggregateVerification} counts a property's column.
 *
 * Design rules (mirroring the engine):
 *
 * - **No ambient clock.** Every time-dependent helper takes `now` explicitly.
 * - **Fail-safe, never throws.** Stored cells round-trip through the DB as
 *   untrusted JSON; junk normalises to "not verified" rather than raising.
 * - **Import, don't duplicate.** Every state decision is delegated to
 *   `@/lib/verification`; this module only converts shapes.
 */

import {
  describeVerification,
  parseVerification,
  toggleVerification,
  VERIFICATION_NOTE_MAX,
  type VerificationInstant,
  type VerificationValue,
} from "@/lib/verification";

/** The prefix the engine's stale label starts with (used to read its verdict). */
const STALE_LABEL_PREFIX = "Verification stale";

/**
 * The legacy inline cell shape the DB column stores: a boolean flag plus an
 * optional canonical stamp. A cleared cell keeps `verified: false` with both
 * stamp fields explicitly `null` (matching the client's un-verify write).
 */
export type LegacyVerificationCell = {
  verified: boolean;
  verifiedById: string | null;
  verifiedAt: string | null;
  note?: string;
};

/** The chip's visual state: a fresh stamp, an aged-out stamp, or nothing. */
export type CellTone = "verified" | "stale" | "none";

/** What {@link cellDisplay} renders for one cell. */
export type CellDisplay = {
  /** Human label, e.g. `"Verified ✓ · Ada · 2026-03-01"`. */
  label: string;
  /** Tone for the UI to colour the chip by. */
  tone: CellTone;
  /** Whether the value carries a full stamp (true even when `tone` is stale). */
  verified: boolean;
};

/** Options for {@link cellDisplay} and {@link aggregateVerification}. */
export type CellDisplayOptions = {
  /** Instant to evaluate staleness against (injected, never ambient). */
  now?: VerificationInstant;
  /** Display name for the actor; falls back to the stored id when blank. */
  actorName?: string;
  /** Freshness window; a stamp older than this is shown stale. */
  maxAgeMs?: number;
};

/** Options for {@link toggleCell}. */
export type ToggleCellOptions = {
  /** The acting session user; the only actor this function will ever stamp. */
  userId: string;
  /** The instant to stamp when verifying (injected). */
  now: VerificationInstant;
};

/** Machine-readable reason a stored verification cell was rejected. */
export type CellValidationIssueCode =
  /** The value is not a plain object. */
  | "INVALID_SHAPE"
  /** Only one of `verifiedById`/`verifiedAt` is present. */
  | "INCOMPLETE_STAMP"
  /** `note` is present but not a string. */
  | "INVALID_NOTE"
  /** `note` exceeds the configured length cap. */
  | "NOTE_TOO_LONG";

export type CellValidationIssue = {
  code: CellValidationIssueCode;
  message: string;
};

/** `ok: true` when the stored cell is coherent; otherwise the failures. */
export type CellValidation =
  | { ok: true }
  | { ok: false; errors: CellValidationIssue[] };

/** Options for {@link validateCell}. */
export type ValidateCellOptions = {
  /** Longest accepted note; defaults to the engine's {@link VERIFICATION_NOTE_MAX}. */
  maxNoteLength?: number;
};

/** Roll-up counts for one VERIFICATION column. */
export type VerificationAggregate = {
  /** Cells with a fresh stamp. */
  verified: number;
  /** Cells with no stamp (or junk). */
  unverified: number;
  /** Cells with a stamp older than the freshness window. */
  stale: number;
  /** Every cell considered (verified + unverified + stale). */
  total: number;
};

/** Read a value as a plain record; `null` for arrays, nulls and scalars. */
function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Map the legacy inline cell shape into the canonical {@link VerificationValue}.
 *
 * - A stamped legacy cell (`{ verifiedById, verifiedAt, note? }`, with or
 *   without a `verified: true` flag) is lifted field-for-field and normalised by
 *   {@link parseVerification}.
 * - An explicit `verified: false` clears the stamp pair ("un-verifying clears
 *   both fields", R89.28) while preserving any note — matching the client writes
 *   in `view-parts.tsx`.
 * - A bare `{ verified: true }` (and the canonical cleared shape
 *   `{ verifiedById: null, verifiedAt: null }`) becomes `{}`: without an actor
 *   it cannot be represented as verified, exactly as the engine documents.
 * - Anything that is not a plain object becomes `{}`. Never throws.
 */
export function cellToValue(raw: unknown): VerificationValue {
  const record = asRecord(raw);
  if (record && record.verified === false) {
    const cleared: VerificationValue = {};
    if (typeof record.note === "string" && record.note.trim() !== "") {
      cleared.note = record.note;
    }
    return cleared;
  }
  return parseVerification(raw);
}

/**
 * Write a canonical value back to the legacy inline cell shape the DB column
 * stores: `{ verified: true, verifiedById, verifiedAt }` for a full stamp, or a
 * complete cleared cell (`{ verified: false, verifiedById: null, verifiedAt:
 * null }`) otherwise. A note is carried through in both cases. Never throws.
 */
export function valueToCell(value: unknown): LegacyVerificationCell {
  const parsed = parseVerification(value);
  const note = parsed.note;
  if (parsed.verifiedById !== undefined && parsed.verifiedAt !== undefined) {
    return note !== undefined
      ? { verified: true, verifiedById: parsed.verifiedById, verifiedAt: parsed.verifiedAt, note }
      : { verified: true, verifiedById: parsed.verifiedById, verifiedAt: parsed.verifiedAt };
  }
  return note !== undefined
    ? { verified: false, verifiedById: null, verifiedAt: null, note }
    : { verified: false, verifiedById: null, verifiedAt: null };
}

/**
 * The chip for one stored cell: its {@link CellDisplay.label} and
 * {@link CellDisplay.tone}. The label is delegated to
 * {@link describeVerification}; the tone reads that verdict back (a standalone
 * stamp is `"verified"`, an aged-out one `"stale"` when both `now` and
 * `maxAgeMs` are supplied, and an absent stamp `"none"`). Never throws.
 */
export function cellDisplay(
  raw: unknown,
  options: CellDisplayOptions = {},
): CellDisplay {
  const value = cellToValue(raw);
  const label = describeVerification(value, {
    now: options.now,
    actorName: options.actorName,
    maxAgeMs: options.maxAgeMs,
  });
  const verified =
    value.verifiedById !== undefined && value.verifiedAt !== undefined;
  const tone: CellTone =
    !verified ? "none" : label.startsWith(STALE_LABEL_PREFIX) ? "stale" : "verified";
  return { label, tone, verified };
}

/**
 * Flip a stored cell as the acting session user, returning the legacy cell to
 * persist. Delegates the state machine (including the "foreign actor rejected"
 * rule, R89.28) to {@link toggleVerification}. Never throws.
 */
export function toggleCell(
  raw: unknown,
  options: ToggleCellOptions,
): LegacyVerificationCell {
  return valueToCell(toggleVerification(cellToValue(raw), options));
}

/** The outcome of parsing a CSV verification token. */
export type CsvVerificationResult = { value: boolean } | { error: string };

/** Tokens that read as "verified"; else the negative set; else an error. */
const CSV_TRUE_TOKENS = new Set(["yes", "true", "1", "✓"]);
const CSV_FALSE_TOKENS = new Set(["no", "false", "0", ""]);

/**
 * Parse one CSV verification cell. `yes`/`true`/`1`/`✓` read as verified and
 * `no`/`false`/`0`/blank as unverified — case-insensitively, after trimming
 * (R89.28 "exports yes/no, imports to checked/unchecked"). A null/undefined cell
 * (a missing column) counts as unverified; any other token is an {@link
 * CsvVerificationResult} error. Never throws.
 */
export function parseCsvVerification(text: unknown): CsvVerificationResult {
  if (text === null || text === undefined) return { value: false };
  if (typeof text !== "string") {
    return { error: `Unrecognised verification value: ${String(text)}` };
  }
  const token = text.trim().toLowerCase();
  if (CSV_TRUE_TOKENS.has(token)) return { value: true };
  if (CSV_FALSE_TOKENS.has(token)) return { value: false };
  return { error: `Unrecognised verification value: "${text.trim()}"` };
}

/**
 * Export a stored cell to the CSV column: `"yes"` when it carries a canonical
 * stamp, otherwise `"no"`. Canonicalisation goes through {@link cellToValue}, so
 * the CSV column agrees exactly with {@link cellDisplay} and
 * {@link aggregateVerification} — notably, a legacy `{ verified: true }` with no
 * actor reads as `"no"` everywhere. Never throws.
 */
export function toCsvVerification(value: unknown): "yes" | "no" {
  const canonical = cellToValue(value);
  return canonical.verifiedById !== undefined && canonical.verifiedAt !== undefined
    ? "yes"
    : "no";
}

/**
 * Check that a stored cell is coherent. An empty/cleared cell and the legacy
 * boolean alias are valid; a present stamp must carry both halves, and a note
 * must be a string within `maxNoteLength` (default {@link VERIFICATION_NOTE_MAX}).
 * Unknown extra keys are ignored. Never throws.
 */
export function validateCell(
  raw: unknown,
  options: ValidateCellOptions = {},
): CellValidation {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        { code: "INVALID_SHAPE", message: "A verification cell must be an object." },
      ],
    };
  }

  const record = raw as Record<string, unknown>;
  const errors: CellValidationIssue[] = [];

  // A stamp needs both halves; a genuinely absent pair (or the legacy boolean
  // alias, which carries no stamp at all) is not "incomplete".
  const hasActor = record.verifiedById !== null && record.verifiedById !== undefined;
  const hasTimestamp = record.verifiedAt !== null && record.verifiedAt !== undefined;
  if (hasActor !== hasTimestamp) {
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
      } else {
        const max = options.maxNoteLength ?? VERIFICATION_NOTE_MAX;
        if (Number.isFinite(max) && note.length > max) {
          errors.push({
            code: "NOTE_TOO_LONG",
            message: `note must be at most ${max} characters.`,
          });
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Roll up one VERIFICATION column into chip counts for the property header:
 * `verified` (fresh), `stale` (aged out — only when both `now` and `maxAgeMs`
 * are given) and `unverified`, plus the `total` of every value considered.
 * Non-array input counts as an empty column. Never throws.
 */
export function aggregateVerification(
  values: unknown,
  options: CellDisplayOptions = {},
): VerificationAggregate {
  const list = Array.isArray(values) ? values : [];
  const out: VerificationAggregate = {
    verified: 0,
    unverified: 0,
    stale: 0,
    total: list.length,
  };
  for (const value of list) {
    const { tone } = cellDisplay(value, options);
    if (tone === "verified") out.verified += 1;
    else if (tone === "stale") out.stale += 1;
    else out.unverified += 1;
  }
  return out;
}
