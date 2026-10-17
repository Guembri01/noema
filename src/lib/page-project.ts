/**
 * Project scope guard — the single gate every write path passes a
 * `Page.projectId` through before it is stored.
 *
 * `Page.projectId` is a plain foreign key: the schema has no composite
 * `(projectId, workspaceId)` constraint, so nothing but the application keeps
 * a page inside its own workspace. Without this guard a member of workspace A
 * can point a new page at a project in workspace B. The row then shows up in
 * B's project view — with its title and its icon — and in B's page count.
 *
 * The check is tenant-scoped in the query itself (`{ id, workspaceId }`), so a
 * foreign project is never even read, and the rejection message never names
 * it: the caller learns that the project does not exist *in this workspace*,
 * not that it exists somewhere else.
 *
 * Fail-closed by construction: a blank workspace id matches no row, a missing
 * project matches no row, and a project of another workspace matches no row.
 */

import { prisma } from "@/lib/db";

/** The message every unusable project gets (it never names the foreign project). */
export const INVALID_PROJECT_ERROR = "That project does not exist in this workspace.";

/** The outcome of a project-scope check. */
export type ProjectScope =
  | { ok: true; projectId: string | null }
  | { error: string };

/**
 * Resolve the project a write may point at.
 *
 * A write without a project is fine (the field is optional): the result
 * carries `null` then. A project that does not live in the caller's
 * workspace is refused before anything is written.
 */
export async function assertScopedProject(input: {
  workspaceId: string;
  projectId?: string | null;
}): Promise<ProjectScope> {
  const projectId = (input.projectId ?? "").trim();
  if (projectId === "") return { ok: true, projectId: null };
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!project) return { error: INVALID_PROJECT_ERROR };
  return { ok: true, projectId: project.id };
}
