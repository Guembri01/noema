import type { SharePermission, WorkspaceRole } from "@prisma/client";

/**
 * Page-level effective access with permission inheritance
 * (MISSING_FEATURES §8: permission inheritance, per-page permissions,
 * access audit view).
 *
 * Pure logic only — callers fetch the page's ancestors, its `PagePermission`
 * rows and its `ShareLink` rows, then hand them to `effectiveAccess` /
 * `describeAccess`. Nothing here touches the database.
 *
 * Levels are the repo's existing `SharePermission` enum; there is no parallel
 * enum and no "NONE" member — the absence of access is `null`. This keeps the
 * fail-closed convention from `permissions.ts`: no grant, no inheritance and
 * no link share means NO access, never an implicit allow.
 *
 * Resolution rules:
 * - Workspace OWNER/ADMIN have an implicit FULL baseline on every page
 *   (matching `canPerformWorkspaceAction`, where they may manage everything).
 *   MEMBER/GUEST and unknown roles get no implicit access: they need an
 *   explicit grant or a link share.
 * - Grants inherit: a `PagePermission` on the page itself or on any ancestor
 *   applies. The nearest grant wins (page before parent before grandparent),
 *   even when it is more restrictive than an ancestor's.
 * - Link shares apply only to the page they point at, never to children, and
 *   expire fail-closed (`expiresAt <= now` is already closed).
 * - The final level is the strongest of the applicable sources; it is `null`
 *   when no source applies.
 */

/** Semantic alias for the existing enum; `null` means "no access". */
export type AccessLevel = SharePermission;

/** The viewer: their workspace role, or null for anonymous / non-member. */
export type AccessUser = { id: string; role: WorkspaceRole | null };

/** A `PagePermission` row, reduced to what resolution needs. */
export type PageGrant = { pageId: string; userId: string; level: SharePermission };

/** A `ShareLink` row, reduced to what resolution needs. */
export type LinkShare = {
  pageId: string;
  permission: SharePermission;
  expiresAt?: Date | null;
};

/** How an access level was obtained. */
export type AccessSource = "direct" | "inherited" | "role" | "link";

/** One row of the "Who can access" panel. `userId: null` is the public link. */
export type AccessEntry = { userId: string | null; level: AccessLevel; source: AccessSource };

export type EffectiveAccessInput = {
  user: AccessUser | null;
  page: { id: string };
  /** Ancestor page ids, nearest first (immediate parent, then its parent…). */
  ancestry?: readonly string[];
  /** `PagePermission` rows for the page and its ancestors. */
  grants?: readonly PageGrant[];
  /** `ShareLink` rows pointing at the page. */
  linkShares?: readonly LinkShare[];
  /** Evaluation instant for link expiry; defaults to now. */
  now?: Date;
};

export type DescribeAccessInput = {
  page: { id: string };
  ancestry?: readonly string[];
  grants?: readonly PageGrant[];
  /** Workspace roster (id + role) to resolve per-user access for. */
  users: readonly AccessUser[];
  linkShares?: readonly LinkShare[];
  now?: Date;
};

const LEVEL_ORDER: readonly SharePermission[] = ["READ", "COMMENT", "EDIT", "FULL"];

const ROLE_BASELINE: SharePermission = "FULL";

/** Fail closed: anything outside the known enum is not a level. */
export function isSharePermission(value: unknown): value is SharePermission {
  return typeof value === "string" && (LEVEL_ORDER as readonly string[]).includes(value);
}

function rank(level: SharePermission): number {
  return LEVEL_ORDER.indexOf(level);
}

/** The strongest of the candidate levels, or null when none apply. */
function strongest(
  ...levels: (AccessLevel | null)[]
): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const level of levels) {
    if (level !== null && (best === null || rank(level) > rank(best))) best = level;
  }
  return best;
}

/**
 * The viewer's role baseline: FULL for the workspace owner and admins,
 * nothing for members, guests, non-members and forged roles.
 */
function roleBaseline(role: WorkspaceRole | null | undefined): AccessLevel | null {
  if (role === "OWNER" || role === "ADMIN") return ROLE_BASELINE;
  return null;
}

