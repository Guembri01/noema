import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

/** API tokens are stored as SHA-256 hashes; the plaintext is shown once. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function apiTokenMatches(token: string, hash: string): boolean {
  // A missing or malformed digest can never match — and it must not throw
  // either: a comparison that throws answers 500 instead of 401.
  if (typeof hash !== "string" || hash.length === 0) return false;
  const a = Buffer.from(hashApiToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * OAuth client secrets and authorization codes are stored the same way API
 * tokens are: as a SHA-256 digest. The plaintext exists only in the response
 * that shows it to the user (or in the redirect that hands the code to the
 * client) — never in the database.
 */
export function hashOAuthSecret(secret: string): string {
  return hashApiToken(secret);
}

/** Constant-time comparison of a presented OAuth secret against its digest. */
export function oauthSecretMatches(secret: string, hash: string): boolean {
  return apiTokenMatches(secret, hash);
}

/**
 * How long a freshly minted API token stays valid (B29).
 *
 * The token carries its own deadline (`ApiToken.expiresAt`); this is the
 * default lifetime the creation paths write into it — 90 days. A token that
 * was created without a deadline never expires, but nothing in the app mints
 * such a token.
 */
export const API_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** The deadline a token minted at `from` gets. */
export function apiTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + API_TOKEN_LIFETIME_MS);
}

/**
 * The authenticated principal of a bearer request: the token owner plus the
 * scopes the token was granted.
 *
 * `scopes` is the *granted* list exactly as stored on the row. It is not
 * expanded here — `hasScope` (see `@/lib/api-token-scope`) expands the
 * hierarchy (`write:pages` implies `read:pages`, `admin:workspace` implies
 * everything) and fails closed on an unknown or empty grant.
 */
export interface ApiTokenAuth {
  userId: string;
  scopes: string[];
}

/**
 * Resolve the user and the granted scopes for a `Authorization: Bearer <token>`
 * request. The scope column is read together with the token, so every caller
 * can enforce the grant instead of re-resolving the token on its own. The
 * deadline of the token is read in the same query and checked here: a token
 * past its deadline is refused like an unknown one.
 */
export async function authenticateApiRequest(
  request: Request,
): Promise<ApiTokenAuth | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return null;

  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: { id: true, userId: true, tokenHash: true, scopes: true, expiresAt: true },
  });
  if (!record || !apiTokenMatches(token, record.tokenHash)) return null;

  // B29: a token past its deadline is refused like an unknown one — a leaked
  // credential must not work forever. The deadline is read in the same query
  // that verifies the token, so there is no second lookup that could race with
  // the check. A token without a deadline (`expiresAt` is null) never expires.
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return null;

  await prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { userId: record.userId, scopes: record.scopes };
}
