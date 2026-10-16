/**
 * AI-autofill property configuration — pure, dependency-free helpers for the
 * `AI_AUTOFILL` property type.
 *
 * An AI-autofill column is defined by its `Property.config`: the prompt the
 * server runs when a row is created, plus the optional `targetPropertyId` it
 * writes into and the sampling knobs (`maxTokens`, `temperature`). This module
 * owns the *shape* of that config — parsing it from untrusted stored JSON,
 * repairing it, validating its bounds and describing it — mirroring the contract
 * of `rollup-config.ts` / `number-format.ts`.
 *
 * Design rules (same contract as the other `src/lib` config helpers):
 *
 * - **Parse is strict, normalize is fail-safe.** `parseAiAutofillConfig`
 *   reports structural problems (`ok: false`) for malformed JSON or a
 *   wrong-typed field, so an editor can show a real error; it deliberately
 *   lets out-of-range numbers through, because ranges are `validate`'s job.
 *   `normalizeAiAutofillConfig` never throws and always returns the canonical
 *   shape — the config round-trips through the DB as untrusted JSON.
 * - **Issues, not booleans.** `validateAiAutofillConfig` returns one structured
 *   issue per problem (empty prompt, over-long prompt, temperature out of
 *   `0..2`, tokens out of bounds / non-integer) so a caller can surface them
 *   all at once; it never returns a bare `false`.
 * - **Normalize repairs, validate reports.** `normalize` clamps and rounds out
 *   of range values so a stored config is always usable; `validate` reads the
 *   raw input and flags what was wrong. They are complementary, not redundant.
 */

/** The persisted AI-autofill configuration (`Property.config`). */
export type AiAutofillConfig = {
  /** The instruction the model runs; trimmed. May be empty (validate flags it). */
  prompt: string;
  /** The property the generated value is written into, when scoped. */
  targetPropertyId?: string;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  /** Sampling temperature in `0..2`. */
  temperature?: number;
};

/** The result of a strict structural parse. */
export type AiAutofillParseResult =
  | { ok: true; config: AiAutofillConfig }
  | { ok: false; error: string };

/** A problem `validateAiAutofillConfig` can report. */
export type AiAutofillIssueCode =
  | "EMPTY_PROMPT"
  | "PROMPT_TOO_LONG"
  | "TEMPERATURE_OUT_OF_RANGE"
  | "TOKENS_OUT_OF_RANGE";

/** One problem with an AI-autofill configuration. */
export type AiAutofillIssue = {
  code: AiAutofillIssueCode;
  message: string;
};

/** The inclusive bounds every AI-autofill config is validated against. */
export const AI_AUTOFILL_LIMITS = {
  minPromptLength: 1,
  maxPromptLength: 2000,
  minTemperature: 0,
  maxTemperature: 2,
  minTokens: 1,
  maxTokens: 4096,
} as const;

/** The sampling temperature used when a config does not set one. */
export const DEFAULT_AI_TEMPERATURE = 0.4;

/** The token ceiling used when a config does not set one. */
export const DEFAULT_AI_MAX_TOKENS = 512;

/** How many prompt characters `describeAiAutofill` renders before eliding. */
const DESCRIBE_PROMPT_LIMIT = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the config source: a JSON string is decoded (falling back to `null` when
 * malformed), anything else is passed through unchanged. Never throws.
 */
function toSource(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse a raw config into the canonical shape, reporting structural problems.
 * Accepts an object or a JSON string; a missing prompt becomes `""`, and blank
 * ids are dropped. Wrong-typed fields and malformed JSON return `ok: false`
 * with a message (never a throw). Out-of-range numbers are *not* rejected here
 * — `validateAiAutofillConfig` owns the bounds.
 */
export function parseAiAutofillConfig(raw: unknown): AiAutofillParseResult {
  let source: unknown;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      return { ok: false, error: "AI-autofill config is not valid JSON." };
    }
  } else {
    source = raw;
  }

  if (!isRecord(source)) {
    return { ok: false, error: "AI-autofill config must be an object." };
  }

  const prompt = source.prompt;
  if (prompt !== undefined && prompt !== null && typeof prompt !== "string") {
    return { ok: false, error: "prompt must be a string." };
  }

  const target = source.targetPropertyId;
  if (target !== undefined && target !== null && typeof target !== "string") {
    return { ok: false, error: "targetPropertyId must be a string." };
  }

  const rawMaxTokens = source.maxTokens;
  let maxTokens: number | undefined;
  if (rawMaxTokens !== undefined && rawMaxTokens !== null) {
    if (typeof rawMaxTokens !== "number" || !Number.isFinite(rawMaxTokens)) {
      return { ok: false, error: "maxTokens must be a finite number." };
    }
    maxTokens = rawMaxTokens;
  }

  const rawTemperature = source.temperature;
  let temperature: number | undefined;
  if (rawTemperature !== undefined && rawTemperature !== null) {
    if (typeof rawTemperature !== "number" || !Number.isFinite(rawTemperature)) {
      return { ok: false, error: "temperature must be a finite number." };
    }
    temperature = rawTemperature;
  }

  const config: AiAutofillConfig = {
    prompt: typeof prompt === "string" ? prompt.trim() : "",
  };
  const targetId = typeof target === "string" ? target.trim() : "";
  if (targetId !== "") config.targetPropertyId = targetId;
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  if (temperature !== undefined) config.temperature = temperature;

  return { ok: true, config };
}

