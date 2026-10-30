"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { requireUser } from "@/lib/auth";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { randomToken } from "@/lib/slug";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { generateShortCode } from "@/lib/short-link";

export type ShareOptions = {
  password?: string;
  expiresInDays?: number;
  /**
   * Legacy read/edit marker on the share row. The public page is read-only
   * (there is no anonymous write surface), so `true` no longer grants an
   * anonymous edit: it only records the publisher's intent and the page copy
   * says "sign in to edit". `false`/omitted is READ. On an existing link
   * `undefined` leaves the stored marker untouched.
   */
  allowEditing?: boolean;
  /**
   * Let search engines index the public page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  indexing?: boolean;
  /**
   * P3-T01: explicit "remove the stored password / expiry" sentinels. The
   * `??`-merge used on the update branch can only keep or replace a value, it
   * cannot express removal — so a sent password could be set but never
   * cleared. The flags are plain booleans (no magic strings), and a
   * replacement value in the same call wins over its sentinel. Both are
   * ignored on a fresh create, where there is nothing to clear.
   */
  clearPassword?: boolean;
  clearExpiry?: boolean;
};

export type ShareLinkState = {
  published: boolean;
  token: string | null;
  allowEditing: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  indexing: boolean;
};

/**
 * Stamp the deterministic `/s/<code>` alias the share dialog renders. The
 * code space is a one-way hash of the page id, so the alias must live in the
 * DB (`Page.shortCode`, unique + indexed) for the public resolver to find it —
 * no scan, ever. Called lazily at publish and share-state read time so pages
 * published before the column existed are stamped as soon as their share
 * panel is opened. Never throws: a rare seeded-collision race leaves the
 * alias unset, which makes the dialog's short link fail closed instead of
 * pointing at someone else's page.
 */
async function ensurePageShortCode(pageId: string): Promise<void> {
  try {
    await prisma.page.updateMany({
      where: { id: pageId, shortCode: null },
      data: { shortCode: generateShortCode({ seed: pageId }) },
    });
  } catch {
    // Another page already claimed this seed's code (P2002): no alias.
  }
}

/** Current share state of a page for the share panel (fail-closed for guests). */
export async function getShareLinkStateAction(pageId: string): Promise<ShareLinkState> {
  const empty: ShareLinkState = {
    published: false,
    token: null,
    allowEditing: false,
    hasPassword: false,
    expiresAt: null,
    indexing: true,
  };
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return empty;
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) return empty;
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) return empty;

  await ensurePageShortCode(pageId);
  // A published form is a separate public surface; the page share panel only
  // reflects the page-level link (`viewId: null`).
  const link = await prisma.shareLink.findFirst({ where: { pageId, viewId: null } });
  if (!link) return empty;
  return {
    published: true,
    token: link.token,
    allowEditing: link.permission === "EDIT",
    hasPassword: Boolean(link.passwordHash),
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    indexing: link.indexing,
  };
}

/** Publish a page to the web (idempotent) and return its public path. */
export async function createShareLinkAction(
  pageId: string,
  options: ShareOptions = {},
): Promise<{ url: string } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      // P2-T08: a trashed page must not be publishable — the link would
      // silently revive when the page is restored. Same gate as
      // `loadShareableForm`, which returns "Form not found." for one.
      deletedAt: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page || page.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to share this page." };
  }
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) {
    return { error: "You do not have permission to share this page." };
  }
  await ensurePageShortCode(pageId);

  const passwordHash = options.password ? await hashPassword(options.password) : undefined;
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 86_400_000)
      : undefined;
  const requested: SharePermission | undefined =
    options.allowEditing === undefined ? undefined : options.allowEditing ? "EDIT" : "READ";

  const existing = await prisma.shareLink.findFirst({
    where: { pageId, viewId: null },
  });
  if (existing) {
    // P3-T01: explicit set-or-clear where `??`-merge can only keep/replace. A
    // replacement value wins over its sentinel; no sentinel keeps the stored one.
    const next = {
      passwordHash: passwordHash ?? (options.clearPassword ? null : existing.passwordHash),
      expiresAt: expiresAt ?? (options.clearExpiry ? null : existing.expiresAt),
      permission: requested ?? existing.permission,
      indexing: options.indexing ?? existing.indexing,
    };
    await prisma.shareLink.update({
      where: { id: existing.id },
      data: next,
    });
    // An update that persists gets its audit line, mirroring the create
    // branch's `page.shared`. A same-value call (the dialog re-sends a
    // toggle it cannot read back, or an MCP drive-by) is a no-op, so the
    // trail stays quiet — the link itself is unchanged.
    const changed =
      next.passwordHash !== existing.passwordHash ||
      next.permission !== existing.permission ||
      next.indexing !== existing.indexing ||
      (next.expiresAt?.getTime() ?? null) !== (existing.expiresAt?.getTime() ?? null);
    if (changed) {
      await logActivity({
        workspaceId: page.workspaceId,
        actorId: user.id,
        action: "page.share_updated",
        targetType: "page",
        targetId: pageId,
      });
    }
    revalidatePath("/w", "layout");
    return { url: `/s/${existing.token}` };
  }

  const link = await prisma.shareLink.create({
    data: {
      pageId,
      token: randomToken(24),
      permission: requested ?? "READ",
      ...(passwordHash ? { passwordHash } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(options.indexing !== undefined ? { indexing: options.indexing } : {}),
    },
    select: { token: true },
  });
  await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.shared", targetType: "page", targetId: pageId });
  revalidatePath("/w", "layout");
  return { url: `/s/${link.token}` };
}

