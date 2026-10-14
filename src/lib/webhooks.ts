import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";

export const WEBHOOK_EVENTS = [
  "page.created",
  "page.updated",
  "row.created",
  "comment.created",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 2_000, 8_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function recordDelivery(
  webhookId: string,
  event: string,
  ok: boolean,
  responseStatus: number | null,
  attempts: number,
  error: string | null,
): Promise<void> {
  try {
    await prisma.webhookDelivery.create({
      data: { webhookId, event, ok, responseStatus, attempts, error },
    });
  } catch {
    /* delivery logging must never throw */
  }
}

/** Attempt delivery with bounded exponential backoff, recording the outcome. */
async function deliverWithRetry(
  hook: { id: string; url: string; secret: string | null },
  event: WebhookEvent,
  body: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-noema-event": event,
  };
  if (hook.secret) {
    headers["x-noema-signature"] = createHmac("sha256", hook.secret)
      .update(body)
      .digest("hex");
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 2_000);
    try {
      const response = await fetch(hook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5_000),
      });
      await recordDelivery(hook.id, event, response.ok, response.status, attempt, null);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  await recordDelivery(hook.id, event, false, null, MAX_ATTEMPTS, lastError);
}

/**
 * Deliver an event to every active matching webhook for a workspace.
 * Network delivery runs in the background (with retries); this resolves as soon
 * as deliveries are scheduled so callers never block on a webhook endpoint.
 */
export async function dispatchWebhooks(
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
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

    const body = JSON.stringify({
      event,
      workspaceId,
      data,
      sentAt: new Date().toISOString(),
    });

    for (const hook of matching) {
      void deliverWithRetry(hook, event, body);
    }
  } catch {
    /* never break the caller */
  }
}
