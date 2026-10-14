import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

/** API tokens are stored as SHA-256 hashes; the plaintext is shown once. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function apiTokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashApiToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolve the user for a `Authorization: Bearer <token>` request. */
export async function authenticateApiRequest(
  request: Request,
): Promise<{ userId: string } | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return null;

  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: { id: true, userId: true, tokenHash: true },
  });
  if (!record || !apiTokenMatches(token, record.tokenHash)) return null;

  await prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { userId: record.userId };
}
