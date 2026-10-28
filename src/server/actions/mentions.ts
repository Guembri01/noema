"use server";

import { requireUser } from "@/lib/auth";
import { pageScopeFor } from "@/lib/guest-access";
import { scopeMentionSuggestions } from "@/lib/mentions";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";

export type MentionSuggestion = {
  id: string;
  label: string;
  type: "page" | "user";
  icon?: string | null;
};

/**
 * A comment mention can point at any workspace object a reader can navigate
 * to. Pages cover both documents and notes (they share one table); projects
 * and their milestones get their own kinds so the renderer can build the
 * right link instead of treating every id as a page id.
 */
export type CommentMentionSuggestion = {
  id: string;
  label: string;
  type: "page" | "user" | "project" | "milestone";
  icon?: string | null;
  /** Set for milestone suggestions: the project that owns the milestone. */
  projectId?: string;
};

/** Suggest pages and workspace members for the @-mention menu. */
export async function mentionSearchAction(
  workspaceId: string,
  query: string,
): Promise<MentionSuggestion[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return [];

  // B18 scoping: a guest may only ever be offered pages they can open, and
  // the workspace member directory is not exposed to them (the editor is
  // read-only for GUEST, but the action must not leak on its own either).
  const scope = await pageScopeFor(user.id, workspaceId, access.role);
  const isGuest = access.role === "GUEST";
  const q = query.trim();

  const [pages, members] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(scope ? { id: { in: [...scope] } } : {}),
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, icon: true },
    }),
    (
      isGuest
        ? Promise.resolve([])
        : prisma.workspaceMember.findMany({
            where: {
              workspaceId,
              ...(q ? { user: { name: { contains: q, mode: "insensitive" } } } : {}),
            },
            take: 8,
            select: { user: { select: { id: true, name: true } } },
          })
    ) as Promise<{ user: { id: string; name: string } }[]>,
  ]);

  const suggestions: MentionSuggestion[] = [
    ...pages.map((p) => ({
      id: p.id,
      label: p.title || "Untitled",
      type: "page" as const,
      icon: p.icon,
    })),
    ...members.map((m) => ({
      id: m.user.id,
      label: m.user.name,
      type: "user" as const,
    })),
  ];

  // Second layer of the same rule (the query above already filters): the
  // pure helper is what the unit tests pin down.
  return scopeMentionSuggestions(suggestions, scope);
}

/**
 * Comment composer suggestions: pages/notes, people, projects and milestones.
 *
 * The editor's mention menu only knows document targets, so this is a separate
 * action rather than widening `mentionSearchAction` — inserting a project into
 * a ProseMirror document would produce a mention atom the editor cannot link.
 * Guests only get the page list (the same B18 rule); projects and their
 * milestones are workspace-level objects and stay hidden from them.
 */
export async function commentMentionSearchAction(
  workspaceId: string,
  query: string,
): Promise<CommentMentionSuggestion[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return [];

  const base = await mentionSearchAction(workspaceId, query);
  if (access.role === "GUEST") return base;

  const q = query.trim();
  const [projects, milestones] = await Promise.all([
    prisma.project.findMany({
      where: {
        workspaceId,
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, name: true, icon: true },
    }),
    prisma.milestone.findMany({
      where: {
        project: { workspaceId },
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, project: { select: { id: true, name: true } } },
    }),
  ]);

  return [
    ...base,
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      type: "project" as const,
      icon: project.icon,
    })),
    ...milestones.map((milestone) => ({
      id: milestone.id,
      label: `${milestone.name} · ${milestone.project.name}`,
      type: "milestone" as const,
      projectId: milestone.project.id,
    })),
  ].slice(0, 20);
}