/** A form view the caller may publish, with its database page. */
async function loadShareableForm(
  viewId: string,
  userId: string,
): Promise<
  | {
      view: { id: string; databasePageId: string };
      page: { id: string; workspaceId: string };
    }
  | { error: string }
> {
  const view = await prisma.databaseView.findUnique({
    where: { id: viewId },
    select: { id: true, type: true, databasePageId: true },
  });
  if (!view || view.type !== "FORM") return { error: "Form not found." };

  const page = await prisma.page.findUnique({
    where: { id: view.databasePageId },
    select: {
      id: true,
      workspaceId: true,
      type: true,
      deletedAt: true,
      permissions: {
        where: { userId },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page || page.type !== "DATABASE" || page.deletedAt) {
    return { error: "Form not found." };
  }
  const access = await getWorkspaceAccess(userId, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to share this form." };
  }
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) {
    return { error: "You do not have permission to share this form." };
  }
  return { view, page };
}

export type FormShareLinkState = {
  published: boolean;
  url: string | null;
};

/** Current public-link state of one FORM view (fail-closed). */
export async function getFormShareLinkStateAction(
  viewId: string,
): Promise<FormShareLinkState> {
  const user = await requireUser();
  const target = await loadShareableForm(viewId, user.id);
  if ("error" in target) return { published: false, url: null };
  const link = await prisma.shareLink.findFirst({
    where: { pageId: target.page.id, viewId: target.view.id },
    select: { token: true },
  });
  return link
    ? { published: true, url: `/s/${link.token}` }
    : { published: false, url: null };
}

/** Publish one FORM view to the web (idempotent) and return its public path. */
export async function createFormShareLinkAction(
  viewId: string,
): Promise<{ url: string } | { error: string }> {
  const user = await requireUser();
  const target = await loadShareableForm(viewId, user.id);
  if ("error" in target) return target;

  const existing = await prisma.shareLink.findFirst({
    where: { pageId: target.page.id, viewId: target.view.id },
    select: { token: true },
  });
  if (existing) return { url: `/s/${existing.token}` };

  const link = await prisma.shareLink.create({
    data: {
      pageId: target.page.id,
      viewId: target.view.id,
      token: randomToken(24),
      permission: "READ",
      // A public form is an input surface, not a page to crawl.
      indexing: false,
    },
    select: { token: true },
  });
  await logActivity({
    workspaceId: target.page.workspaceId,
    actorId: user.id,
    action: "page.shared",
    targetType: "page",
    targetId: target.page.id,
    meta: { formViewId: target.view.id },
  });
  revalidatePath("/w", "layout");
  return { url: `/s/${link.token}` };
}

/** Remove the public link of one FORM view. */
export async function revokeFormShareLinkAction(
  viewId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const target = await loadShareableForm(viewId, user.id);
  if ("error" in target) return target;
  await prisma.shareLink.deleteMany({
    where: { pageId: target.page.id, viewId: target.view.id },
  });
  await logActivity({
    workspaceId: target.page.workspaceId,
    actorId: user.id,
    action: "page.unshared",
    targetType: "page",
    targetId: target.page.id,
    meta: { formViewId: target.view.id },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Share-unlock attempt accounting.
 *
 * `POST /s/<token>/unlock` is public, so a share password can be
 * guessed. The route's rate limiter keys on a forwarding header an
 * attacker can spoof, while the share token is not guessable - so the
 * counter below is keyed by the token alone and is the real brake on a
 * brute force. The state is in-process (like the automation store in
 * `src/server/actions/automations.ts`); a multi-instance deployment
 * needs a shared store.
 * ------------------------------------------------------------------ */

/** Failed password attempts tolerated per share link. */
const UNLOCK_MAX_FAILURES = 10;
/** How long a share link stays locked once the failure budget is spent. */
const UNLOCK_LOCK_MS = 15 * 60_000;
/** Silence after which the failure budget is restored (a typo is not a siege). */
const UNLOCK_QUIET_MS = 60 * 60_000;
/** Soft cap: above this many tracked links, stale entries are swept. */
const UNLOCK_SWEEP_AT = 1_000;
/** Hard cap on tracked links (a flood of random tokens must not grow memory). */
const UNLOCK_MAX_TRACKED = 10_000;

type UnlockAttempts = {
  /** Failed attempts inside the current budget window. */
  failures: number;
  /** Epoch ms until which the link is locked. */
  lockedUntil: number;
  /** Epoch ms of the last recorded failure. */
  lastFailureAt: number;
};

const unlockAttempts = new Map<string, UnlockAttempts>();

/** Milliseconds the link stays locked for; 0 when it is not locked. */
function unlockLockRemaining(token: string, now: number): number {
  const entry = unlockAttempts.get(token);
  if (!entry) return 0;
  return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
}

/** Count a failed attempt and lock the link when the budget is spent. */
function recordUnlockFailure(token: string, now: number): void {
  const previous = unlockAttempts.get(token);
  // A long silence restores the budget: a mistyped password must not
  // accumulate into a lockout over the days.
  const entry: UnlockAttempts =
    previous && now - previous.lastFailureAt <= UNLOCK_QUIET_MS
      ? {
          failures: previous.failures,
          lockedUntil: previous.lockedUntil,
          lastFailureAt: now,
        }
      : { failures: 0, lockedUntil: 0, lastFailureAt: now };
  entry.failures += 1;
  entry.lastFailureAt = now;
  if (entry.failures >= UNLOCK_MAX_FAILURES) {
    entry.lockedUntil = now + UNLOCK_LOCK_MS;
  }
  unlockAttempts.set(token, entry);
  sweepUnlockAttempts(now);
}

/**
 * Drop stale entries and keep the store bounded.
 *
 * The cap bounds the **number** of entries, not the length of a key: the key
 * is the raw share token, so a caller controls how much a single entry costs
 * (the token is a random 12-byte name, but the endpoint accepts whatever
 * reaches it). The eviction drops the oldest entry, which may be a link that
 * is currently locked — a flood of random tokens can therefore release one
 * lock. That is the price of a bound, and it is the same trade-off the
 * limiter's own store makes.
 */
function sweepUnlockAttempts(now: number): void {
  if (unlockAttempts.size >= UNLOCK_SWEEP_AT) {
    for (const [key, entry] of unlockAttempts) {
      if (
        entry.lockedUntil <= now &&
        now - entry.lastFailureAt > UNLOCK_QUIET_MS
      ) {
        unlockAttempts.delete(key);
      }
    }
  }
  while (unlockAttempts.size > UNLOCK_MAX_TRACKED) {
    const oldest = unlockAttempts.keys().next();
    if (oldest.done === true) break;
    unlockAttempts.delete(oldest.value);
  }
}

/** Compare a password against the share link's stored hash. */
async function compareSharePassword(
  token: string,
  password: string,
): Promise<boolean> {
  const link = await prisma.shareLink.findUnique({
    where: { token },
    select: { passwordHash: true },
  });
  if (!link?.passwordHash) return false;
  return verifyPassword(password, link.passwordHash);
}

/** Outcome of one share-unlock attempt. */
export type ShareUnlockResult =
  | { status: "unlocked" }
  | { status: "wrong-password" }
  | { status: "locked"; retryAfterMs: number };

/**
 * Try to unlock a password-protected share link.
 *
 * Fails closed: while a link is locked no password is compared at all, so
 * the lock window cannot be used to keep guessing. Every failed attempt is
 * counted per share token - an attacker cannot reset the budget by
 * spoofing `x-forwarded-for` - and a successful unlock clears the count.
 */
export async function attemptShareUnlock(
  token: string,
  password: string,
): Promise<ShareUnlockResult> {
  const lockedFor = unlockLockRemaining(token, Date.now());
  if (lockedFor > 0) return { status: "locked", retryAfterMs: lockedFor };
  if (!(await compareSharePassword(token, password))) {
    recordUnlockFailure(token, Date.now());
    return { status: "wrong-password" };
  }
  unlockAttempts.delete(token);
  return { status: "unlocked" };
}

/** Remove the page-level public link (form links are revoked per view). */
export async function revokeShareLinkAction(
  pageId: string,
): Promise<{ ok: true; removed: number } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to change sharing." };
  }
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) {
    return { error: "You do not have permission to change sharing." };
  }
  const { count } = await prisma.shareLink.deleteMany({ where: { pageId, viewId: null } });
  // A form-only published page deletes 0 rows — that is a no-op, not a share
  // event, so the audit log stays quiet and the caller reports "not published".
  if (count > 0) {
    await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.unshared", targetType: "page", targetId: pageId });
  }
  revalidatePath("/w", "layout");
  return { ok: true, removed: count };
}
