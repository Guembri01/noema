import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";
import { SITEMAP_LIMIT, normalizeUrl, type ChangeFreq } from "@/lib/sitemap";

/**
 * Public sitemap for the pages this workspace has published. Next serves this
 * `app/sitemap.ts` at `/sitemap.xml`.
 *
 * Reachability for `src/lib/sitemap.ts`: the pure builder owns URL
 * normalisation (`normalizeUrl`) and the per-file cap (`SITEMAP_LIMIT`), and
 * the unit suite pins its XML serialisation. Only share links the publisher
 * marked indexable are listed; password-protected and expired links are
 * excluded so a protected page can never leak into a search index.
 *
 * `APP_URL` is the site origin the relative `/s/<token>` paths are resolved
 * against (the module returns absolute locs); it falls back to localhost for a
 * self-hosted/dev run with no configured origin.
 *
 * The route is **dynamic**, not prerendered: a build must not need a live
 * database (a database blip blocked a deploy and the desktop payload build
 * died on a placeholder `DATABASE_URL`). The query still fails closed, so a
 * runtime outage serves an empty sitemap rather than a stale or partial one.
 */

export const dynamic = "force-dynamic";

const DEFAULT_ORIGIN = "http://localhost:3000";

/** The absolute site origin, without a trailing slash. */
function siteOrigin(): string {
  return (process.env.APP_URL?.trim() || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  let links: Array<{ token: string; page: { updatedAt: Date } }>;
  try {
    links = await prisma.shareLink.findMany({
      where: {
        indexing: true,
        passwordHash: null,
        page: { deletedAt: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { token: true, page: { select: { updatedAt: true } } },
      orderBy: { page: { updatedAt: "desc" } },
      take: SITEMAP_LIMIT,
    });
  } catch (error) {
    // A build must not depend on a reachable database, and a runtime outage
    // must not fail the route. An empty sitemap is the honest answer: no
    // database, no known published pages. The next successful request fills it.
    console.warn(
      `[sitemap] no published pages: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const changeFrequency: ChangeFreq = "weekly";
  const origin = siteOrigin();

  return links.map((link) => ({
    url: normalizeUrl(origin, `/s/${link.token}`),
    lastModified: link.page.updatedAt,
    changeFrequency,
    priority: 0.6,
  }));
}
