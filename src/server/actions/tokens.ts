"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomToken } from "@/lib/slug";
import { hashApiToken } from "@/lib/api-auth";

/** Create an API token; the plaintext is returned exactly once. */
export async function createApiTokenAction(
  name: string,
): Promise<{ token: string } | { error: string }> {
  const user = await requireUser();
  const label = name.trim().slice(0, 60) || "API token";
  const token = `noema_${randomToken(24)}`;
  await prisma.apiToken.create({
    data: { userId: user.id, name: label, tokenHash: hashApiToken(token) },
  });
  revalidatePath("/w", "layout");
  return { token };
}

export async function revokeApiTokenAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const deleted = await prisma.apiToken.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return { error: "Token not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}
