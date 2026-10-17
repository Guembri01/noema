/**
 * Guest page-scoping.
 *
 * A `GUEST` is an external collaborator: they may only open pages that were
 * explicitly shared with them (a `PagePermission` row), pages inside a teamspace
 * they belong to, and pages they created themselves. Everyone else with any role
 * sees the whole workspace.
 *
 * The pure helpers here are unit-tested; `guestVisiblePageIds` is the query the
 * sidebar, search and the page route all use, so the rule cannot drift.
 */

import { randomUUID } from "node:crypto";
import { isValidEmail } from "@/lib/email-validation";
import { entitlementsFor, withinLimit, type PlanLimit } from "@/lib/plan-entitlements";
import { prisma } from "@/lib/db";

/** Minimal shape needed to walk parent chains. */
export type PageLink = { id: string; parentId: string | null };

/**
 * Add every ancestor of the given pages, so a shared child can still be reached
 * through the tree (the sidebar renders parent chains).
 */
export function withAncestors(visibleIds: Iterable<string>, pages: PageLink[]): Set<string> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const result = new Set<string>(visibleIds);
  for (const id of [...result]) {
    let cursor = byId.get(id)?.parentId ?? null;
    let guard = 0;
    while (cursor && guard < 200) {
      result.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
      guard += 1;
    }
  }
  return result;
}

/** True when the page is reachable for a guest (given the scoped id set). */
export function isVisibleToGuest(pageId: string, visibleIds: Set<string>): boolean {
  return visibleIds.has(pageId);
}

/**
 * A viewer's scope in one workspace: the pages they may open and the
 * teamspaces whose names they may see.
 *
 * Everybody but a guest sees the whole workspace; the callers represent that
 * as `null` instead of a scope (see `viewerScopeFor`).
 */
export type ViewerScope = {
  /** The page ids the viewer may see. */
  pageIds: Set<string>;
  /** The ids of the teamspaces whose names the viewer may see. */
  teamspaceIds: Set<string>;
};

/**
 * A guest's scope: the pages they may read and the teamspaces those pages
 * live in.
 *
 * The page scope is built from three sources — the explicit `PagePermission`
 * rows, the pages the guest created and the pages of the teamspaces they
 * belong to — plus the ancestors of all of those (`withAncestors`).
 *
 * The teamspace scope follows from that page scope: the teamspaces the guest
 * is a member of, plus the teamspaces the *visible* pages live in. The second
 * half is what a page that was shared with the guest contributes: the shared
 * page carries its own teamspace, and the teamspace root it hangs under is an
 * ancestor of it (so it is part of the page scope as well). Both are needed to
 * render the branch the guest may see — the sidebar draws a page under the
 * section of its teamspace and drops a root whose teamspace is not listed.
 *
 * The workspace's other teamspaces are in neither set, so their names never
 * travel to a guest.
 */
export async function guestScope(userId: string, workspaceId: string): Promise<ViewerScope> {
  const [permissions, memberships, created, pages] = await Promise.all([
    prisma.pagePermission.findMany({
      where: { userId, page: { workspaceId } },
      select: { pageId: true },
    }),
    prisma.teamspaceMember.findMany({
      where: { userId, teamspace: { workspaceId } },
      select: { teamspaceId: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, createdById: userId, deletedAt: null },
      select: { id: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, parentId: true, teamspaceId: true },
    }),
  ]);

  const teamspaceIds = new Set(memberships.map((member) => member.teamspaceId));
  const direct = new Set<string>([
    ...permissions.map((permission) => permission.pageId),
    ...created.map((page) => page.id),
  ]);
  for (const page of pages) {
    if (page.teamspaceId && teamspaceIds.has(page.teamspaceId)) direct.add(page.id);
  }
  const pageIds = withAncestors(direct, pages);

  // Every teamspace a visible page lives in joins the guest's own teamspaces:
  // that is the teamspace of a page that was shared with them and the
  // teamspace of the root it hangs under (that root is an ancestor of the
  // shared page, so it is part of the page scope as well).
  for (const page of pages) {
    if (page.teamspaceId && pageIds.has(page.id)) teamspaceIds.add(page.teamspaceId);
  }

  return { pageIds, teamspaceIds };
}