/**
 * Coerce an untrusted config into the canonical `AiAutofillConfig`. Accepts an
 * already-normalised object, a raw `Property.config` or a JSON string; a blank
 * or non-string prompt becomes `""`, blank ids are dropped, a numeric
 * `temperature` is clamped into `0..2` and `maxTokens` is rounded and clamped
 * into its bounds. Non-numeric or non-finite knobs are dropped rather than
 * invented. Idempotent and never throws.
 */
export function normalizeAiAutofillConfig(raw: unknown): AiAutofillConfig {
  const source = toSource(raw);
  const record = isRecord(source) ? source : {};

  const config: AiAutofillConfig = {
    prompt: typeof record.prompt === "string" ? record.prompt.trim() : "",
  };

  if (typeof record.targetPropertyId === "string") {
    const target = record.targetPropertyId.trim();
    if (target !== "") config.targetPropertyId = target;
  }

  const temperature = record.temperature;
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    config.temperature = clamp(
      temperature,
      AI_AUTOFILL_LIMITS.minTemperature,
      AI_AUTOFILL_LIMITS.maxTemperature,
    );
  }

  const tokens = record.maxTokens;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    config.maxTokens = clamp(
      Math.round(tokens),
      AI_AUTOFILL_LIMITS.minTokens,
      AI_AUTOFILL_LIMITS.maxTokens,
    );
  }

  return config;
}

/**
 * Validate an AI-autofill configuration, returning one issue per problem and
 * never throwing. Reads the raw input (object or JSON string) so out-of-range
 * values are reported rather than silently clamped. Checks, in order: the
 * prompt is a non-empty string within the length bound, `temperature` is a
 * finite number in `0..2` (when present) and `maxTokens` is an integer within
 * its bounds (when present). A missing prompt is `EMPTY_PROMPT`.
 */
export function validateAiAutofillConfig(config: unknown): AiAutofillIssue[] {
  const issues: AiAutofillIssue[] = [];
  try {
    const source = toSource(config);
    const record = isRecord(source) ? source : {};

    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (prompt === "") {
      issues.push({ code: "EMPTY_PROMPT", message: "AI autofill needs a prompt." });
    } else if (prompt.length > AI_AUTOFILL_LIMITS.maxPromptLength) {
      issues.push({
        code: "PROMPT_TOO_LONG",
        message: `Prompt is limited to ${AI_AUTOFILL_LIMITS.maxPromptLength} characters.`,
      });
    }

    const temperature = record.temperature;
    if (temperature !== undefined && temperature !== null) {
      if (
        typeof temperature !== "number" ||
        !Number.isFinite(temperature) ||
        temperature < AI_AUTOFILL_LIMITS.minTemperature ||
        temperature > AI_AUTOFILL_LIMITS.maxTemperature
      ) {
        issues.push({
          code: "TEMPERATURE_OUT_OF_RANGE",
          message: `Temperature must be between ${AI_AUTOFILL_LIMITS.minTemperature} and ${AI_AUTOFILL_LIMITS.maxTemperature}.`,
        });
      }
    }

    const tokens = record.maxTokens;
    if (tokens !== undefined && tokens !== null) {
      if (
        typeof tokens !== "number" ||
        !Number.isFinite(tokens) ||
        !Number.isInteger(tokens) ||
        tokens < AI_AUTOFILL_LIMITS.minTokens ||
        tokens > AI_AUTOFILL_LIMITS.maxTokens
      ) {
        issues.push({
          code: "TOKENS_OUT_OF_RANGE",
          message: `Max tokens must be a whole number between ${AI_AUTOFILL_LIMITS.minTokens} and ${AI_AUTOFILL_LIMITS.maxTokens}.`,
        });
      }
    }
  } catch {
    // Fail-safe: exotic input must never break the caller.
    return issues;
  }
  return issues;
}

/**
 * A one-line, human-readable description of an AI autofill for menus and
 * tooltips, e.g. `AI autofill "Summarize." → prop1 (temperature 0.4, max 512
 * tokens)`. Sampling knobs fall back to the documented defaults when unset, an
 * empty/unreadable prompt shows `"(no prompt)"`, and an over-long prompt is
 * elided with an ellipsis. Never throws.
 */
export function describeAiAutofill(config: unknown): string {
  const normalized = normalizeAiAutofillConfig(config);

  const prompt = normalized.prompt;
  const shown =
    prompt === ""
      ? "(no prompt)"
      : prompt.length > DESCRIBE_PROMPT_LIMIT
        ? `${prompt.slice(0, DESCRIBE_PROMPT_LIMIT)}…`
        : prompt;

  const target = normalized.targetPropertyId ? ` → ${normalized.targetPropertyId}` : "";
  const temperature = normalized.temperature ?? DEFAULT_AI_TEMPERATURE;
  const maxTokens = normalized.maxTokens ?? DEFAULT_AI_MAX_TOKENS;

  return `AI autofill "${shown}"${target} (temperature ${temperature}, max ${maxTokens} tokens)`;
}
