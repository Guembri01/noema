"use server";

import { revalidatePath } from "next/cache";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { decryptSecret, encryptSecret, hashToken } from "@/lib/secrets";
import {
  canRedeem,
  generateInviteToken,
  isWellFormedToken,
} from "@/lib/invite-token";
import { emailTemplate, escapeHtml, sendMail, verifyMail } from "@/lib/mailer";
import { normalizeEmail } from "@/lib/email-validation";
import { evaluateGuestInviteGate, readWorkspacePlan } from "@/lib/workspace-plan";
import { canGrantRole } from "@/lib/workspace-roles";
import { toEngineRole } from "@/lib/workspace-role-map";

export type EmailResult<T = unknown> = ({ ok: true } & T) | { error: string };

const INVITE_TTL_DAYS = 14;

/** The origin a link falls back to when no `APP_URL` is configured. */
const DEFAULT_ORIGIN = "http://localhost:3200";

/**
 * The roles a workspace invitation may carry.
 *
 * This is the *domain* of the invitation role, not a policy: who may hand out
 * which of them is decided by the role matrix (`canGrantRole`). A value
 * outside this list is unknown and is refused — never coerced to a weaker role.
 */
const INVITABLE_ROLES = ["GUEST", "MEMBER", "ADMIN"] as const;

/** A persisted role an invitation may carry. */
type InvitableRole = Extract<WorkspaceRole, (typeof INVITABLE_ROLES)[number]>;

/** Whether `value` names a role an invitation may carry (fails closed). */
function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && (INVITABLE_ROLES as readonly string[]).includes(value);
}

type AdminAuth =
  | { ok: false; error: string }
  | {
      ok: true;
      user: Awaited<ReturnType<typeof requireUser>>;
      access: NonNullable<Awaited<ReturnType<typeof getWorkspaceAccess>>>;
    };

async function authorizeAdmin(workspaceId: string): Promise<AdminAuth> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { ok: false, error: "Only workspace admins can manage email and invitations." };
  }
  return { ok: true, user, access };
}

/**
 * Absolute base URL for links inside emails.
 *
 * The origin comes from the deployment configuration only (`APP_URL`, then
 * `NEXT_PUBLIC_APP_URL`). A request header (`Host`, `X-Forwarded-Host`) is
 * chosen by whoever sends the request, so trusting it would let the sender
 * decide which host an invitation link points at — and the link lands in a
 * mail a third party reads. A deployment that serves the public internet
 * sets `APP_URL`; without one the local development origin is used.
 */
export async function appOrigin(): Promise<string> {
  const configured =
    process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  return (configured || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// SMTP configuration
// ---------------------------------------------------------------------------

export type EmailSummary = {
  configured: boolean;
  source: "workspace" | "env" | "none";
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  hasPassword: boolean;
};

/**
 * The workspace's SMTP configuration.
 *
 * The host, the username and the sender address are workspace management
 * data: the settings screen only shows them to an admin, so the read asks the
 * same question — a `GUEST` (an external collaborator) never receives them.
 */
export async function getEmailSummary(workspaceId: string): Promise<EmailSummary | null> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) return null;

  const stored = await prisma.emailConfig.findUnique({
    where: { workspaceId },
    select: {
      host: true,
      port: true,
      secure: true,
      username: true,
      passwordEncrypted: true,
      fromName: true,
      fromEmail: true,
      replyTo: true,
    },
  });
  if (stored) {
    return {
      configured: true,
      source: "workspace",
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      username: stored.username,
      fromName: stored.fromName ?? "Noema",
      fromEmail: stored.fromEmail,
      replyTo: stored.replyTo,
      hasPassword: Boolean(decryptSecret(stored.passwordEncrypted)),
    };
  }

  const envConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
  return {
    configured: envConfigured,
    source: envConfigured ? "env" : "none",
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    username: process.env.SMTP_USER ?? null,
    fromName: process.env.SMTP_FROM_NAME ?? "Noema",
    fromEmail: process.env.SMTP_FROM ?? "",
    replyTo: process.env.SMTP_REPLY_TO ?? null,
    hasPassword: Boolean(process.env.SMTP_PASSWORD),
  };
}