/**
 * Every page a guest may read in this workspace: explicit permissions, pages in
 * their teamspaces, and their own pages — plus the ancestors of all of those.
 */
export async function guestVisiblePageIds(
  userId: string,
  workspaceId: string,
): Promise<Set<string>> {
  const scope = await guestScope(userId, workspaceId);
  return scope.pageIds;
}

/**
 * The scope of a viewer: `null` when the viewer sees the whole workspace (every
 * role but `GUEST`), the guest scope otherwise.
 *
 * Callers hand `scope.pageIds` to the page queries (`getPageTree`,
 * `getFavorites`, `searchPages`) and `scope.teamspaceIds` to the teamspace
 * query, so both follow the same rule and cannot drift apart.
 */
export async function viewerScopeFor(
  userId: string,
  workspaceId: string,
  role: string,
): Promise<ViewerScope | null> {
  if (role !== "GUEST") return null;
  return guestScope(userId, workspaceId);
}

/**
 * The id filter to apply to a query, or `null` when the viewer sees everything.
 * Callers pass the result to `getPageTree`/`searchPages`.
 */
export async function pageScopeFor(
  userId: string,
  workspaceId: string,
  role: string,
): Promise<Set<string> | null> {
  const scope = await viewerScopeFor(userId, workspaceId, role);
  return scope ? scope.pageIds : null;
}

/* -------------------------------------------------------------------------- *
 * Pure scoping primitive
 *
 * The helpers below resolve a guest's scope from an in-memory page list, with
 * no database. They model *permission* propagation: a grant on a page covers
 * its whole subtree (descendants inherit it) but never its ancestors — knowing
 * a child exists does not let a guest open its parent, matching the "no
 * existence oracle" rule (`access-inheritance.ts` resolves grants along an
 * explicit ancestry chain the same way, nearest grant winning).
 *
 * NOTE: this is intentionally stricter than `withAncestors`, which adds
 * ancestor *rows* so the sidebar can render a breadcrumb path. Reaching an
 * ancestor to display the tree is not the same as being allowed to read it.
 * -------------------------------------------------------------------------- */

/** A page as the pure scoping helpers see it. */
export type GuestPage = {
  id: string;
  parentId: string | null;
  /** Guests granted read access on this exact page. */
  sharedWithGuestIds?: readonly string[];
  /** Guests granted edit access on this exact page (implies read). */
  editableGuestIds?: readonly string[];
};

function listsGuest(ids: readonly string[] | undefined, guestId: string): boolean {
  return Array.isArray(ids) && ids.includes(guestId);
}

function indexGuestPages(pages: readonly GuestPage[]): Map<string, GuestPage> {
  const byId = new Map<string, GuestPage>();
  for (const page of pages) {
    if (page && typeof page.id === "string") byId.set(page.id, page);
  }
  return byId;
}

/**
 * Every page a guest may **read**: the shared/editable pages plus their whole
 * subtree. Ancestors are never included by inheritance. Fails closed — a
 * blank/unknown guest id or an empty page list yields an empty set.
 */
export function visiblePageIdsForGuest(
  pages: readonly GuestPage[],
  guestId: string,
): Set<string> {
  const visible = new Set<string>();
  if (!guestId) return visible;

  const childrenOf = new Map<string, string[]>();
  for (const page of pages) {
    if (!page || typeof page.id !== "string") continue;
    if (typeof page.parentId !== "string") continue;
    const siblings = childrenOf.get(page.parentId);
    if (siblings) siblings.push(page.id);
    else childrenOf.set(page.parentId, [page.id]);
  }

  const queue: string[] = [];
  for (const page of pages) {
    if (!page || typeof page.id !== "string") continue;
    if (listsGuest(page.sharedWithGuestIds, guestId) || listsGuest(page.editableGuestIds, guestId)) {
      queue.push(page.id);
    }
  }

  // BFS down the tree; `visible` doubles as the visited set, so cycles stop.
  for (const id of queue) {
    if (visible.has(id)) continue;
    visible.add(id);
    const children = childrenOf.get(id);
    if (children) {
      for (const child of children) {
        if (!visible.has(child)) queue.push(child);
      }
    }
  }
  return visible;
}

