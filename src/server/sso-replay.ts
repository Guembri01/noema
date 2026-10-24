/**
 * SAML assertion replay cache (R10.4/R10.16).
 *
 * One insert per accepted assertion; the primary key makes the check-and-set
 * atomic across requests and instances. Expired rows are deleted
 * opportunistically on the way in, so the table stays small without a cron.
 */

import { prisma } from "@/lib/db";

/** How long an accepted response is remembered (assertion lifetime + skew). */
export const SAML_ASSERTION_TTL_MS = 12 * 60 * 1000;

/** A unique-constraint failure is the "already seen" signal. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Claim `assertionKey` for this sign-in. Returns `false` when it was already
 * claimed (a replay), `true` when this request won the insert. Cleanup errors
 * are ignored; a failure to insert anything other than a duplicate is
 * propagated so the caller can fail closed.
 */
export async function claimSamlAssertion(
  assertionKey: string,
  now: Date = new Date(),
  ttlMs: number = SAML_ASSERTION_TTL_MS,
): Promise<boolean> {
  try {
    await prisma.samlAssertionSeen.deleteMany({
      where: { expiresAt: { lt: now } },
    });
  } catch {
    // An unavailable cleanup must not turn a valid login into a failure; the
    // primary-key insert below is the security-relevant operation.
  }

  try {
    await prisma.samlAssertionSeen.create({
      data: {
        id: assertionKey,
        expiresAt: new Date(now.getTime() + ttlMs),
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}
