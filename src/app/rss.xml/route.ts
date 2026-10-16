import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildRssFeed, type FeedItemInput } from "@/lib/rss";

export const runtime = "nodejs";

/**
 * RSS 2.0 feed of recently updated pages published from a workspace. Next
 * serves this route handler at `/rss.xml`; the XML is produced by
 * `src/lib/rss.ts`'s pure `buildRssFeed`, so the same input is byte-identical
 * on every request.
 *
 * Only indexable, non-password, non-expired share links are syndicated — the
 * same public surface the sitemap lists, ordered by `Page.updatedAt` desc. An
 * optional `?workspace=<slug>` scopes the feed to one workspace; without it the
 * feed aggregates every published page on the instance.
 */

export const revalidate = 300;

const MAX_ITEMS = 50;
const SNIPPET_LENGTH = 280;
const DEFAULT_ORIGIN = "http://localhost:3000";

/** The absolute site origin, without a trailing slash. */
function siteOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin || DEFAULT_ORIGIN;
}

/** First line of the page's plain-text mirror, capped for a feed summary. */
function snippetOf(searchText: string | null): string | undefined {
  if (searchText === null) return undefined;
  const text = searchText.trim();
  if (text === "") return undefined;
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return undefined;
  return firstLine.length > SNIPPET_LENGTH
    ? `${firstLine.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

export async function GET(request: Request) {
  const origin = siteOrigin(request);
  const workspace = new URL(request.url).searchParams.get("workspace")?.trim() || undefined;
  const now = new Date();

  const links = await prisma.shareLink.findMany({
    where: {
      indexing: true,
      passwordHash: null,
      page: {
        deletedAt: null,
        ...(workspace ? { workspace: { slug: workspace } } : {}),
      },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: {
      token: true,
      page: { select: { title: true, updatedAt: true, searchText: true } },
    },
    orderBy: { page: { updatedAt: "desc" } },
    take: MAX_ITEMS,
  });

  const items: FeedItemInput[] = links.map((link) => {
    const url = `${origin}/s/${link.token}`;
    return {
      title: link.page.title.trim() || "Untitled",
      link: url,
      guid: url,
      pubDate: link.page.updatedAt,
      description: snippetOf(link.page.searchText),
    };
  });

  const feed = buildRssFeed({
    title: workspace ? `Noema — ${workspace} updates` : "Noema — public updates",
    link: origin,
    description: "Recently updated pages shared from this Noema workspace.",
    items,
  });

  return new NextResponse(feed, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
