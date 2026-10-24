/** Bearer-token authentication for the SCIM 2.0 endpoints. */

import { prisma } from "@/lib/db";
import { hashScimToken } from "@/lib/scim/users";

export type ScimContext = { connectionId: string; workspaceId: string };

/**
 * Resolve `Authorization: Bearer <token>` to an enabled SCIM connection. Only
 * the SHA-256 of the token is stored, so the lookup is a hash equality check
 * and a database dump never reveals a usable token. Anything malformed or
 * missing fails closed to `null`.
 */
export async function authenticateScim(request: Request): Promise<ScimContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (token.length < 24) return null;
  const scimTokenHash = await hashScimToken(token);
  const connection = await prisma.ssoConnection.findFirst({
    where: { scimEnabled: true, scimTokenHash },
    select: { id: true, workspaceId: true },
  });
  return connection
    ? { connectionId: connection.id, workspaceId: connection.workspaceId }
    : null;
}
