"use server";

/** Per-workspace SAML connection management (admin settings surface). */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import { parseSamlRoleRules } from "@/lib/sso/saml";
import { parseIdpMetadata } from "@/lib/sso/metadata";
import { safeFetchGuarded } from "@/lib/feed-guard";

export type SsoConnectionResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string };

/** The editable fields of a workspace SAML connection. */
export type SsoConnectionInput = {
  name: string;
  idpEntityId: string;
  ssoUrl: string;
  certificate: string;
  metadataUrl?: string;
  spEntityId?: string;
  callbackUrl?: string;
  emailAttribute?: string;
  nameAttribute?: string;
  groupsAttribute?: string;
  /** `group:ROLE` shorthand or a JSON array. */
  roleRules?: string;
  enabled?: boolean;
};

/** The safe projection the settings UI receives. */
export type SsoConnectionView = {
  id: string;
  name: string;
  idpEntityId: string;
  ssoUrl: string;
  metadataUrl: string | null;
  metadataFetchedAt: string | null;
  spEntityId: string | null;
  callbackUrl: string | null;
  emailAttribute: string | null;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  roleRules: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

const SELECT = {
  id: true,
  name: true,
  idpEntityId: true,
  ssoUrl: true,
  metadataUrl: true,
  metadataFetchedAt: true,
  spEntityId: true,
  callbackUrl: true,
  emailAttribute: true,
  nameAttribute: true,
  groupsAttribute: true,
  roleRules: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateInput(input: SsoConnectionInput):
  | { ok: true; data: Omit<Prisma.SsoConnectionCreateInput, "workspace"> }
  | { ok: false; error: string } {
  const name = text(input.name);
  const idpEntityId = text(input.idpEntityId);
  const ssoUrl = text(input.ssoUrl);
  const certificate = text(input.certificate).replace(/\\n/g, "\n");
  if (!name) return { ok: false, error: "Give this connection a name." };
  if (!idpEntityId) return { ok: false, error: "The IdP entity id is required." };
  if (!/^https?:\/\//i.test(ssoUrl)) {
    return { ok: false, error: "The IdP SSO URL must be an http(s) URL." };
  }
  if (!certificate.includes("-----BEGIN ")) {
    return { ok: false, error: "The IdP certificate must be PEM text." };
  }
  const metadataUrl = text(input.metadataUrl);
  if (metadataUrl && !/^https:\/\//i.test(metadataUrl)) {
    return { ok: false, error: "The metadata URL must be an https URL." };
  }
  const spEntityId = text(input.spEntityId);
  const callbackUrl = text(input.callbackUrl);
  if (spEntityId && !/^https?:\/\//i.test(spEntityId)) {
    return { ok: false, error: "The SP entity id must be an http(s) URL." };
  }
  if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) {
    return { ok: false, error: "The ACS URL must be an http(s) URL." };
  }
  const rules = parseSamlRoleRules(input.roleRules);
  if (!rules.ok) return { ok: false, error: rules.reason };

  return {
    ok: true,
    data: {
      name,
      protocol: "saml",
      idpEntityId,
      ssoUrl,
      certificate,
      metadataUrl: metadataUrl || null,
      spEntityId: spEntityId || null,
      callbackUrl: callbackUrl || null,
      emailAttribute: text(input.emailAttribute) || null,
      nameAttribute: text(input.nameAttribute) || null,
      groupsAttribute: text(input.groupsAttribute) || null,
      roleRules:
        rules.rules.length === 0
          ? Prisma.JsonNull
          : (rules.rules as unknown as Prisma.InputJsonValue),
      enabled: input.enabled !== false,
    },
  };
}

type SsoAuth =
  | { error: string }
  | {
      user: Awaited<ReturnType<typeof requireUser>>;
      access: NonNullable<Awaited<ReturnType<typeof getWorkspaceAccess>>>;
    };

/** Resolve admin access to a workspace or return the error result. */
async function authorize(workspaceId: string): Promise<SsoAuth> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canPerformWorkspaceAction(access.role, "manageSettings")) {
    return { error: "You do not have permission to manage single sign-on." };
  }
  return { user, access };
}

