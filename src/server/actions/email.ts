"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { decryptSecret, encryptSecret, hashToken, randomToken } from "@/lib/secrets";
import { emailTemplate, escapeHtml, sendMail, verifyMail } from "@/lib/mailer";

export type EmailResult<T = unknown> = ({ ok: true } & T) | { error: string };

const INVITE_TTL_DAYS = 14;

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

/** Absolute base URL for links inside emails (APP_URL wins, then the request). */
export async function appOrigin(): Promise<string> {
  const configured = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const store = await headers();
  const host = store.get("x-forwarded-host") ?? store.get("host") ?? "localhost:3200";
  const proto =
    store.get("x-forwarded-proto") ??
    (/^(localhost|127\.|10\.|192\.168\.)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
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

export async function getEmailSummary(workspaceId: string): Promise<EmailSummary | null> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return null;

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
  const fromEmail = normalizeEmail(input.fromEmail ?? "");
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

  const recipient = to.trim() ? normalizeEmail(to) : auth.user.email;
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
  role?: WorkspaceRole;
  /** When set, the invitee is added to this project as a client on accept. */
  projectId?: string | null;
}): Promise<EmailResult<{ link: string; emailed: boolean; warning?: string }>> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { error: auth.error };

  const email = normalizeEmail(input.email);
  if (!email) return { error: "Enter a valid email address." };
  const role: WorkspaceRole = input.role ?? "MEMBER";
  if (!["GUEST", "MEMBER", "ADMIN"].includes(role)) {
    return { error: "Unknown role." };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { name: true, slug: true, ownerId: true, owner: { select: { email: true } } },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (workspace.owner.email.toLowerCase() === email) {
    return { error: "That address already owns this workspace." };
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

  const token = randomToken(24);
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

/** Accept a workspace invitation for the signed-in user. */
export async function acceptWorkspaceInviteAction(
  token: string,
): Promise<EmailResult<{ slug: string; workspaceName: string; role: string }>> {
  const user = await requireUser();
  const invite = await prisma.invite.findUnique({
    where: { token: hashToken(token) },
    select: {
      id: true,
      email: true,
      role: true,
      projectId: true,
      acceptedAt: true,
      expiresAt: true,
      workspace: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!invite) return { error: "That invitation link is not valid." };
  if (invite.acceptedAt) return { error: "That invitation has already been used." };
  if (invite.expiresAt.getTime() < Date.now()) return { error: "That invitation has expired." };
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return { error: `This invitation is for ${invite.email}. Sign in with that address.` };
  }

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: invite.workspace.id, userId: user.id } },
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

  revalidatePath("/w", "layout");
  return {
    ok: true,
    slug: invite.workspace.slug,
    workspaceName: invite.workspace.name,
    role: invite.role,
  };
}

