"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomToken } from "@/lib/slug";
import { hashOAuthSecret } from "@/lib/api-auth";

/** Register an OAuth app; the client secret is returned exactly once. */
export async function createOAuthAppAction(
  name: string,
  redirectUris: string,
  requiresPkce = false,
): Promise<{ clientId: string; clientSecret: string } | { error: string }> {
  const user = await requireUser();
  const label = name.trim().slice(0, 80) || "OAuth app";
  const uris = redirectUris
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter(Boolean);
  if (uris.length === 0) return { error: "Add at least one redirect URI." };
  for (const uri of uris) {
    try {
      new URL(uri);
    } catch {
      return { error: `Invalid redirect URI: ${uri}` };
    }
  }
  if (typeof requiresPkce !== "boolean") {
    return { error: "requiresPkce must be a boolean." };
  }

  // Only the digest is stored: the plaintext is handed back once, here, and
  // never persisted.
  const clientSecret = randomToken(24);
  const app = await prisma.oAuthApp.create({
    data: {
      userId: user.id,
      name: label,
      clientId: `noema_${randomToken(12)}`,
      clientSecretHash: hashOAuthSecret(clientSecret),
      redirectUris: uris,
      requiresPkce,
    },
  });
  revalidatePath("/w", "layout");
  return { clientId: app.clientId, clientSecret };
}

export async function deleteOAuthAppAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const deleted = await prisma.oAuthApp.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return { error: "App not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}
