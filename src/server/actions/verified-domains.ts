"use server";

/** DNS-verified email domains for SAML auto-join (R10.9). */

import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import {
  hasVerificationToken,
  normalizeDomain,
  verificationRecordName,
} from "@/lib/sso/domains";

export type VerifiedDomainResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string };

export type VerifiedDomainView = {
  id: string;
  domain: string;
  recordName: string;
  verifyToken: string;
  verifiedAt: string | null;
  connectionId: string | null;
};

export const DOMAIN_VERIFICATION_TTL_HINT =
  "Publish the TXT record, then verify. DNS caches can take a few minutes.";

const SELECT = {
  id: true,
  domain: true,
  verifyToken: true,
  verifiedAt: true,
  connectionId: true,
} as const;

type DomainRow = {
  id: string;
  domain: string;
  verifyToken: string;
  verifiedAt: Date | null;
  connectionId: string | null;
};

function toView(row: DomainRow): VerifiedDomainView {
  return {
    id: row.id,
    domain: row.domain,
    recordName: verificationRecordName(row.domain),
    verifyToken: row.verifyToken,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    connectionId: row.connectionId,
  };
}

type DomainAuth =
  | { error: string }
  | { user: Awaited<ReturnType<typeof requireUser>> };

async function authorize(workspaceId: string): Promise<DomainAuth> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canPerformWorkspaceAction(access.role, "manageSettings")) {
    return { error: "You do not have permission to manage verified domains." };
  }
  return { user };
}

/** List every domain row (verified and pending) for an admin. */
export async function listVerifiedDomainsAction(
  workspaceId: string,
): Promise<VerifiedDomainResult<{ domains: VerifiedDomainView[] }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const rows = await prisma.verifiedDomain.findMany({
    where: { workspaceId },
    orderBy: { domain: "asc" },
    select: SELECT,
  });
  return { ok: true, domains: rows.map(toView) };
}

/** Add a pending domain and return the TXT name/token to publish. */
export async function addVerifiedDomainAction(
  workspaceId: string,
  rawDomain: string,
  connectionId?: string,
): Promise<VerifiedDomainResult<{ domain: VerifiedDomainView }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { error: "Enter a valid domain such as acme.com." };
  if (connectionId) {
    const connection = await prisma.ssoConnection.findFirst({
      where: { id: connectionId, workspaceId },
      select: { id: true },
    });
    if (!connection) return { error: "That SAML connection does not exist in this workspace." };
  }

  const existing = await prisma.verifiedDomain.findUnique({
    where: { workspaceId_domain: { workspaceId, domain } },
    select: SELECT,
  });
  if (existing) return { ok: true, domain: toView(existing) };

  const row = await prisma.verifiedDomain.create({
    data: {
      workspaceId,
      domain,
      verifyToken: randomBytes(24).toString("base64url"),
      ...(connectionId ? { connectionId } : {}),
    },
    select: SELECT,
  });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.domain_added",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { domain },
  });
  return { ok: true, domain: toView(row) };
}

/** Resolve the TXT record and mark the domain verified. */
export async function verifyVerifiedDomainAction(
  workspaceId: string,
  rawDomain: string,
): Promise<VerifiedDomainResult<{ domain: VerifiedDomainView }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { error: "Enter a valid domain such as acme.com." };
  const row = await prisma.verifiedDomain.findUnique({
    where: { workspaceId_domain: { workspaceId, domain } },
    select: SELECT,
  });
  if (!row) return { error: "Add the domain before verifying it." };

  let records: string[][];
  try {
    records = await resolveTxt(verificationRecordName(domain));
  } catch {
    return { error: "The verification TXT record was not found." };
  }
  if (!hasVerificationToken(records, row.verifyToken)) {
    return { error: "The verification TXT record does not contain the expected token." };
  }

  const updated = await prisma.verifiedDomain.update({
    where: { id: row.id },
    data: { verifiedAt: new Date() },
    select: SELECT,
  });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.domain_verified",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { domain },
  });
  return { ok: true, domain: toView(updated) };
}

/** Delete a domain (verified or pending). */
export async function deleteVerifiedDomainAction(
  workspaceId: string,
  rawDomain: string,
): Promise<VerifiedDomainResult> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { error: "Enter a valid domain such as acme.com." };
  const row = await prisma.verifiedDomain.findUnique({
    where: { workspaceId_domain: { workspaceId, domain } },
    select: { id: true },
  });
  if (!row) return { error: "That domain is not on this workspace." };
  await prisma.verifiedDomain.delete({ where: { id: row.id } });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.domain_deleted",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { domain },
  });
  return { ok: true };
}
