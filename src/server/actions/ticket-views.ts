"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";

export type TicketViewConfig = {
  status?: string;
  priority?: string;
  labelId?: string;
  assigneeId?: string;
  projectId?: string;
  query?: string;
  hideClosed?: boolean;
  view?: "list" | "board" | "timeline";
};

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/** Save the tracker's current filters as a named view for the whole workspace. */
export async function saveTicketViewAction(input: {
  workspaceId: string;
  name: string;
  config: TicketViewConfig;
}): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to save views here." };
  }
  const name = input.name.trim().slice(0, 40);
  if (!name) return { error: "Give the view a name." };

  const existing = await prisma.ticketView.findUnique({
    where: { workspaceId_name: { workspaceId: input.workspaceId, name } },
    select: { id: true },
  });
  if (existing) {
    await prisma.ticketView.update({
      where: { id: existing.id },
      data: { config: input.config as Prisma.InputJsonValue },
    });
    revalidatePath("/w", "layout");
    return { ok: true, id: existing.id };
  }

  const view = await prisma.ticketView.create({
    data: {
      workspaceId: input.workspaceId,
      createdById: user.id,
      name,
      config: input.config as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: view.id };
}

export async function deleteTicketViewAction(viewId: string): Promise<Result> {
  const user = await requireUser();
  const view = await prisma.ticketView.findUnique({
    where: { id: viewId },
    select: { workspaceId: true },
  });
  if (!view) return { error: "View not found." };
  const access = await getWorkspaceAccess(user.id, view.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to delete views here." };
  }
  await prisma.ticketView.delete({ where: { id: viewId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}
