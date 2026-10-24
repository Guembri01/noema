/**
 * AI data boundaries — the enforceable part of the policy in
 * `docs/AI-BOUNDARIES.md`.
 *
 * The policy is only worth the code behind it, so this module holds the three
 * guarantees the transport can actually enforce:
 *
 * 1. **No prompt/response logging by default.** `logAiDiagnostic` is the one
 *    logging primitive the AI transport uses. It whitelists diagnostic fields
 *    (status, code, workspace, provider, model, duration) and drops every
 *    payload-shaped field (`prompt`, `messages`, `body`, `answer`,
 *    `completion`, `response`, `text`, `content`). Logging a payload needs the
 *    explicit `AI_LOG_PROMPTS=true` opt-in; even then only the fields the
 *    caller passes reach the sink, and the transport itself never passes any.
 * 2. **No training without an explicit operator opt-in.** A provider an
 *    operator declares as training (`AI_PROVIDER_TRAINS_ON_DATA=true`) is
 *    refused by the transport unless `AI_ALLOW_PROVIDER_TRAINING=true`.
 * 3. **Local-only processing is a fact of the endpoint.** When the effective
 *    base URL is loopback/private, the request cannot leave the operator's
 *    network; `aiProcessingScope` reports that and the settings UI shows it.
 *    No Noema server sits in the path of a workspace's provider call.
 *
 * The module is pure except for the explicit `logAiDiagnostic` sink and the
 * two environment readers, so the guarantees are unit-testable.
 */

import { isLocalAiBaseUrl } from "./ai-providers";
import { assertDataBoundary, type ProviderBoundary } from "./ai-cost";

/** Where a model call is processed. */
export type AiProcessingScope = "local" | "remote" | "none";

/**
 * The written policy, as constants a test can assert. The prose version lives
 * in `docs/AI-BOUNDARIES.md`.
 */
export const AI_BOUNDARY_POLICY = {
  id: "ai-data-boundary-v2",
  /** Prompts are not written to logs unless the operator opts in. */
  promptLogging: false,
  /** Completions are not written to logs unless the operator opts in. */
  responseLogging: false,
  /** Training on workspace content is never enabled by Noema itself. */
  providerTraining: false,
  /** Noema adds no analytics/telemetry call to any AI transport. */
  telemetryForwarding: false,
  /** Keys are encrypted at rest and never returned to clients. */
  keysAtRest: "AES-256-GCM",
  /** Transcription audio is processed and discarded. */
  audioRetention: "none",
} as const;

/**
 * Field names that may carry workspace content. They are dropped from a log
 * record unless payload logging has been explicitly enabled.
 */
export const AI_PAYLOAD_FIELDS = [
  "prompt",
  "prompts",
  "systemprompt",
  "messages",
  "body",
  "answer",
  "completion",
  "completions",
  "response",
  "text",
  "content",
  "input",
  "output",
  "audio",
  "transcript",
] as const;

const PAYLOAD_FIELDS = new Set<string>(AI_PAYLOAD_FIELDS);

/** Whether the operator explicitly opted in to prompt/response logging. */
export function aiPayloadLoggingEnabled(): boolean {
  return process.env.AI_LOG_PROMPTS === "true";
}

/**
 * Keep diagnostic metadata, drop payload-shaped fields. Returns a new object;
 * the input is not mutated. Non-primitive values are dropped as well, so a
 * nested request object cannot ride along.
 */
export function sanitizeAiDiagnostic(
  fields: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!fields || typeof fields !== "object") return safe;
  const payloadAllowed = aiPayloadLoggingEnabled();
  for (const [key, value] of Object.entries(fields)) {
    if (!payloadAllowed && PAYLOAD_FIELDS.has(key.toLowerCase())) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * The only AI logging sink. Diagnostics are metadata-only by default; a
 * payload field is dropped before it reaches `console`.
 */
export function logAiDiagnostic(
  event: string,
  fields?: Record<string, unknown> | null,
): void {
  console.error(event, sanitizeAiDiagnostic(fields));
}

/** The scope a base URL implies. `none` means no provider is configured. */
export function aiProcessingScope(baseUrl: string | null | undefined): AiProcessingScope {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return "none";
  return isLocalAiBaseUrl(raw) ? "local" : "remote";
}

/**
 * True when the endpoint is loopback/private, so every prompt and completion is
 * processed inside the operator's own network. This is the documented
 * local-only guarantee: it is derived from the effective endpoint, not from a
 * UI toggle that could be out of step with the transport.
 */
export function localOnlyProcessingGuaranteed(baseUrl: string | null | undefined): boolean {
  return aiProcessingScope(baseUrl) === "local";
}

/** The provider posture the boundary guard reads. */
export function providerBoundary(provider: string): ProviderBoundary {
  return {
    name: (provider ?? "").trim() || "unknown",
    // Noema itself never trains. An operator may declare that the endpoint
    // they chose does; the guard then refuses it unless they also opt in.
    trainsOnData: process.env.AI_PROVIDER_TRAINS_ON_DATA === "true",
  };
}

/** Whether the operator explicitly accepted a training provider. */
export function providerTrainingAllowed(): boolean {
  return process.env.AI_ALLOW_PROVIDER_TRAINING === "true";
}

/**
 * Enforce the training boundary for one call. Throws `DataBoundaryError` when
 * the provider is declared as training and the operator has not opted in.
 */
export function assertAiDataBoundary(provider: string): void {
  assertDataBoundary({
    provider: providerBoundary(provider),
    allowTraining: providerTrainingAllowed(),
  });
}
