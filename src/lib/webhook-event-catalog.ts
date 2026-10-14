/**
 * B91 — the webhook event catalog's behaviour layer.
 *
 * `./webhook-events` owns the *identity* of every event (wire id, label,
 * description — R24.18, the single source of truth shared by the server
 * dispatcher and the client picker). This PURE module adds the parts that were
 * still missing:
 *
 *  - `requiredFields` per event, so a payload can be checked against what every
 *    `dispatchWebhooks(...)` call site actually sends;
 *  - `validateEventPayload` — non-throwing payload validation;
 *  - `filterSubscribed` — which events a hook's subscriptions select, with a
 *    `*` wildcard and `page.*` prefix support;
 *  - `isWebhookEventType` — a type guard for untrusted strings.
 *
 * Nothing here imports `node:crypto`, `prisma` or a server-only module, so the
 * picker and the dispatcher can both use it.
 */

import {
  WEBHOOK_EVENT_CATALOG,
  type WebhookEvent,
} from "@/lib/webhook-events";

/** A catalog entry plus the payload fields its event requires. */
export type WebhookEventDefinition = {
  /** `x-noema-event` wire value (the catalog `id`). */
  readonly type: WebhookEvent;
  /** Picker display string — kept equal to `type` in `./webhook-events`. */
  readonly label: string;
  /** Payload fields a well-formed event must carry. */
  readonly requiredFields: readonly string[];
  /** One-line description for the picker. */
  readonly description: string;
};

/**
 * The fields each dispatch site sends, keyed by event id. Typed as a total
 * `Record<WebhookEvent, …>` so adding a catalog event without declaring its
 * payload contract is a compile error, not a silent gap.
 */
const REQUIRED_FIELDS: Record<WebhookEvent, readonly string[]> = {
  "page.created": ["pageId"],
  "page.updated": ["pageId"],
  "row.created": ["rowId", "databasePageId"],
  "comment.created": ["commentId"],
};

/**
 * The event catalog with payload contracts, derived from
 * `WEBHOOK_EVENT_CATALOG` so ids, labels and descriptions never drift.
 */
export const WEBHOOK_EVENTS: readonly WebhookEventDefinition[] =
  WEBHOOK_EVENT_CATALOG.map((event) => ({
    type: event.id,
    label: event.label,
    requiredFields: REQUIRED_FIELDS[event.id],
    description: event.description,
  }));

const EVENT_TYPES = new Set<string>(WEBHOOK_EVENTS.map((event) => event.type));

/** Whether an untrusted value is a known `x-noema-event` id. */
export function isWebhookEventType(value: unknown): value is WebhookEvent {
  return typeof value === "string" && EVENT_TYPES.has(value);
}

/** Look up an event's definition; `undefined` for an unknown type. */
export function webhookEventDefinition(
  type: string,
): WebhookEventDefinition | undefined {
  return WEBHOOK_EVENTS.find((event) => event.type === type);
}

export type WebhookPayloadIssueCode =
  | "unknown_event"
  | "not_an_object"
  | "missing_field";

/** A single payload problem, addressable by `field`. */
export type WebhookPayloadIssue = {
  readonly field: string;
  readonly code: WebhookPayloadIssueCode;
  readonly message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

/**
 * Validate one event payload against its required fields. Returns every issue
 * found; an empty array means the payload is well-formed. Never throws — an
 * unknown type or a non-object payload collapses to a single issue.
 */
export function validateEventPayload(
  type: string,
  payload: unknown,
): WebhookPayloadIssue[] {
  const def = webhookEventDefinition(type);
  if (!def) {
    return [
      {
        field: "type",
        code: "unknown_event",
        message: `"${type}" is not a known webhook event.`,
      },
    ];
  }
  if (!isRecord(payload)) {
    return [
      {
        field: "",
        code: "not_an_object",
        message: "A webhook payload must be an object.",
      },
    ];
  }
  const issues: WebhookPayloadIssue[] = [];
  for (const field of def.requiredFields) {
    if (isBlank(payload[field])) {
      issues.push({
        field,
        code: "missing_field",
        message: `"${field}" is required for ${type}.`,
      });
    }
  }
  return issues;
}

/**
 * Whether a single subscription pattern selects an event.
 *
 * - `*` selects every event;
 * - an exact id (`page.created`) selects only that event;
 * - a trailing prefix wildcard (`page.*`) selects every event whose id starts
 *   with `page.`.
 */
export function matchesSubscription(event: string, subscription: string): boolean {
  if (subscription === "*") return true;
  if (subscription.endsWith(".*")) {
    return event.startsWith(subscription.slice(0, -1));
  }
  return event === subscription;
}

/**
 * The events a set of subscriptions selects, in the order the events were
 * given. An empty subscription list means "all events", mirroring
 * `dispatchWebhooks` (a hook with no event filter receives everything).
 * Unknown subscription patterns simply match nothing.
 */
export function filterSubscribed(
  events: readonly WebhookEvent[],
  subscriptions: readonly string[],
): WebhookEvent[] {
  if (subscriptions.length === 0) return [...events];
  return events.filter((event) =>
    subscriptions.some((subscription) => matchesSubscription(event, subscription)),
  );
}
