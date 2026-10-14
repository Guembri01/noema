"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canManageMembers } from "@/lib/permissions";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";

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
    (WEBHOOK_EVENTS as readonly string[]).includes(event),
  );

  await prisma.webhook.create({
    data: {
      workspaceId: input.workspaceId,
      url: url.toString(),
      events,
      secret: input.secret?.trim() || null,
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