/**
 * Whether a guest may open a page. Two call shapes share the name:
 *
 *  - the legacy page-list form, `(pages, guestId, pageId)`, resolves scope from
 *    permissions embedded on the page list;
 *  - the grant form, `(grant, { pageId, now })`, checks the page is inside the
 *    grant's explicit scope and that the grant is neither revoked nor expired.
 *
 * Both fail closed: an unknown guest/page, a blank id, a revoked grant and a
 * corrupt or closed window are all `false`.
 */
export function canGuestAccess(
  pages: readonly GuestPage[],
  guestId: string,
  pageId: string,
): boolean;
export function canGuestAccess(grant: GuestGrant, query: GuestAccessQuery): boolean;
export function canGuestAccess(
  pagesOrGrant: readonly GuestPage[] | GuestGrant,
  guestIdOrQuery: string | GuestAccessQuery,
  pageId?: string,
): boolean {
  if (Array.isArray(pagesOrGrant)) {
    const guestId = typeof guestIdOrQuery === "string" ? guestIdOrQuery : "";
    if (!guestId || typeof pageId !== "string" || pageId.length === 0) return false;
    return visiblePageIdsForGuest(pagesOrGrant as readonly GuestPage[], guestId).has(pageId);
  }
  return grantAllowsPage(pagesOrGrant as GuestGrant, guestIdOrQuery as GuestAccessQuery);
}

/**
 * The readable pages the guest may **edit** (a strict subset of
 * `visiblePageIdsForGuest`): a page is editable when an edit grant sits on it
 * or on any ancestor. Pages covered only by a read share stay in the visible
 * set but are omitted here. Fails closed on a blank guest id, and edit stops
 * at a broken/unknown ancestor chain rather than assuming a grant.
 */
export function guestEditablePageIds(
  pages: readonly GuestPage[],
  guestId: string,
): Set<string> {
  const editableIds = new Set<string>();
  if (!guestId) return editableIds;

  const byId = indexGuestPages(pages);
  for (const id of visiblePageIdsForGuest(pages, guestId)) {
    let cursor: string | null = id;
    let guard = 0;
    while (cursor && guard < 1000) {
      const page = byId.get(cursor);
      if (!page) break;
      if (listsGuest(page.editableGuestIds, guestId)) {
        editableIds.add(id);
        break;
      }
      cursor = typeof page.parentId === "string" ? page.parentId : null;
      guard += 1;
    }
  }
  return editableIds;
}

/* ========================================================================== *
 * Guest grants — the lifecycle engine for limited external collaborators
 * (`docs/specs/plans-licensing.md` §7 Guests, §8 R26.12 guest cap).
 *
 * A `GuestGrant` is the durable fact that one external email was invited to an
 * explicit set of pages, at a fixed role, for at most an optional window. The
 * helpers below are pure and synchronous: the clock is injected, nothing reads
 * the environment, and everything fails closed — an unknown email, a blank
 * page id, a revoked grant, a corrupt expiry or an unusable clock never widen
 * access. Scope is always explicit; a guest never sees the whole workspace.
 * ========================================================================== */

/** What a guest may do inside their granted scope. Guests never edit. */
export type GuestRole = "viewer" | "commenter";

/** Injected time: epoch millis, a parsable date string, or a `Date`. */
export type GuestTime = number | string | Date;

/** A guest grant: one email scoped to an explicit set of pages. */
export interface GuestGrant {
  /** Stable grant id, unique per workspace. */
  readonly id: string;
  /** Normalised (trimmed, lower-cased) guest email — the identity key. */
  readonly email: string;
  /** The workspace the grant lives in. */
  readonly workspaceId: string;
  /** The explicitly granted pages; the guest reaches these and their subtrees. */
  readonly pageIds: readonly string[];
  /** The capability the guest holds on that scope. */
  readonly role: GuestRole;
  /** ISO expiry, or `null` for a perpetual grant. */
  readonly expiresAt?: string | null;
  /** Who invited the guest (an internal user id or email). */
  readonly invitedBy: string;
  /** ISO creation stamp. */
  readonly createdAt: string;
}

