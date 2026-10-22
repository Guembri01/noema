/**
 * Parent-page scope guard (B08) — the single gate every write path passes a
 * `Page.parentId` through before it is stored.
 *
 * `Page.parentId` is a plain foreign key: the schema has no composite
 * `(parentId, workspaceId)` constraint, so nothing but the application keeps a
 * page inside its own workspace. Without this guard a member of workspace A can
 * point a new page at a page in workspace B. The row then shows up as a row of
 * B's database view (and of B's CSV/JSON database export), and Postgres'
 * `onDelete: Cascade` deletes it together with B's parent — outside A's tenant
 * boundary, without upload cleanup and without an audit entry.
 *
 * The check is tenant-scoped in the query itself (`{ id, workspaceId }`), so a
 * foreign parent is never even read, and the rejection message never names it:
 * the caller learns that the parent does not exist *in this workspace*, not
 * that it exists somewhere else.
 *
 * Fail-closed by construction: a blank workspace id matches no row, a missing
 * parent matches no row, a parent that is in the trash matches no row (the
 * query asks for the live rows — a page under a trashed parent would be
 * invisible in the tree and would be purged with the parent's own trash), and
 * a parent that is the page itself is refused.
 */

import { prisma } from "@/lib/db";
import type { WorkspaceRole } from "@prisma/client";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";

/** The message every unusable parent gets (it never names the foreign page). */
export const INVALID_PARENT_ERROR = "That parent page does not exist in this workspace.";

/** The message a parent the caller may only read/comment on gets. */
export const PARENT_EDIT_ERROR = "You do not have permission to add a page here.";

/** The message a self-parent gets (a page can never be its own parent). */
export const SELF_PARENT_ERROR = "A page cannot be its own parent.";

/** The outcome of a parent-scope check. */
export type ParentScope =
  | { ok: true; parentId: string | null }
  | { error: string };

/**
 * Resolve the parent a write may hang under.
 *
 * - No parent (`null` / `undefined` / blank) → the workspace root; always
 *   allowed and reported back as `null`.
 * - A parent that lives in `workspaceId` and is not in the trash → allowed. The
 *   returned id is the *validated* one, so a caller can only ever write the
 *   parent it proved.
 * - A parent in another workspace, a parent that does not exist, a parent in
 *   the trash, or the page itself → refused with an error that never leaks
 *   the foreign page.
 */
export async function assertScopedParent(input: {
  /** The workspace the write is scoped to. */
  workspaceId: string;
  /** The requested parent; `null`/`undefined` means the workspace root. */
  parentId?: string | null;
  /** The page being written — it may not be its own parent. */
  pageId?: string | null;
}): Promise<ParentScope> {
  const parentId = typeof input.parentId === "string" ? input.parentId.trim() : "";
  if (parentId === "") return { ok: true, parentId: null };
  if (input.pageId && input.pageId === parentId) {
    return { error: SELF_PARENT_ERROR };
  }
  const parent = await prisma.page.findFirst({
    where: { id: parentId, workspaceId: input.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!parent) return { error: INVALID_PARENT_ERROR };
  return { ok: true, parentId: parent.id };
}

/**
 * `assertScopedParent` plus the caller's page-level edit right on the parent.
 *
 * A page row is a restriction, not an inheritance grant, so a parent with a
 * `READ`/`COMMENT` row must not become a writable branch just because the
 * workspace role is `MEMBER`. This is the guard every page-create path uses
 * when it accepts a `parentId` from the client.
 */
export async function assertEditableParent(input: {
  workspaceId: string;
  parentId?: string | null;
  /** The page being moved — it may not be its own parent. */
  pageId?: string | null;
  userId: string;
  role: WorkspaceRole;
}): Promise<ParentScope> {
  const scope = await assertScopedParent({
    workspaceId: input.workspaceId,
    parentId: input.parentId,
    pageId: input.pageId,
  });
  if ("error" in scope) return scope;
  if (!scope.parentId) return scope;

  const parent = await prisma.page.findFirst({
    // Re-assert the tenant/trash invariants in the capability lookup: the
    // parent may have been trashed between the two reads.
    where: { id: scope.parentId, workspaceId: input.workspaceId, deletedAt: null },
    select: {
      permissions: {
        where: { userId: input.userId },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!parent) return { error: INVALID_PARENT_ERROR };
  if (!pageCapabilitiesFromRelation(input.role, parent.permissions).edit) {
    return { error: PARENT_EDIT_ERROR };
  }
  return scope;
}