export async function saveEmailConfigAction(input: {
  workspaceId: string;
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromName?: string;
  fromEmail: string;
  replyTo?: string;
}): Promise<EmailResult> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { error: auth.error };

  const host = input.host.trim();
  const fromEmail = normalizeEmail(input.fromEmail ?? "")?.toLowerCase() ?? null;
  if (!host) return { error: "An SMTP host is required." };
  if (!fromEmail) return { error: "A valid sender address is required." };
  const port = Number.isFinite(input.port) ? Math.min(Math.max(input.port, 1), 65535) : 587;

  const existing = await prisma.emailConfig.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { passwordEncrypted: true },
  });
  const passwordEncrypted =
    input.password && input.password.trim()
      ? encryptSecret(input.password.trim())
      : existing?.passwordEncrypted ?? null;

  await prisma.emailConfig.upsert({
    where: { workspaceId: input.workspaceId },
    create: {
      workspaceId: input.workspaceId,
      host,
      port,
      secure: input.secure,
      username: input.username?.trim() || null,
      passwordEncrypted,
      fromName: input.fromName?.trim().slice(0, 60) || "Noema",
      fromEmail,
      replyTo: input.replyTo?.trim() || null,
    },
    update: {
      host,
      port,
      secure: input.secure,
      username: input.username?.trim() || null,
      passwordEncrypted,
      fromName: input.fromName?.trim().slice(0, 60) || "Noema",
      fromEmail,
      replyTo: input.replyTo?.trim() || null,
    },
  });

  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function clearEmailConfigAction(workspaceId: string): Promise<EmailResult> {
  const auth = await authorizeAdmin(workspaceId);
  if (!auth.ok) return { error: auth.error };
  await prisma.emailConfig.deleteMany({ where: { workspaceId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Verify the SMTP handshake, then (optionally) send a test message. */
export async function testEmailAction(
  workspaceId: string,
  to: string,
): Promise<EmailResult<{ source: string; sentTo: string | null }>> {
  const auth = await authorizeAdmin(workspaceId);
  if (!auth.ok) return { error: auth.error };

  const verified = await verifyMail(workspaceId);
  if ("error" in verified) return { error: verified.error };

  const recipient = to.trim()
    ? normalizeEmail(to)?.toLowerCase() ?? null
    : auth.user.email;
  if (!recipient) return { error: "Enter a valid test recipient address." };

  const template = emailTemplate({
    heading: "Noema test email",
    body: "Your SMTP settings work — invitations will be delivered from this workspace.",
    ctaLabel: "Open Noema",
    ctaUrl: await appOrigin(),
    footer: "Sent from workspace email settings.",
  });
  const sent = await sendMail(workspaceId, {
    to: recipient,
    subject: "Noema · SMTP test",
    kind: "test",
    ...template,
  });
  revalidatePath("/w", "layout");
  if ("error" in sent) return { error: sent.error };
  return { ok: true, source: verified.source, sentTo: recipient };
}

export async function listEmailDeliveries(workspaceId: string, take = 12) {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) return [];
  return prisma.emailDelivery.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, to: true, subject: true, kind: true, status: true, error: true, createdAt: true },
  });
}

// ---------------------------------------------------------------------------
// Client / member invitations (workspace level)
// ---------------------------------------------------------------------------

export type WorkspaceInviteSummary = {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
};