/** A grant that has been revoked; carries when and (optionally) why. */
export interface GuestRevocation {
  readonly revokedAt: string;
  readonly reason: string | null;
}

/** The extra fields `revokeGrant` stamps onto a grant. */
export type RevokedGuestGrant = GuestGrant & GuestRevocation;

/** Stable rejection codes for {@link createGrant} / {@link revokeGrant}. */
export type GuestGrantErrorCode =
  | "invalid_email"
  | "invalid_workspace"
  | "invalid_inviter"
  | "invalid_role"
  | "invalid_page_ids"
  | "invalid_ttl"
  | "invalid_now";

/** Thrown when a grant cannot be constructed from the given input. */
export class GuestGrantError extends Error {
  readonly code: GuestGrantErrorCode;

  constructor(code: GuestGrantErrorCode, message: string) {
    super(message);
    this.name = "GuestGrantError";
    this.code = code;
  }
}

/** The input {@link createGrant} accepts. Email and role are untrusted JSON. */
export interface CreateGuestGrantInput {
  /** Optional id; a random uuid is minted when omitted. */
  readonly id?: string;
  readonly email: unknown;
  readonly workspaceId: string;
  readonly pageIds: readonly string[];
  readonly role: GuestRole;
  readonly invitedBy: string;
  readonly now: GuestTime;
  /** Positive lifetime in days; omitted/`null` means the grant never expires. */
  readonly ttlDays?: number | null;
}

/** The query {@link canGuestAccess}'s grant form evaluates. */
export interface GuestAccessQuery {
  readonly pageId: string;
  readonly now: GuestTime;
}

/** Who is asking, for {@link visiblePagesForGuest}. */
export interface GuestViewer {
  /** The viewer's email; matched case-insensitively against grant emails. */
  readonly email?: string | null;
  /** Reserved for a future direct user binding; grants carry no user id today. */
  readonly userId?: string | null;
}

export interface GuestVisibilityOptions {
  /** When supplied, expired grants are excluded. Omit to ignore expiry. */
  readonly now?: GuestTime;
}

/** The surviving/expired partition returned by {@link expireGrants}. */
export interface GuestExpirySweep {
  readonly active: readonly GuestGrant[];
  readonly expired: readonly GuestGrant[];
}

/** The restricted session view {@link toGuestSession} returns. */
export interface GuestSession {
  readonly kind: "guest";
  readonly email: string;
  readonly workspaceId: string;
  readonly role: GuestRole;
  readonly pageIds: readonly string[];
  readonly readOnly: boolean;
  readonly canView: true;
  readonly canComment: boolean;
  readonly canEdit: false;
  readonly expiresAt: string | null;
}

const MS_PER_DAY = 86_400_000;

/** Resolve an injected time to epoch millis (`NaN` when unusable). */
function toEpochMs(value: GuestTime): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/** ISO rendering of a time, or `null` when it is unusable. */
function isoTime(value: GuestTime): string | null {
  const ms = toEpochMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A trimmed, non-empty string, or `null` for anything else. */
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Render an untrusted value for a message without leaking structure. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value;
}

/**
 * Canonical guest identity: trimmed and lower-cased across the whole address
 * (guest matching is case-insensitive), or `null` when the value is not a
 * usable address. Reuses the shared RFC-ish check from `email-validation`.
 */
export function normalizeGuestEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isValidEmail(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** Dedupe an untrusted page list, rejecting empties — order is preserved. */
function normalizePageIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GuestGrantError("invalid_page_ids", "A grant needs at least one page id.");
  }
  const seen = new Set<string>();
  const pageIds: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new GuestGrantError(
        "invalid_page_ids",
        `Every page id must be a non-empty string (got ${show(raw)}).`,
      );
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      pageIds.push(raw);
    }
  }
  return pageIds;
}

/** Compute the ISO expiry for a ttl, or `null` for a perpetual grant. */
function expiryForTtl(ttlDays: number | null | undefined, nowMs: number): string | null {
  if (ttlDays === undefined || ttlDays === null) return null;
  if (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new GuestGrantError(
      "invalid_ttl",
      `ttlDays must be a positive number of days (got ${show(ttlDays)}).`,
    );
  }
  return new Date(nowMs + ttlDays * MS_PER_DAY).toISOString();
}

