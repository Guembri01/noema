import { prisma } from "@/lib/db";

/**
 * B25 — the replay guard for two-factor codes.
 *
 * A TOTP code is valid for its whole time step (30 s) and the sign-in used
 * to accept it again and again: `verifyTotp` was a pure function and nothing
 * recorded that a step had been spent. A code that had been observed (a
 * phishing screen, a screenshot, a shoulder surfer) therefore opened a fresh
 * session every time it was replayed inside the ±1 step window — up to 90
 * seconds, one session per replay.
 *
 * The spent step is therefore persisted on the account (`User.twoFactorCounter`)
 * and it is spent ATOMICALLY: the row is only written when the step it holds
 * is lower than the one being spent. The comparison happens inside the
 * UPDATE, so two requests carrying the same code cannot both win — the second
 * one matches no row and is refused.
 */

/**
 * Spend the time step `counter` for `userId`.
 *
 * Returns `true` when the step was still free (the code may be used) and
 * `false` when it had been spent already (the code is a replay).
 */
export async function consumeTotpStep(
  userId: string,
  counter: number,
): Promise<boolean> {
  // A conditional update, so the check above and the write cannot race: two
  // concurrent uses of the same code both see a free step, but only the first
  // `UPDATE … WHERE twoFactorCounter < step` matches a row (`count === 1`).
  // The loser gets no session.
  const consumed = await prisma.user.updateMany({
    where: {
      id: userId,
      // A row that never spent a step (NULL) accepts the first one; after that
      // only a NEWER step is accepted, so the same code is refused.
      OR: [{ twoFactorCounter: null }, { twoFactorCounter: { lt: counter } }],
    },
    data: { twoFactorCounter: counter },
  });
  return consumed.count === 1;
}
