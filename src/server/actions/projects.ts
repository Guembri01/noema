"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { sanitizeDescription } from "@/lib/description";

export type ProjectResult<T = unknown> = ({ ok: true } & T) | { error: string };

const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
const MILESTONE_STATUSES = ["planned", "in_progress", "done"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

function cleanName(value: string, fallback: string) {
  return value.trim().slice(0, 200) || fallback;
}

/** Create a project in the workspace. */
export async function createProjectAction(input: {
  workspaceId: string;
  name: string;
  summary?: string;
  description?: string;
  color?: string;
  icon?: string;
  dueDate?: string | null;
}): Promise<ProjectResult<{ id: string; slug: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create projects." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const last = await prisma.project.findFirst({
    where: { workspaceId: input.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: input.workspaceId,
      name: cleanName(input.name, "Untitled project"),
      summary: input.summary?.trim().slice(0, 500) || null,
      description: sanitizeDescription(input.description ?? "") || null,
      color: input.color ?? "blue",
      icon: input.icon?.slice(0, 8) || null,
      ownerId: user.id,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      position: (last?.position ?? 0) + 1000,
    },
    select: { id: true },
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: project.id, slug: workspace.slug };
}

/** Update project fields (name, summary, status, colour, dates, owner). */
export async function updateProjectAction(input: {
  projectId: string;
  name?: string;
  summary?: string | null;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  dueDate?: string | null;
  startDate?: string | null;
}): Promise<ProjectResult> {
  const user = await requireUser();
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { workspaceId: true },
  });
  if (!project) return { error: "Project not found." };
  const access = await getWorkspaceAccess(user.id, project.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit projects." };
  }
  if (input.status && !PROJECT_STATUSES.includes(input.status)) {
    return { error: "Unknown project status." };
  }

  await prisma.project.update({
    where: { id: input.projectId },
    data: {
      ...(input.name !== undefined ? { name: cleanName(input.name, "Untitled project") } : {}),
      ...(input.summary !== undefined
        ? { summary: input.summary?.trim().slice(0, 500) || null }
        : {}),
      ...(input.description !== undefined
        ? { description: sanitizeDescription(input.description ?? "") || null }
        : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.color ? { color: input.color.slice(0, 20) } : {}),
      ...(input.startDate !== undefined
        ? { startDate: input.startDate ? new Date(input.startDate) : null }
        : {}),
      ...(input.dueDate !== undefined
        ? { dueDate: input.dueDate ? new Date(input.dueDate) : null }
        : {}),
    },
  });

  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Delete a project (pages and milestones are detached, not deleted). */
export async function deleteProjectAction(projectId: string): Promise<ProjectResult> {
  const user = await requireUser();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) return { error: "Project not found." };
  const access = await getWorkspaceAccess(user.id, project.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "Only workspace admins can delete projects." };
  }
  await prisma.project.delete({ where: { id: projectId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Attach (or detach) a page from a project. */
export async function setPageProjectAction(
  pageId: string,
  projectId: string | null,
): Promise<ProjectResult> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to move this page." };
  }
  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project || project.workspaceId !== page.workspaceId) {
      return { error: "That project belongs to another workspace." };
    }
  }
  await prisma.page.update({ where: { id: pageId }, data: { projectId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Add a milestone to a project. */
export async function addMilestoneAction(input: {
  projectId: string;
  name: string;
  description?: string;
  dueDate?: string | null;
}): Promise<ProjectResult<{ id: string }>> {
  const user = await requireUser();
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { workspaceId: true },
  });
  if (!project) return { error: "Project not found." };
  const access = await getWorkspaceAccess(user.id, project.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit this project." };
  }
  if (!input.name.trim()) return { error: "Give the milestone a name." };

  const last = await prisma.milestone.findFirst({
    where: { projectId: input.projectId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const milestone = await prisma.milestone.create({
    data: {
      projectId: input.projectId,
      name: cleanName(input.name, "Milestone"),
      description: input.description?.trim().slice(0, 500) || null,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      position: (last?.position ?? 0) + 1000,
    },
    select: { id: true },
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: milestone.id };
}

/** Move a milestone through planned → in progress → done. */
export async function updateMilestoneAction(input: {
  milestoneId: string;
  name?: string;
  status?: MilestoneStatus;
  dueDate?: string | null;
  description?: string | null;
}): Promise<ProjectResult> {
  const user = await requireUser();
  const milestone = await prisma.milestone.findUnique({
    where: { id: input.milestoneId },
    select: { projectId: true, project: { select: { workspaceId: true } } },
  });
  if (!milestone) return { error: "Milestone not found." };
  const access = await getWorkspaceAccess(user.id, milestone.project.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit this project." };
  }
  if (input.status && !MILESTONE_STATUSES.includes(input.status)) {
    return { error: "Unknown milestone status." };
  }

  await prisma.milestone.update({
    where: { id: input.milestoneId },
    data: {
      ...(input.name !== undefined ? { name: cleanName(input.name, "Milestone") } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim().slice(0, 500) || null }
        : {}),
      ...(input.status
        ? { status: input.status, completedAt: input.status === "done" ? new Date() : null }
        : {}),
      ...(input.dueDate !== undefined
        ? { dueDate: input.dueDate ? new Date(input.dueDate) : null }
        : {}),
    },
  });

  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Remove a milestone. */
export async function deleteMilestoneAction(milestoneId: string): Promise<ProjectResult> {
  const user = await requireUser();
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: { project: { select: { workspaceId: true } } },
  });
  if (!milestone) return { error: "Milestone not found." };
  const access = await getWorkspaceAccess(user.id, milestone.project.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit this project." };
  }
  await prisma.milestone.delete({ where: { id: milestoneId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}
