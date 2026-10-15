"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canManageMembers } from "@/lib/permissions";
import { WEBHOOK_EVENTS, encryptWebhookSecret } from "@/lib/webhooks";
import {
  isWebhookEventType,
  matchesSubscription,
} from "@/lib/webhook-event-catalog";

/**
 * B91 follow-up — a stored subscription is either an exact event id or a
 * wildcard pattern (`*`, `page.*`) that selects at least one catalog event.
 * Anything else (a bare prefix like `page`, an unknown `nope.*`) selects
 * nothing at dispatch time, so it is dropped here instead of being persisted.
 */
function isSupportedSubscription(subscription: string): boolean {
  if (isWebhookEventType(subscription)) return true;
  return WEBHOOK_EVENTS.some((event) =>
    matchesSubscription(event, subscription),
  );
}

export async function createWebhookAction(input: {
  workspaceId: string;
  url: string;
  events: string[];
  secret?: string;
}): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage webhooks." };
  }

  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return { error: "Enter a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http(s) webhook URLs are allowed." };
  }

  const events = input.events.filter((event) =>
    isSupportedSubscription(event),
  );

  // R28.17 — signed deliveries only: a non-empty secret is mandatory, and it is
  // sealed (AES-256-GCM keyring envelope) before it reaches the database.
  const secret = input.secret?.trim();
  if (!secret) {
    return { error: "A signing secret is required." };
  }

  await prisma.webhook.create({
    data: {
      workspaceId: input.workspaceId,
      url: url.toString(),
      events,
      secret: encryptWebhookSecret(secret),
    },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function deleteWebhookAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const webhook = await prisma.webhook.findUnique({
    where: { id },
    select: { workspaceId: true },
  });
  if (!webhook) return { error: "Webhook not found." };
  const access = await getWorkspaceAccess(user.id, webhook.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage webhooks." };
  }
  await prisma.webhook.delete({ where: { id } });
  revalidatePath("/w", "layout");
  return { ok: true };
}
