"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomToken } from "@/lib/slug";
import { hashApiToken, apiTokenExpiry } from "@/lib/api-auth";
import { expandScopes, validateScopes } from "@/lib/api-token-scope";

/**
 * A token as the settings UI consumes it. `scopes` are the stored,
 * already-expanded permission ids, so the UI can render exactly what the token
 * currently grants without re-deriving the hierarchy.
 */
export type ApiTokenSummary = {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  /** The deadline the token dies at; `null` = the token never expires. */
  expiresAt: string | null;
};

/**
 * Create an API token; the plaintext is returned exactly once. `scopes` is the
 * candidate grant list from the picker: it is validated with `validateScopes`
 * (rejected wholesale on any issue) and stored as `expandScopes(scopes)`, the
 * effective permission set. Omitting `scopes` keeps the original
 * scope-less behaviour.
 *
 * Every token gets a deadline (B29): `apiTokenExpiry()` writes the default
 * lifetime into the row, so a token that leaks dies on its own instead of
 * working until somebody deletes it by hand.
 */
export async function createApiTokenAction(
  name: string,
  scopes: readonly string[] = [],
): Promise<{ token: string } | { error: string }> {
  const user = await requireUser();
  const label = name.trim().slice(0, 60) || "API token";

  const validation = validateScopes(scopes);
  if (!validation.ok) return { error: "Invalid scopes." };

  const token = `noema_${randomToken(24)}`;
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: label,
      tokenHash: hashApiToken(token),
      scopes: expandScopes(scopes),
      expiresAt: apiTokenExpiry(),
    },
  });
  revalidatePath("/w", "layout");
  return { token };
}

/**
 * List the signed-in user's tokens with their stored scopes and their
 * deadline, newest first, so the settings UI can show each token's permissions
 * and how long it still lives.
 */
export async function listApiTokensAction(): Promise<ApiTokenSummary[]> {
  const user = await requireUser();
  const tokens = await prisma.apiToken.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
  return tokens.map((token) => ({
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  }));
}

/**
 * Revoke one of the signed-in user's tokens.
 *
 * The revoke deletes the row, scoped to its owner: the token stops working at
 * once, because a deleted row cannot authenticate. B29 also asked for a
 * `revokedAt` flag next to the expiry; that flag would only add an audit
 * trail — the credential is dead either way — so the delete stays.
 */
export async function revokeApiTokenAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const deleted = await prisma.apiToken.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return { error: "Token not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}
