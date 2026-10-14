"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { logActivity } from "@/lib/activity";

export type CycleResult<T = unknown> = ({ ok: true } & T) | { error: string };

const isoDay = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`);

/** Create a sprint/cycle for a workspace. */
export async function createCycleAction(input: {
  workspaceId: string;
  name: string;
  startDate: string;
  endDate: string;
  goal?: string;
}): Promise<CycleResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to plan cycles here." };
  }
  const name = input.name.trim().slice(0, 60);
  if (!name) return { error: "Give the cycle a name." };
  const start = isoDay(input.startDate);
  const end = isoDay(input.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Pick a start and end date." };
  }
  if (end < start) return { error: "The end date must be after the start date." };

  const existing = await prisma.cycle.findUnique({
    where: { workspaceId_name: { workspaceId: input.workspaceId, name } },
    select: { id: true },
  });
  if (existing) return { error: "A cycle with that name already exists." };

  const cycle = await prisma.cycle.create({
    data: {
      workspaceId: input.workspaceId,
      name,
      startDate: start,
      endDate: end,
      goal: input.goal?.trim().slice(0, 200) || null,
    },
    select: { id: true },
  });
  await logActivity({
    workspaceId: input.workspaceId,
    actorId: user.id,
    action: "cycle.created",
    targetType: "workspace",
    targetId: cycle.id,
    meta: { name },
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: cycle.id };
}

export async function updateCycleAction(input: {
  cycleId: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  goal?: string | null;
}): Promise<CycleResult> {
  const user = await requireUser();
  const cycle = await prisma.cycle.findUnique({
    where: { id: input.cycleId },
    select: { id: true, workspaceId: true },
  });
  if (!cycle) return { error: "Cycle not found." };
  const access = await getWorkspaceAccess(user.id, cycle.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to change this cycle." };
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 60);
    if (!name) return { error: "Name cannot be empty." };
    data.name = name;
  }
  if (input.startDate !== undefined) data.startDate = isoDay(input.startDate);
  if (input.endDate !== undefined) data.endDate = isoDay(input.endDate);
  if (input.goal !== undefined) data.goal = input.goal?.trim().slice(0, 200) || null;
  if (Object.keys(data).length === 0) return { ok: true };

  await prisma.cycle.update({ where: { id: input.cycleId }, data });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Delete a cycle; its tickets stay in the workspace, just unscheduled. */
export async function deleteCycleAction(cycleId: string): Promise<CycleResult> {
  const user = await requireUser();
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!cycle) return { error: "Cycle not found." };
  const access = await getWorkspaceAccess(user.id, cycle.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to delete this cycle." };
  }
  await prisma.cycle.delete({ where: { id: cycleId } });
  await logActivity({
    workspaceId: cycle.workspaceId,
    actorId: user.id,
    action: "cycle.deleted",
    targetType: "workspace",
    targetId: cycleId,
    meta: { name: cycle.name },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Put a ticket in a cycle (or take it out with `cycleId: null`). */
export async function assignTicketToCycleAction(
  ticketId: string,
  cycleId: string | null,
): Promise<CycleResult> {
  const user = await requireUser();
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, workspaceId: true },
  });
  if (!ticket) return { error: "Ticket not found." };
  const access = await getWorkspaceAccess(user.id, ticket.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to schedule tickets." };
  }

  if (cycleId) {
    const cycle = await prisma.cycle.findUnique({
      where: { id: cycleId },
      select: { workspaceId: true },
    });
    if (!cycle || cycle.workspaceId !== ticket.workspaceId) {
      return { error: "That cycle is not in this workspace." };
    }
  }

  await prisma.ticket.update({ where: { id: ticketId }, data: { cycleId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}