/**
 * Build a validated {@link GuestGrant}. The email is normalised, the page list
 * is deduped, the clock is stamped and `ttlDays` becomes `expiresAt`. Invalid
 * input throws a typed {@link GuestGrantError} rather than minting a
 * half-formed grant — callers validate eagerly and never persist a bad row.
 */
export function createGrant(input: CreateGuestGrantInput): GuestGrant {
  const email = normalizeGuestEmail(input.email);
  if (email === null) {
    throw new GuestGrantError("invalid_email", `A valid email is required (got ${show(input.email)}).`);
  }
  const workspaceId = nonEmpty(input.workspaceId);
  if (workspaceId === null) {
    throw new GuestGrantError("invalid_workspace", "workspaceId must be a non-empty string.");
  }
  const invitedBy = nonEmpty(input.invitedBy);
  if (invitedBy === null) {
    throw new GuestGrantError("invalid_inviter", "invitedBy must be a non-empty string.");
  }
  if (input.role !== "viewer" && input.role !== "commenter") {
    throw new GuestGrantError("invalid_role", `Unsupported guest role (got ${show(input.role)}).`);
  }
  const pageIds = normalizePageIds(input.pageIds);
  const nowMs = toEpochMs(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new GuestGrantError("invalid_now", "createGrant requires a usable clock.");
  }
  return {
    id: nonEmpty(input.id) ?? randomUUID(),
    email,
    workspaceId,
    pageIds,
    role: input.role,
    expiresAt: expiryForTtl(input.ttlDays, nowMs),
    invitedBy,
    createdAt: new Date(nowMs).toISOString(),
  };
}

/** True when a grant has been revoked (a stamped `revokedAt`). */
export function isGrantRevoked(grant: GuestGrant): grant is RevokedGuestGrant {
  const revokedAt = (grant as { revokedAt?: unknown }).revokedAt;
  return typeof revokedAt === "string" && revokedAt !== "";
}

/**
 * True when the grant's window has closed at `now`. A perpetual grant (no
 * `expiresAt`) never expires; the boundary instant counts as expired; a corrupt
 * expiry or an unusable clock fails closed (`true`).
 */
export function isGrantExpired(grant: Pick<GuestGrant, "expiresAt">, now: GuestTime): boolean {
  const expiresAt = grant?.expiresAt ?? null;
  if (expiresAt === null) return false;
  const expiry = toEpochMs(expiresAt);
  if (!Number.isFinite(expiry)) return true;
  const at = toEpochMs(now);
  if (!Number.isFinite(at)) return true;
  return at >= expiry;
}

/** True when a grant is neither revoked nor expired at `now`. */
export function isGrantActive(grant: GuestGrant, now: GuestTime): boolean {
  return !isGrantRevoked(grant) && !isGrantExpired(grant, now);
}

/**
 * Whether the grant covers `pageId` at `now`: the page must be in the explicit
 * scope and the grant must still be active. Fail closed on a blank id, a
 * corrupt scope, a revoked grant or a closed window.
 */
function grantAllowsPage(grant: GuestGrant, query: GuestAccessQuery): boolean {
  const pageId = query?.pageId;
  if (typeof pageId !== "string" || pageId.length === 0) return false;
  if (!Array.isArray(grant?.pageIds) || !grant.pageIds.includes(pageId)) return false;
  return isGrantActive(grant, query.now);
}

/** Stamp a grant revoked on a copy; the input is never mutated. */
export function revokeGrant(
  grant: GuestGrant,
  options: { now: GuestTime; reason?: string | null },
): RevokedGuestGrant {
  const revokedAt = isoTime(options.now);
  if (revokedAt === null) {
    throw new GuestGrantError("invalid_now", "revokeGrant requires a usable clock.");
  }
  return { ...grant, revokedAt, reason: nonEmpty(options.reason) };
}

/**
 * Every page a matching guest may read: the explicit grant roots plus their
 * whole subtree within `pages`. Ancestors are never included, an unrelated
 * email yields nothing, and the result is never the whole workspace. When
 * `options.now` is supplied, expired grants are skipped; revocation is always
 * enforced regardless of the clock. Fail closed on a blank email or no input.
 */
