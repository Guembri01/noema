import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  type WebhookEvent,
} from "@/lib/webhook-events";
import {
  constantTimeEqualHex,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from "@/lib/webhook-signature";

// R24.18 — the catalog lives in the PURE module `./webhook-events` (no
// node:crypto, no prisma) so the client picker imports the same single source
// of truth. Re-exported here so every server-side import path
// (`src/server/actions/webhooks.ts`, tests, …) stays byte-stable.
export { WEBHOOK_EVENTS, WEBHOOK_EVENT_CATALOG };
export type { WebhookEvent };

/** R24.11 — delay before each delivery attempt: 0 s, 2 s, 8 s, 30 s, 2 min. */
export const WEBHOOK_BACKOFF_MS = [0, 2_000, 8_000, 30_000, 120_000] as const;

/** R24.11 — 5 attempts replaces the old `MAX_ATTEMPTS = 3`. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length;

/** Per-attempt timeout stays at 5 s (R24.11). */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** R24.13 — verifiers reject `|now − t|` beyond this window (300 s). */
export const SIGNATURE_TOLERANCE_MS = 300_000;

export type WebhookSleep = (ms: number) => Promise<void>;

const defaultSleep: WebhookSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cumulative due time (unix ms) of each attempt for a delivery whose dispatch
 * started at `startedAtMs`: `[start, +2 s, +10 s, +40 s, +160 s]`.
 * Pure so the schedule can be unit-tested against a fake clock (R24.11).
 */
export function deliveryDueTimes(startedAtMs: number): number[] {
  let elapsed = 0;
  return WEBHOOK_BACKOFF_MS.map((delay) => {
    elapsed += delay;
    return startedAtMs + elapsed;
  });
}

/**
 * Legacy v1 MAC: `HMAC-SHA256(secret, rawBody)`, with no timestamp bound in.
 * Retained only so already-deployed receivers keep verifying during the rollout.
 */
function legacyHmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * R24.13 — canonical form `x-noema-signature: t=<unixMs>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`. Delegates to the shared
 * `signPayload` (D24) so the dispatcher and `verifySignature` share ONE signing
 * implementation. The wire format is byte-for-byte unchanged, so the single
 * `x-noema-signature` header is kept — receivers need no transition.
 */
export function signWebhookV2(secret: string, body: string, timestampMs: number): string {
  return signPayload(body, secret, { timestamp: timestampMs });
}

/**
 * Verify an incoming `x-noema-signature`.
 *
 * - v2 (`t=…,v1=…`): delegated to the shared {@link verifySignature} — freshness
 *   is enforced (`|now − t| > 300 s` fails, inclusive boundary), and so does any
 *   tampering of the timestamp or the body.
 * - legacy v1 (bare hex = `HMAC-SHA256(secret, rawBody)`): still accepted so
 *   already-deployed receivers keep verifying during the rollout; it carries no
 *   timestamp, hence no freshness window.
 *
 * `timestamp` is the companion `x-noema-timestamp` header; when present it must
 * agree with the `t` inside the signature.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  signature: string;
  timestamp?: number | string | null;
  now?: number;
}): boolean {
  const signature = input.signature.trim();
  if (!signature) return false;

  // Legacy v1 (bare 64-hex, no `t=`): MAC over the raw body only.
  if (/^[0-9a-f]{64}$/i.test(signature)) {
    return constantTimeEqualHex(legacyHmacHex(input.secret, input.body), signature);
  }

  // The shared verifier reads `t` from the header; enforce the companion
  // `x-noema-timestamp` agrees with it when that header is present.
  const parsed = parseSignatureHeader(signature);
  if (!parsed.ok) return false;
  if (input.timestamp != null && Number(input.timestamp) !== parsed.timestamp) {
    return false;
  }

  return verifySignature(input.body, signature, input.secret, {
    now: input.now,
    toleranceSeconds: SIGNATURE_TOLERANCE_MS / 1000,
  }).ok;
}

/** Per-attempt headers; the timestamp/signature are computed at send time (R24.14 edge). */
function signatureHeaders(
  secret: string | null,
  event: string,
  body: string,
  timestampMs: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-noema-event": event,
    "x-noema-timestamp": String(timestampMs),
  };
  if (secret) headers["x-noema-signature"] = signWebhookV2(secret, body, timestampMs);
  return headers;
}

