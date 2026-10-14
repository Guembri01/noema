/**
 * Minimal RSS 2.0 and Atom 1.0 builders for public-page syndication — the
 * outbound half of feeds, a sibling of src/lib/ics.ts.
 *
 * Pure: no prisma, no network, and no clock reads. Callers inject every date,
 * so the same input always produces byte-identical output (pinned by the export
 * block in src/lib/rss.test.ts).
 */

/** One entry to serialise into an RSS `<item>` or an Atom `<entry>`. */
export interface FeedItemInput {
  title: string;
  link: string;
  /** RSS `<guid>`; defaults to {@link link}. */
  guid?: string;
  /** Atom `<id>`; defaults to {@link guid} then {@link link}. */
  id?: string;
  /** RSS `<pubDate>` source — an ISO 8601 instant or a `Date`. */
  pubDate?: string | Date;
  /** Atom `<published>`/`<updated>` source; defaults to {@link pubDate}. */
  published?: string | Date;
  description?: string;
}

/** Feed-level metadata for {@link buildRssFeed} and {@link buildAtomFeed}. */
export interface FeedInput {
  title: string;
  link: string;
  /** RSS `<description>` / Atom `<subtitle>`; omitted when absent. */
  description?: string;
  /** Atom feed `<id>`; defaults to {@link link}. */
  id?: string;
  /** Atom feed `<updated>` source; defaults to the newest item date. */
  updated?: string | Date;
  items: FeedItemInput[];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const EPOCH = "1970-01-01T00:00:00.000Z";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const pad = (value: number): string => String(value).padStart(2, "0");

const toDate = (value: string | Date): Date =>
  typeof value === "string" ? new Date(value) : value;

const requireDate = (value: string | Date): Date => {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date;
};

/**
 * Escape the five predefined XML entities (`&`, `<`, `>`, `"`, `'`). `&` is
 * replaced first so the entities introduced later are never re-escaped. Safe
 * for both text nodes and attribute values.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format an instant as RFC 822/1123 in GMT, e.g.
 * `Thu, 15 Jan 2026 12:00:00 GMT`. Reads only UTC fields, so the output does
 * not depend on the host timezone.
 */
export function formatRfc822Date(value: string | Date): string {
  const date = requireDate(value);
  const day = DAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} GMT`;
}

/** Format an instant as UTC ISO 8601 with millisecond precision. */
export function formatIso8601Date(value: string | Date): string {
  return requireDate(value).toISOString();
}

/** The date an item carries, if any (Atom `published` wins over RSS `pubDate`). */
function itemDate(item: FeedItemInput): Date | null {
  const source = item.published ?? item.pubDate;
  if (source === undefined) return null;
  const date = toDate(source);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Atom feed `<updated>`: the injected value, else the newest item date. */
function feedUpdated(feed: FeedInput): string {
  if (feed.updated !== undefined) return formatIso8601Date(feed.updated);
  let newest: Date | null = null;
  for (const item of feed.items) {
    const date = itemDate(item);
    if (date && (!newest || date.getTime() > newest.getTime())) newest = date;
  }
  return newest ? formatIso8601Date(newest) : EPOCH;
}

/**
 * Serialise a feed as RSS 2.0 (https://www.rssboard.org/rss-specification).
 * Channel `title`/`link` are always emitted and `description` only when
 * supplied; each item carries `title`, `link`, a `guid` (falling back to the
 * link), an RFC 822 `pubDate` when known, and an optional `description`. Text
 * is XML-escaped, item order is preserved, and identical input yields
 * byte-identical output.
 */
export function buildRssFeed(feed: FeedInput): string {
  const lines: string[] = [
    XML_DECLARATION,
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(feed.title)}</title>`,
    `    <link>${escapeXml(feed.link)}</link>`,
  ];
  if (feed.description !== undefined) {
    lines.push(`    <description>${escapeXml(feed.description)}</description>`);
  }

  for (const item of feed.items) {
    lines.push("    <item>");
    lines.push(`      <title>${escapeXml(item.title)}</title>`);
    lines.push(`      <link>${escapeXml(item.link)}</link>`);
    lines.push(`      <guid>${escapeXml(item.guid ?? item.id ?? item.link)}</guid>`);
    const date = itemDate(item);
    if (date) lines.push(`      <pubDate>${formatRfc822Date(date)}</pubDate>`);
    if (item.description !== undefined) {
      lines.push(`      <description>${escapeXml(item.description)}</description>`);
    }
    lines.push("    </item>");
  }

  lines.push("  </channel>", "</rss>");
  return lines.join("\n");
}

/**
 * Serialise a feed as Atom 1.0 (RFC 4287). The feed emits `title`, a `link`
 * (`href`), an `id` (falling back to the link), an ISO 8601 `updated` (the
 * injected date, else the newest item date, else the epoch) and a `subtitle`
 * only when a description is supplied. Each entry carries `title`, a `link`, an
 * `id` (falling back to the guid then the link), an ISO 8601 `updated`, a
 * `published` when the item has a date, and an optional `summary`. Text and
 * attributes are XML-escaped and item order is preserved.
 */
export function buildAtomFeed(feed: FeedInput): string {
  const updated = feedUpdated(feed);
  const lines: string[] = [
    XML_DECLARATION,
    `<feed xmlns="${ATOM_NAMESPACE}">`,
    `  <title>${escapeXml(feed.title)}</title>`,
    `  <link href="${escapeXml(feed.link)}"/>`,
    `  <id>${escapeXml(feed.id ?? feed.link)}</id>`,
    `  <updated>${updated}</updated>`,
  ];
  if (feed.description !== undefined) {
    lines.push(`  <subtitle>${escapeXml(feed.description)}</subtitle>`);
  }

  for (const item of feed.items) {
    const date = itemDate(item);
    const stamp = date ? formatIso8601Date(date) : updated;
    lines.push("  <entry>");
    lines.push(`    <title>${escapeXml(item.title)}</title>`);
    lines.push(`    <link href="${escapeXml(item.link)}"/>`);
    lines.push(`    <id>${escapeXml(item.id ?? item.guid ?? item.link)}</id>`);
    lines.push(`    <updated>${stamp}</updated>`);
    if (item.published !== undefined || item.pubDate !== undefined) {
      lines.push(`    <published>${stamp}</published>`);
    }
    if (item.description !== undefined) {
      lines.push(`    <summary>${escapeXml(item.description)}</summary>`);
    }
    lines.push("  </entry>");
  }

  lines.push("</feed>");
  return lines.join("\n");
}
