import { prisma } from "@/lib/db";
import { pickVersionAuthor, type VersionAuthor } from "@/lib/version-history";

/**
 * The single version-authorship resolver for every history surface (R30.11
 * lite of docs/specs/version-history-v2.md).
 *
 * `PageVersion` has no user relation (`schema.prisma:250`), so both the page
 * history panel (`page.tsx`) and the ...-menu timeline (`page-menu.ts`) used
 * to resolve authors differently - the panel only among CURRENT members, the
 * menu by direct `User` lookup - and a departed member rendered inconsistently
 * between the two. This loader is the correct strategy from the spec: look up
 * the `User` row for each `createdById` regardless of membership, one query,
 * deduped ids.
 *
 * Returns a synchronous resolver; an author id with no surviving User row
 * resolves to `null` (the surface renders its label - the "Former member"
 * i18n label itself ships with T30.9/R30.11's schema FK work).
 */
export async function loadVersionAuthors(
  createdByIds: readonly (string | null | undefined)[],
): Promise<(createdById: string | null | undefined) => VersionAuthor | null> {
  const ids = [...new Set(createdByIds.filter((id): id is string => Boolean(id)))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      })
    : [];
  return (createdById) => pickVersionAuthor(createdById, users);
}
