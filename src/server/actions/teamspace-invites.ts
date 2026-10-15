"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { normalizeEmail } from "@/lib/email-validation";
import { hashToken, randomToken } from "@/lib/secrets";
import { emailTemplate, escapeHtml, sendMail } from "@/lib/mailer";
import { appOrigin } from "@/server/actions/email";

export type InviteResult<T = unknown> = ({ ok: true } & T) | { error: string };

const INVITE_TTL_DAYS = 14;

type TeamspaceAuth =
  | { ok: false; error: string }
  | {
      ok: true;
      user: Awaited<ReturnType<typeof requireUser>>;
      teamspace: { id: string; name: string; workspaceId: string; workspace: { slug: string } };
      access: NonNullable<Awaited<ReturnType<typeof getWorkspaceAccess>>>;
    };

async function authorizeTeamspace(teamspaceId: string): Promise<TeamspaceAuth> {
  const user = await requireUser();
  const teamspace = await prisma.teamspace.findUnique({
    where: { id: teamspaceId },
    select: { id: true, name: true, workspaceId: true, workspace: { select: { slug: true } } },
  });
  if (!teamspace) return { ok: false, error: "Teamspace not found." };
  const access = await getWorkspaceAccess(user.id, teamspace.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { ok: false, error: "Only workspace admins can manage teamspace members." };
  }
  return { ok: true, user, teamspace, access };
}

/**
 * Invite someone to a teamspace by email.
 *
 * Existing workspace members are added straight away; everyone else gets a
 * single-use, expiring link (only the hash is stored) that is emailed when SMTP
 * is configured, and always returned so it can be shared by hand.
 */
export async function inviteTeamspaceMemberAction(input: {
  teamspaceId: string;
  email: string;
  role?: "MEMBER" | "ADMIN";
}): Promise<
  InviteResult<{ invited: boolean; added: boolean; link?: string; email: string; emailed?: boolean }>
> {
  const auth = await authorizeTeamspace(input.teamspaceId);
  if (!auth.ok) return { error: auth.error };

  // `@/lib/email-validation` validates and lowercases the domain; the app keys
  // invites/users on a fully-lowercase address, so fold the local part too.
  const email = normalizeEmail(input.email)?.toLowerCase() ?? null;
  if (!email) return { error: "Enter a valid email address." };
  const role = input.role === "ADMIN" ? "ADMIN" : "MEMBER";

  // Already a workspace member → grant teamspace access immediately.
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: auth.teamspace.workspaceId,
          userId: existingUser.id,
        },
      },
      select: { id: true },
    });
    const workspace = await prisma.workspace.findUnique({
      where: { id: auth.teamspace.workspaceId },
      select: { ownerId: true },
    });
    if (membership || workspace?.ownerId === existingUser.id) {
      await prisma.teamspaceMember.upsert({
        where: {
          teamspaceId_userId: { teamspaceId: input.teamspaceId, userId: existingUser.id },
        },
        create: { teamspaceId: input.teamspaceId, userId: existingUser.id, role: "MEMBER" },
        update: {},
      });
      revalidatePath("/w", "layout");
      return { ok: true, invited: false, added: true, email };
    }
  }

  const token = randomToken(24);
  await prisma.teamspaceInvite.upsert({
    where: { teamspaceId_email: { teamspaceId: input.teamspaceId, email } },
    create: {
      teamspaceId: input.teamspaceId,
      email,
      role,
      tokenHash: hashToken(token),
      invitedById: auth.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    update: {
      role,
      tokenHash: hashToken(token),
      invitedById: auth.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      acceptedById: null,
    },
  });

  const link = `/invite/teamspace/${token}`;
  const template = emailTemplate({
    heading: `You're invited to ${escapeHtml(auth.teamspace.name)}`,
    body: `${escapeHtml(auth.user.name)} added you to the <strong>${escapeHtml(
      auth.teamspace.name,
    )}</strong> teamspace on Noema. This link expires in ${INVITE_TTL_DAYS} days.`,
    ctaLabel: "Join teamspace",
    ctaUrl: `${await appOrigin()}${link}`,
  });
  const sent = await sendMail(auth.teamspace.workspaceId, {
    to: email,
    subject: `${auth.user.name} invited you to ${auth.teamspace.name}`,
    kind: "teamspace-invite",
    ...template,
  });

  revalidatePath("/w", "layout");
  return { ok: true, invited: true, added: false, email, link, emailed: !("error" in sent) };
}

/** Cancel a pending invitation. */
export async function revokeTeamspaceInviteAction(inviteId: string): Promise<InviteResult> {
  const invite = await prisma.teamspaceInvite.findUnique({
    where: { id: inviteId },
    select: { teamspaceId: true },
  });
  if (!invite) return { error: "Invitation not found." };
  const auth = await authorizeTeamspace(invite.teamspaceId);
  if (!auth.ok) return { error: auth.error };
  await prisma.teamspaceInvite.delete({ where: { id: inviteId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Accept an invitation for the signed-in user (called by the invite page). */
export async function acceptTeamspaceInviteAction(
  token: string,
): Promise<InviteResult<{ slug: string; teamspaceName: string }>> {
  const user = await requireUser();
  const invite = await prisma.teamspaceInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      teamspaceId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      teamspace: { select: { name: true, workspace: { select: { slug: true, id: true } } } },
    },
  });
  if (!invite) return { error: "That invitation link is not valid." };
  if (invite.acceptedAt) return { error: "That invitation has already been used." };
  if (invite.expiresAt.getTime() < Date.now()) return { error: "That invitation has expired." };
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return { error: `This invitation is for ${invite.email}. Sign in with that address.` };
  }

  // Joining a teamspace implies workspace membership for the invitee.
  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: { workspaceId: invite.teamspace.workspace.id, userId: user.id },
    },
    create: { workspaceId: invite.teamspace.workspace.id, userId: user.id, role: "MEMBER" },
    update: {},
  });
  await prisma.teamspaceMember.upsert({
    where: { teamspaceId_userId: { teamspaceId: invite.teamspaceId, userId: user.id } },
    create: { teamspaceId: invite.teamspaceId, userId: user.id, role: invite.role },
    update: {},
  });
  await prisma.teamspaceInvite.update({
    where: { id: invite.id },
    data: { acceptedAt: new Date(), acceptedById: user.id },
  });

  revalidatePath("/w", "layout");
  return { ok: true, slug: invite.teamspace.workspace.slug, teamspaceName: invite.teamspace.name };
}