export function visiblePagesForGuest(
  pages: readonly PageLink[],
  grants: readonly GuestGrant[],
  viewer: GuestViewer,
  options: GuestVisibilityOptions = {},
): Set<string> {
  const visible = new Set<string>();
  const email = normalizeGuestEmail(viewer?.email);
  if (email === null || !Array.isArray(grants) || grants.length === 0) return visible;

  const present = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page || typeof page.id !== "string") continue;
    present.add(page.id);
    if (typeof page.parentId === "string") {
      const siblings = childrenOf.get(page.parentId);
      if (siblings) siblings.push(page.id);
      else childrenOf.set(page.parentId, [page.id]);
    }
  }
  if (present.size === 0) return visible;

  const { now } = options;
  const queue: string[] = [];
  for (const grant of grants) {
    if (!grant || normalizeGuestEmail(grant.email) !== email) continue;
    if (isGrantRevoked(grant)) continue;
    if (now !== undefined && isGrantExpired(grant, now)) continue;
    for (const root of grant.pageIds ?? []) {
      if (present.has(root) && !visible.has(root)) {
        visible.add(root);
        queue.push(root);
      }
    }
  }

  // BFS down each granted subtree; `visible` doubles as the visited set.
  for (const id of queue) {
    const children = childrenOf.get(id);
    if (!children) continue;
    for (const child of children) {
      if (!visible.has(child)) {
        visible.add(child);
        queue.push(child);
      }
    }
  }
  return visible;
}

/**
 * Split grants into the ones still within their window and the ones that have
 * expired at `now`. Purely about expiry — a revoked grant is neither filtered
 * nor reclassified here; use {@link isGrantActive} for the combined verdict. A
 * perpetual grant is always active.
 */
export function expireGrants(grants: readonly GuestGrant[], now: GuestTime): GuestExpirySweep {
  const active: GuestGrant[] = [];
  const expired: GuestGrant[] = [];
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant || typeof grant !== "object") continue;
    if (isGrantExpired(grant, now)) expired.push(grant);
    else active.push(grant);
  }
  return { active, expired };
}

/**
 * The guest ceiling a plan declares (`free` 0, `plus` 25, `business` 100,
 * `enterprise` unlimited — the Class-B capacity ladder of
 * `plan-entitlements.ts`). An unknown plan degrades to the free ceiling.
 */
export function guestLimitsForPlan(plan: string): PlanLimit {
  return entitlementsFor(plan).guests;
}

/**
 * Whether one more guest may be invited under `plan` when `currentCount`
 * guests already exist. A cap of N admits up to N guests and rejects the
 * (N+1)-th; `"unlimited"` always admits; an unknown plan or a non-finite count
 * fails closed.
 */
export function canInviteGuest(plan: string, currentCount: number): boolean {
  return withinLimit(plan, "guests", currentCount);
}

/**
 * Build the restricted session view a guest request carries: explicitly scoped
 * to `pageIds`, able to view and (for a commenter) comment, but **never** able
 * to edit, invite or upload. `pageIds` is copied so a later scope trim cannot
 * mutate the grant's array.
 */
export function toGuestSession(grant: GuestGrant): GuestSession {
  return {
    kind: "guest",
    email: grant.email,
    workspaceId: grant.workspaceId,
    role: grant.role,
    pageIds: [...grant.pageIds],
    readOnly: grant.role === "viewer",
    canView: true,
    canComment: grant.role === "commenter",
    canEdit: false,
    expiresAt: grant.expiresAt ?? null,
  };
}

/** A stable, human-readable one-liner for logs, audits and settings rows. */
export function describeGrant(grant: GuestGrant): string {
  const count = Array.isArray(grant.pageIds) ? grant.pageIds.length : 0;
  const scope = `${count} page${count === 1 ? "" : "s"}`;
  const expiry = grant.expiresAt ? `expires ${grant.expiresAt}` : "no expiry";
  const revoked = isGrantRevoked(grant)
    ? `, revoked ${grant.revokedAt}${grant.reason ? ` (${grant.reason})` : ""}`
    : "";
  return `${grant.role} guest ${grant.email} in workspace ${grant.workspaceId}: ${scope}, ${expiry}${revoked}`;
}