/**
 * The nearest grant for the user along `[page, ...ancestry]`. Nearest wins:
 * a page-level grant overrides an inherited one even when it grants less.
 */
function resolveGrant(
  userId: string,
  pageId: string,
  ancestry: readonly string[],
  grants: readonly PageGrant[],
): { level: AccessLevel; source: "direct" | "inherited" } | null {
  const chain = [pageId, ...ancestry];
  for (const id of chain) {
    let best: AccessLevel | null = null;
    for (const grant of grants) {
      if (grant.userId !== userId || grant.pageId !== id) continue;
      if (!isSharePermission(grant.level)) continue;
      if (best === null || rank(grant.level) > rank(best)) best = grant.level;
    }
    if (best !== null) {
      return { level: best, source: id === pageId ? "direct" : "inherited" };
    }
  }
  return null;
}

/**
 * The strongest valid link share pointing at the page itself. Expired links
 * (and links for other pages) grant nothing.
 */
function resolveLink(
  pageId: string,
  linkShares: readonly LinkShare[] | undefined,
  now: Date,
): AccessLevel | null {
  if (!linkShares) return null;
  let best: AccessLevel | null = null;
  for (const share of linkShares) {
    if (share.pageId !== pageId) continue;
    if (!isSharePermission(share.permission)) continue;
    if (share.expiresAt && share.expiresAt.getTime() <= now.getTime()) continue;
    if (best === null || rank(share.permission) > rank(best)) best = share.permission;
  }
  return best;
}

/**
 * A user's effective access to a page, combining their workspace role, the
 * nearest explicit grant on the page or an ancestor, and any public link
 * share on the page. Returns `null` when nothing grants access (fail closed).
 */
export function effectiveAccess(input: EffectiveAccessInput): AccessLevel | null {
  const now = input.now ?? new Date();
  const ancestry = input.ancestry ?? [];
  const grants = input.grants ?? [];
  const grant = input.user
    ? resolveGrant(input.user.id, input.page.id, ancestry, grants)
    : null;
  return strongest(
    input.user ? roleBaseline(input.user.role) : null,
    grant?.level ?? null,
    resolveLink(input.page.id, input.linkShares, now),
  );
}

/**
 * Resolved access for a page: every roster member who can reach it (and how),
 * plus any user outside the roster still holding a grant — an audit view must
 * show those stale grants — plus one anonymous entry for a public link.
 * Users with no access are omitted. Fail closed: an empty list means nobody.
 */
export function describeAccess(input: DescribeAccessInput): AccessEntry[] {
  const now = input.now ?? new Date();
  const ancestry = input.ancestry ?? [];
  const grants = input.grants ?? [];
  const entries: AccessEntry[] = [];
  const seen = new Set<string>();

  for (const member of input.users) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);

    const baseline = roleBaseline(member.role);
    const grant = resolveGrant(member.id, input.page.id, ancestry, grants);
    const level = strongest(baseline, grant?.level ?? null);
    if (level === null) continue;

    // Attribute the level to the most specific source that produces it: an
    // owner holding a direct FULL grant is labelled "direct", an admin whose
    // only FULL source is their role is labelled "role".
    const source: AccessSource =
      grant?.level === level
        ? grant.source
        : baseline === level
          ? "role"
          : (grant?.source ?? "role");
    entries.push({ userId: member.id, level, source });
  }

  // Grants held by users missing from the roster (removed members, guests who
  // left): the rows still grant access, so the audit view must surface them.
  for (const grant of grants) {
    if (seen.has(grant.userId)) continue;
    if (!isSharePermission(grant.level)) continue;
    const resolved = resolveGrant(grant.userId, input.page.id, ancestry, grants);
    if (!resolved) continue;
    seen.add(grant.userId);
    entries.push({ userId: grant.userId, level: resolved.level, source: resolved.source });
  }

  const link = resolveLink(input.page.id, input.linkShares, now);
  if (link !== null) entries.push({ userId: null, level: link, source: "link" });

  return entries;
}