/** Invite a client (GUEST) or teammate (MEMBER/ADMIN) by email. */
export async function sendWorkspaceInviteAction(input: {
  workspaceId: string;
  email: string;
  /**
   * The requested role. The transport forwards it unchanged, so it arrives
   * unvalidated: the role domain is checked here, the grant policy below.
   */
  role?: string;
  /** When set, the invitee is added to this project as a client on accept. */
  projectId?: string | null;
}): Promise<EmailResult<{ link: string; emailed: boolean; warning?: string }>> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { error: auth.error };

  const email = normalizeEmail(input.email)?.toLowerCase() ?? null;
  if (!email) return { error: "Enter a valid email address." };
  const requestedRole = input.role ?? "MEMBER";
  if (!isInvitableRole(requestedRole)) {
    return { error: "Unknown role." };
  }
  const role: InvitableRole = requestedRole;
  // The role an invitation carries is a grant, so it goes through the same
  // policy as a role change (`setMemberRoleAction` → `validateRoleChange`):
  // an actor may only hand out a role strictly below their own, which means
  // only the owner can grant the admin role. Fail closed — a role the actor
  // may not grant is refused, never silently weakened.
  if (!canGrantRole(toEngineRole(auth.access.role), toEngineRole(role))) {
    return {
      error:
        role === "ADMIN"
          ? "Only the workspace owner can invite an admin."
          : "You can only invite people with a role below your own.",
    };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: {
      name: true,
      slug: true,
      ownerId: true,
      owner: { select: { email: true } },
      // Guest seats in use: existing external guests plus still-pending guest
      // invites, the population the external-guest cap is measured against.
      _count: {
        select: {
          members: { where: { role: "GUEST" } },
          invites: { where: { role: "GUEST", acceptedAt: null } },
        },
      },
    },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (workspace.owner.email.toLowerCase() === email) {
    return { error: "That address already owns this workspace." };
  }

  // Plan gate (the load-bearing use of `@/lib/plans`): new external-guest
  // invites are capped by the workspace plan. Existing guests are never
  // revoked; the gate only ever refuses a *new* invite. Members/admins are
  // not guest seats, so they skip it.
  if (role === "GUEST") {
    const currentGuests = (workspace._count?.members ?? 0) + (workspace._count?.invites ?? 0);
    const gate = evaluateGuestInviteGate(readWorkspacePlan(), currentGuests);
    if (!gate.allowed) {
      return { error: gate.reason ?? "This workspace has reached its guest limit." };
    }
  }

  let projectName: string | null = null;
  if (input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { name: true, workspaceId: true },
    });
    if (!project || project.workspaceId !== input.workspaceId) {
      return { error: "That project is not in this workspace." };
    }
    projectName = project.name;
  }

  // Mint through the pure invite-token module: 256 bits of base64url entropy,
  // persisted only as its domain-separated SHA-256 digest (`hashToken`, the
  // existing on-disk format, so already-issued invites keep validating).
  // `randomToken(24)` gave fewer bits and duplicated the minting logic.
  const token = generateInviteToken();
  await prisma.invite.deleteMany({
    where: { workspaceId: input.workspaceId, email, acceptedAt: null },
  });
  await prisma.invite.create({
    data: {
      workspaceId: input.workspaceId,
      email,
      role,
      projectId: input.projectId ?? null,
      token: hashToken(token),
      invitedById: auth.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  const link = `${await appOrigin()}/invite/${token}`;
  const template = emailTemplate({
    heading: `You're invited to ${escapeHtml(workspace.name)}`,
    body: `${escapeHtml(auth.user.name)} invited you to collaborate in <strong>${escapeHtml(
      workspace.name,
    )}</strong> on Noema (a ${
      role === "GUEST" ? "client/guest" : "member"
    } account)${projectName ? `, as a client on the project <strong>${escapeHtml(projectName)}</strong>` : ""}. The link expires in ${INVITE_TTL_DAYS} days.`,
    ctaLabel: "Accept invitation",
    ctaUrl: link,
    footer: "If you weren't expecting this, you can ignore the email.",
  });

  const sent = await sendMail(input.workspaceId, {
    to: email,
    subject: `${auth.user.name} invited you to ${workspace.name}`,
    kind: "workspace-invite",
    ...template,
  });

  revalidatePath("/w", "layout");
  if ("error" in sent) {
    // SMTP missing or failing: the caller still gets the link to share manually.
    return { ok: true, link, emailed: false, warning: sent.error };
  }
  return { ok: true, link, emailed: true };
}

export async function revokeWorkspaceInviteAction(inviteId: string): Promise<EmailResult> {
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    select: { workspaceId: true },
  });
  if (!invite) return { error: "Invitation not found." };
  const auth = await authorizeAdmin(invite.workspaceId);
  if (!auth.ok) return { error: auth.error };
  await prisma.invite.delete({ where: { id: inviteId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function listWorkspaceInvites(workspaceId: string): Promise<WorkspaceInviteSummary[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) return [];
  return prisma.invite.findMany({
    where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true },
  });
}

/** A workspace invitation as the invitee sees it, before they redeem it. */
export type WorkspaceInvitePreview = {
  workspaceName: string;
  workspaceSlug: string;
  role: string;
  /** The project a client invitation is scoped to, when it is scoped to one. */
  projectName: string | null;
};

/** The invitation a token names, once it has been cleared for this user. */
type ResolvedWorkspaceInvite = {
  id: string;
  role: WorkspaceRole;
  /** Who issued the invitation — the user whose grant it carries. */
  invitedById: string | null;
  projectId: string | null;
  projectName: string | null;
  workspace: { id: string; name: string; slug: string };
};

/**
 * The read half of redemption: verify a presented token and decide whether the
 * signed-in user may redeem it.
 *
 * Both halves go through here — the read the invite page renders from, and the
 * write its form posts to — so invalidity, expiry, reuse and the address check
 * are decided once, by the same rules. Nothing in this function writes: a GET of
 * an invitation link has to be safe to serve, because link previews, email
 * scanners and prefetches fetch it too.
 */
async function resolveWorkspaceInvite(
  token: string,
  userEmail: string,
): Promise<{ ok: false; error: string } | { ok: true; invite: ResolvedWorkspaceInvite }> {
  // Verification goes through the invite-token module: a token that is not a
  // well-formed minted value can never match a stored digest, so reject it
  // before the lookup rather than relying on a miss.
  if (!isWellFormedToken(token)) {
    return { ok: false, error: "That invitation link is not valid." };
  }
  const invite = await prisma.invite.findUnique({
    where: { token: hashToken(token) },
    select: {
      id: true,
      email: true,
      role: true,
      invitedById: true,
      projectId: true,
      acceptedAt: true,
      expiresAt: true,
      project: { select: { name: true } },
      workspace: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!invite) return { ok: false, error: "That invitation link is not valid." };
  // Expiry + already-used are decided by the invite-token module (`canRedeem`),
  // so the precedence and boundary semantics stay in one place.
  const decision = canRedeem({
    expiresAt: invite.expiresAt,
    usedAt: invite.acceptedAt,
    maxUses: 1,
    usedCount: 0,
  });
  if (!decision.ok) {
    return {
      ok: false,
      error:
        decision.reason === "expired"
          ? "That invitation has expired."
          : "That invitation has already been used.",
    };
  }
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
    return {
      ok: false,
      error: `This invitation is for ${invite.email}. Sign in with that address.`,
    };
  }

  // The invitation is a grant, so the grant is checked again when it is
  // redeemed: the role it carries must still be a role its sender may hand out
  // *now* — the same question the role-change path asks, asked of the sender
  // instead of the actor. An invitation minted before the grant rule was
  // enforced (an admin inviting an admin), one whose sender has since been
  // demoted or removed, and one that names no sender at all are refused here,
  // before any write. The read (the preview) and the write (the acceptance)
  // share this resolver, so both halves answer alike.
  const inviterAccess = invite.invitedById
    ? await getWorkspaceAccess(invite.invitedById, invite.workspace.id)
    : null;
  if (!canGrantRole(toEngineRole(inviterAccess?.role), toEngineRole(invite.role))) {
    return {
      ok: false,
      error:
        "This invitation can no longer be redeemed. Please ask the workspace owner for a new invitation.",
    };
  }

  return {
    ok: true,
    invite: {
      id: invite.id,
      role: invite.role,
      invitedById: invite.invitedById,
      projectId: invite.projectId,
      projectName: invite.project?.name ?? null,
      workspace: invite.workspace,
    },
  };
}

/**
 * What the invitation link shows before the invitee commits to joining.
 *
 * Read-only by construction (it shares `resolveWorkspaceInvite` with the accept
 * below and performs no write of its own), which is what lets the invite page be
 * a plain GET: the invite is only ever consumed by the POST that follows.
 */
export async function previewWorkspaceInviteAction(
  token: string,
): Promise<EmailResult<WorkspaceInvitePreview>> {
  const user = await requireUser();
  const resolved = await resolveWorkspaceInvite(token, user.email);
  if (!resolved.ok) return { error: resolved.error };
  return {
    ok: true,
    workspaceName: resolved.invite.workspace.name,
    workspaceSlug: resolved.invite.workspace.slug,
    role: resolved.invite.role,
    projectName: resolved.invite.projectName,
  };
}

/**
 * Accept a workspace invitation for the signed-in user.
 *
 * Called by the POST the invite page's form makes — never during a render, which
 * is also what makes the revalidation at the end of this function legal.
 */
export async function acceptWorkspaceInviteAction(
  token: string,
): Promise<EmailResult<{ slug: string; workspaceName: string; role: string }>> {
  const user = await requireUser();
  const resolved = await resolveWorkspaceInvite(token, user.email);
  if (!resolved.ok) return { error: resolved.error };
  const { invite } = resolved;

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: invite.workspace.id, userId: user.id } },
    // The stored role is granted — but only because `resolveWorkspaceInvite`
    // has just re-checked that it is still a role the sender may hand out.
    create: { workspaceId: invite.workspace.id, userId: user.id, role: invite.role },
    update: {},
  });
  // Project-scoped invites also grant view access to that project.
  if (invite.projectId) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: invite.projectId, userId: user.id } },
      create: { projectId: invite.projectId, userId: user.id, role: "CLIENT" },
      update: {},
    });
  }
  await prisma.invite.update({
    where: { id: invite.id },
    data: { acceptedAt: new Date() },
  });

  // Legal here, and only here: acceptance is a POST (the invite page's form
  // action), not a render. The page used to accept during render, and Next
  // throws "used revalidatePath during render" *after* the membership write, so
  // every acceptance answered 500 and the redirect was never reached. Nothing is
  // stale by the time this runs either: every `/w` page reads cookies, so it is
  // dynamic and holds no route cache.
  revalidatePath("/w", "layout");
  return {
    ok: true,
    slug: invite.workspace.slug,
    workspaceName: invite.workspace.name,
    role: invite.role,
  };
}

