"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { requireUser } from "@/lib/auth";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import { randomToken } from "@/lib/slug";
import { hashPassword, verifyPassword } from "@/lib/auth";

export type ShareOptions = {
  password?: string;
  expiresInDays?: number;
  /**
   * Edit vs read-only share. Explicit `true` grants EDIT; `false`/omitted is
   * READ, so a link is never editable unless the publisher asked for it.
   * On an existing link `undefined` leaves the current choice untouched.
   */
  allowEditing?: boolean;
  /**
   * Let viewers copy the published page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  allowDuplicate?: boolean;
  /**
   * Let search engines index the public page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  indexing?: boolean;
  /**
   * Disable exporting the published page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  exportRestricted?: boolean;
};

export type ShareLinkState = {
  published: boolean;
  token: string | null;
  allowEditing: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  allowDuplicate: boolean;
  indexing: boolean;
  exportRestricted: boolean;
};

/** Current share state of a page for the share panel (fail-closed for guests). */
export async function getShareLinkStateAction(pageId: string): Promise<ShareLinkState> {
  const empty: ShareLinkState = {
    published: false,
    token: null,
    allowEditing: false,
    hasPassword: false,
    expiresAt: null,
    allowDuplicate: false,
    indexing: true,
    exportRestricted: false,
  };
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return empty;
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) return empty;

  const link = await prisma.shareLink.findFirst({ where: { pageId } });
  if (!link) return empty;
  return {
    published: true,
    token: link.token,
    allowEditing: link.permission === "EDIT",
    hasPassword: Boolean(link.passwordHash),
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    allowDuplicate: link.allowDuplicate,
    indexing: link.indexing,
    exportRestricted: link.exportRestricted,
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
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to share this page." };
  }

  const passwordHash = options.password ? await hashPassword(options.password) : undefined;
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 86_400_000)
      : undefined;
  const requested: SharePermission | undefined =
    options.allowEditing === undefined ? undefined : options.allowEditing ? "EDIT" : "READ";

  const existing = await prisma.shareLink.findFirst({ where: { pageId } });
  if (existing) {
    await prisma.shareLink.update({
      where: { id: existing.id },
      data: {
        passwordHash: passwordHash ?? existing.passwordHash,
        expiresAt: expiresAt ?? existing.expiresAt,
        permission: requested ?? existing.permission,
        allowDuplicate: options.allowDuplicate ?? existing.allowDuplicate,
        indexing: options.indexing ?? existing.indexing,
        exportRestricted: options.exportRestricted ?? existing.exportRestricted,
      },
    });
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
      ...(options.allowDuplicate !== undefined ? { allowDuplicate: options.allowDuplicate } : {}),
      ...(options.indexing !== undefined ? { indexing: options.indexing } : {}),
      ...(options.exportRestricted !== undefined
        ? { exportRestricted: options.exportRestricted }
        : {}),
    },
    select: { token: true },
  });
  await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.shared", targetType: "page", targetId: pageId });
  revalidatePath("/w", "layout");
  return { url: `/s/${link.token}` };
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

/** Remove every public link for a page. */
export async function revokeShareLinkAction(
  pageId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to change sharing." };
  }
  await prisma.shareLink.deleteMany({ where: { pageId } });
  await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.unshared", targetType: "page", targetId: pageId });
  revalidatePath("/w", "layout");
  return { ok: true };
}
