import type { SharePermission, WorkspaceRole } from "@prisma/client";

/**
 * Effective access to one page, after the workspace role and the page-level
 * `PagePermission` row have both been applied.
 *
 * The page row is a *restriction* for the roles the workspace matrix lets
 * write, never a grant: a user with no explicit row keeps the role's normal
 * access. Owner and admin are immune, so a member cannot lock an
 * administrator out of a page they are responsible for.
 */
export type PageCapabilities = {
  /** May open the page and read its content. */
  read: boolean;
  /** May add, edit, resolve and delete comments. */
  comment: boolean;
  /** May change the page body, layout, metadata and child pages. */
  edit: boolean;
  /** May change the page's share links and page-level permissions. */
  share: boolean;
};

const DENY: PageCapabilities = {
  read: false,
  comment: false,
  edit: false,
  share: false,
};

const ALLOW: PageCapabilities = {
  read: true,
  comment: true,
  edit: true,
  share: true,
};

/**
 * Resolve the capabilities of `role` with an explicit page permission.
 *
 * Semantics:
 * - OWNER / ADMIN: always full access. Page restrictions are a member's tool;
 *   they never apply to the people who administer the workspace.
 * - MEMBER: no row keeps the role's write access. READ is read-only, COMMENT
 *   adds comments, EDIT/FULL keep writing. Sharing follows edit access.
 * - GUEST: a guest is read-only in the workspace. READ blocks comments;
 *   COMMENT (and legacy EDIT/FULL rows, which cannot be assigned any more)
 *   allow comments on a page the guest can already read. Guest editing stays
 *   off until the product implements it.
 * - Unknown / missing role: deny everything.
 *
 * This function only answers "what may this role do on a page it can reach".
 * A guest's *reach* is still the separate guest read scope
 * (`guestReadablePageIds` / `pageScopeFor`).
 */
export function pageCapabilities(
  role: WorkspaceRole | null | undefined,
  level: SharePermission | null | undefined,
): PageCapabilities {
  if (!role) return DENY;

  if (role === "OWNER" || role === "ADMIN") return ALLOW;

  if (role === "MEMBER") {
    if (!level) return ALLOW;
    switch (level) {
      case "READ":
        return { read: true, comment: false, edit: false, share: false };
      case "COMMENT":
        return { read: true, comment: true, edit: false, share: false };
      case "EDIT":
      case "FULL":
        return ALLOW;
      default:
        return DENY;
    }
  }

  if (role === "GUEST") {
    // Reach is checked separately. A guest with no row may comment on the
    // pages they can open (teamspace pages and their own pages); an explicit
    // READ row opts the page out of that.
    return {
      read: true,
      comment: level !== "READ",
      edit: false,
      share: false,
    };
  }

  return DENY;
}

/** The first explicit level of a page relation row, if any. */
export function pagePermissionLevel(
  rows: readonly { level: SharePermission }[] | null | undefined,
): SharePermission | null {
  return rows?.[0]?.level ?? null;
}

/** Convenience: capabilities from a Prisma page relation select. */
export function pageCapabilitiesFromRelation(
  role: WorkspaceRole | null | undefined,
  rows: readonly { level: SharePermission }[] | null | undefined,
): PageCapabilities {
  return pageCapabilities(role, pagePermissionLevel(rows));
}

/** The levels a page permission may be set to. */
export const ASSIGNABLE_PAGE_LEVELS: readonly SharePermission[] = [
  "READ",
  "COMMENT",
  "EDIT",
  "FULL",
];

/**
 * The levels a guest may hold. Guest editing is not implemented, so only the
 * two read/comment levels are meaningful; existing EDIT/FULL rows keep their
 * comment access (see `pageCapabilities`) but cannot be assigned again.
 */
export const ASSIGNABLE_GUEST_LEVELS: readonly SharePermission[] = [
  "READ",
  "COMMENT",
];
