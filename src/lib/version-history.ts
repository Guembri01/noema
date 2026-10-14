/**
 * Pure version-history helpers shared by the restore action and BOTH history
 * surfaces (page panel + ...-menu timeline). No Prisma here - the sandbox is
 * the unit harness (scripts/LOOP_PLAYBOOK.md "Domain sandboxes").
 *
 * B67 - M1 slice of docs/specs/version-history-v2.md (R30.5, R30.11-lite).
 */

/**
 * Summary written onto the pre-restore snapshot row (R30.5): it must cite the
 * RESTORED VERSION's own timestamp - the old code did
 * `new Date(version.id ? Date.now() : 0)`, which always rendered *today*.
 */
export function restoreVersionSummary(createdAt: Date): string {
  return `Restored the version from ${createdAt.toLocaleDateString()}`;
}

export type VersionAuthor = { id: string; name: string; email: string };

/**
 * Resolve a version's author from `User` rows (R30.11): by `createdById` alone
 * - current workspace membership is irrelevant, so a departed member still
 * resolves to their User row. Only a missing/deleted user yields `null`; the
 * surface then renders its own label. One resolver keeps the page panel and
 * the ...-menu timeline from drifting apart (spec audit: `page.tsx:198`
 * members-only vs `page-menu.ts:155-172` User lookup).
 */
export function pickVersionAuthor(
  createdById: string | null | undefined,
  users: readonly VersionAuthor[],
): VersionAuthor | null {
  if (!createdById) return null;
  return users.find((user) => user.id === createdById) ?? null;
}