function toView(row: {
  id: string;
  name: string;
  idpEntityId: string;
  ssoUrl: string;
  metadataUrl: string | null;
  metadataFetchedAt: Date | null;
  spEntityId: string | null;
  callbackUrl: string | null;
  emailAttribute: string | null;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  roleRules: Prisma.JsonValue;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SsoConnectionView {
  return {
    id: row.id,
    name: row.name,
    idpEntityId: row.idpEntityId,
    ssoUrl: row.ssoUrl,
    metadataUrl: row.metadataUrl,
    metadataFetchedAt: row.metadataFetchedAt?.toISOString() ?? null,
    spEntityId: row.spEntityId,
    callbackUrl: row.callbackUrl,
    emailAttribute: row.emailAttribute,
    nameAttribute: row.nameAttribute,
    groupsAttribute: row.groupsAttribute,
    roleRules:
      row.roleRules === null || row.roleRules === undefined
        ? ""
        : JSON.stringify(row.roleRules),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List the workspace's SAML connections (admin only; includes no secrets). */
export async function listSsoConnectionsAction(
  workspaceId: string,
): Promise<SsoConnectionResult<{ connections: SsoConnectionView[] }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const rows = await prisma.ssoConnection.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: SELECT,
  });
  return { ok: true, connections: rows.map(toView) };
}

/** Create a SAML connection for the workspace. */
export async function createSsoConnectionAction(
  workspaceId: string,
  input: SsoConnectionInput,
): Promise<SsoConnectionResult<{ id: string }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const validated = validateInput(input);
  if (!validated.ok) return { error: validated.error };

  const row = await prisma.ssoConnection.create({
    data: { ...validated.data, workspace: { connect: { id: workspaceId } } },
    select: { id: true },
  });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.connection_created",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { connectionId: row.id, name: text(input.name) },
  });
  return { ok: true, id: row.id };
}

/** Update one of the workspace's connections. */
export async function updateSsoConnectionAction(
  workspaceId: string,
  connectionId: string,
  input: SsoConnectionInput,
): Promise<SsoConnectionResult> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const existing = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true },
  });
  if (!existing) return { error: "That SAML connection does not exist in this workspace." };
  const validated = validateInput(input);
  if (!validated.ok) return { error: validated.error };

  await prisma.ssoConnection.update({
    where: { id: connectionId },
    data: validated.data,
  });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.connection_updated",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { connectionId, name: text(input.name) },
  });
  return { ok: true };
}

/**
 * Re-fetch an IdP metadata URL (R10.17). The new signing certificate replaces
 * the current one while the previous certificate remains valid for a 24-hour
 * overlap, so an in-flight rotation never locks users out.
 */
export async function refreshSsoConnectionMetadataAction(
  workspaceId: string,
  connectionId: string,
): Promise<SsoConnectionResult<{ connection: SsoConnectionView }>> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const row = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true, metadataUrl: true, certificate: true },
  });
  if (!row) return { error: "That SAML connection does not exist in this workspace." };
  if (!row.metadataUrl || !/^https:\/\//i.test(row.metadataUrl)) {
    return { error: "Set an https metadata URL on this connection first." };
  }

  const fetched = await safeFetchGuarded(row.metadataUrl, {
    headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(5000),
  });
  if (!fetched.ok) {
    return {
      error:
        fetched.reason === "blocked"
          ? "The metadata URL was refused by the outbound network guard."
          : "The metadata URL could not be fetched.",
    };
  }
  if (!fetched.response.ok) {
    return { error: `The metadata URL answered ${fetched.response.status}.` };
  }
  const parsed = await parseIdpMetadata(await fetched.response.text());
  if (!parsed.ok) return { error: parsed.reason };

  const now = new Date();
  const nextCertificate = parsed.metadata.certificates[0];
  const rotated = nextCertificate.trim() !== row.certificate.trim();
  const updated = await prisma.ssoConnection.update({
    where: { id: connectionId },
    data: {
      idpEntityId: parsed.metadata.entityId,
      ssoUrl: parsed.metadata.ssoUrl,
      certificate: nextCertificate,
      metadataFetchedAt: now,
      ...(rotated
        ? {
            prevCertificate: row.certificate,
            prevCertificateExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          }
        : {}),
    },
    select: SELECT,
  });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.metadata_refreshed",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { connectionId, rotated },
  });
  return { ok: true, connection: toView(updated) };
}

/** Delete one of the workspace's connections. */
export async function deleteSsoConnectionAction(
  workspaceId: string,
  connectionId: string,
): Promise<SsoConnectionResult> {
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;
  const existing = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true, name: true },
  });
  if (!existing) return { error: "That SAML connection does not exist in this workspace." };
  await prisma.ssoConnection.delete({ where: { id: connectionId } });
  await logActivity({
    workspaceId,
    actorId: auth.user.id,
    action: "sso.connection_deleted",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { connectionId, name: existing.name },
  });
  return { ok: true };
}
