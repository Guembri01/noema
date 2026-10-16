"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomToken } from "@/lib/slug";
import { hashApiToken } from "@/lib/api-auth";
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
};

/**
 * Create an API token; the plaintext is returned exactly once. `scopes` is the
 * candidate grant list from the picker: it is validated with `validateScopes`
 * (rejected wholesale on any issue) and stored as `expandScopes(scopes)`, the
 * effective permission set. Omitting `scopes` keeps the original
 * scope-less behaviour.
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
    },
  });
  revalidatePath("/w", "layout");
  return { token };
}

/**
 * List the signed-in user's tokens with their stored scopes, newest first, so
 * the settings UI can show each token's permissions.
 */
export async function listApiTokensAction(): Promise<ApiTokenSummary[]> {
  const user = await requireUser();
  const tokens = await prisma.apiToken.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, scopes: true, createdAt: true, lastUsedAt: true },
  });
  return tokens.map((token) => ({
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Revoke one of the signed-in user's tokens. */
export async function revokeApiTokenAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const deleted = await prisma.apiToken.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return { error: "Token not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}
