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
 * parent matches no row, and a parent that is the page itself is refused.
 */

import { prisma } from "@/lib/db";

/** The message every unusable parent gets (it never names the foreign page). */
export const INVALID_PARENT_ERROR = "That parent page does not exist in this workspace.";

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
 * - A parent that lives in `workspaceId` → allowed. The returned id is the
 *   *validated* one, so a caller can only ever write the parent it proved.
 * - A parent in another workspace, a parent that does not exist, or the page
 *   itself → refused with an error that never leaks the foreign page.
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
    where: { id: parentId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!parent) return { error: INVALID_PARENT_ERROR };
  return { ok: true, parentId: parent.id };
}