type DeliveryRowRef = { id: string | null };

/** R24.10 — outbox write: one row persisted before any network I/O. */
async function createDeliveryRow(webhookId: string, event: string): Promise<string | null> {
  try {
    const row = await prisma.webhookDelivery.create({
      data: { webhookId, event, ok: false, attempts: 0 },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null; /* delivery logging must never throw */
  }
}

/**
 * R24.12 — one row per logical delivery: every attempt updates the SAME row's
 * `attempts` / `ok` / `responseStatus` / `error` instead of inserting a new one
 * (the old code logged up to 4 rows per failed delivery).
 */
async function recordAttempt(
  row: DeliveryRowRef,
  webhookId: string,
  event: string,
  attempt: number,
  ok: boolean,
  responseStatus: number | null,
  error: string | null,
): Promise<void> {
  try {
    if (row.id) {
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: { attempts: attempt, ok, responseStatus, error },
      });
      return;
    }
    // The outbox write failed up front — create the row here, once, and keep
    // updating that one row for the remaining attempts.
    const created = await prisma.webhookDelivery.create({
      data: { webhookId, event, attempts: attempt, ok, responseStatus, error },
      select: { id: true },
    });
    row.id = created.id;
  } catch {
    /* delivery logging must never throw */
  }
}

/**
 * Attempt delivery with the R24.11 backoff schedule (0/2/8/30/120 s), writing
 * every attempt to a single `WebhookDelivery` row. Exported for the unit tests
 * and so the durable retry sweep (T24.3) can claim-and-send through the same
 * path.
 */
export async function deliverWithRetry(
  hook: { id: string; url: string; secret: string | null },
  event: WebhookEvent,
  body: string,
  options: { deliveryId?: string | null; sleep?: WebhookSleep } = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const row: DeliveryRowRef = { id: options.deliveryId ?? null };

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    const delay = WEBHOOK_BACKOFF_MS[attempt - 1] ?? 0;
    if (delay > 0) await sleep(delay);

    let ok = false;
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(hook.url, {
        method: "POST",
        headers: signatureHeaders(hook.secret, event, body, Date.now()),
        body,
        // R24.11 — never follow redirects: a 3xx counts as a failed attempt.
        redirect: "manual",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      responseStatus = response.status;
      ok = response.ok;
      if (!ok) error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    await recordAttempt(row, hook.id, event, attempt, ok, responseStatus, error);
    if (ok) return;
  }
}

/**
 * Deliver an event to every active matching webhook for a workspace.
 * Network delivery runs in the background (with retries); this resolves once
 * the outbox rows are persisted and the deliveries scheduled, so callers never
 * block on a webhook endpoint.
 */
export async function dispatchWebhooks(
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: { sleep?: WebhookSleep } = {},
): Promise<void> {
  try {
    const hooks = await prisma.webhook.findMany({
      where: { workspaceId, active: true },
      select: { id: true, url: true, secret: true, events: true },
    });
    const matching = hooks.filter(
      (hook) => hook.events.length === 0 || hook.events.includes(event),
    );
    if (matching.length === 0) return;

    const sentAt = new Date().toISOString();

    // R24.10 — persist the outbox row (and its deliveryId) for EVERY receiver
    // before any network I/O starts; the payload carries `deliveryId` so
    // receivers can deduplicate.
    const scheduled: Promise<void>[] = [];
    for (const hook of matching) {
      const deliveryId = await createDeliveryRow(hook.id, event);
      const body = JSON.stringify({
        deliveryId: deliveryId ?? undefined, // omitted only when logging is down
        event,
        workspaceId,
        data,
        sentAt,
      });
      scheduled.push(
        deliverWithRetry(hook, event, body, { deliveryId, sleep: options.sleep }),
      );
    }
    for (const pending of scheduled) void pending.catch(() => {});
  } catch {
    /* never break the caller */
  }
}
