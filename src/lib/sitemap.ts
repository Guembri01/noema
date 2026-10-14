/**
 * Sitemap builder for the public site map (`/sitemap.xml` and, once the entry
 * list crosses the 50 000-URL limit, the `<sitemapindex>` fan-out).
 *
 * The whole module is pure: no database, no clock, no filesystem. Identical
 * input always produces byte-identical output, which is what lets the route
 * layer cache the document and what pins the format in `sitemap.test.ts`.
 *
 *   escapeXml(value)                     — the one XML escaper
 *   normalizeUrl(base, path)             — absolute-URL-safe path join
 *   buildSitemap(entries, { baseUrl })   — entries → `<urlset>` document
 *   paginateSitemap(entries, { max })    — entries → index-splitting pages
 *
 * The XML dialect follows the sitemap.org protocol: `loc` is required, the
 * `lastmod` / `changefreq` / `priority` children are optional and are only
 * emitted when supplied. `priority` is validated to `[0, 1]` and `changefreq`
 * to the protocol enum; a bad value is a programmer error and throws rather
 * than silently shipping an invalid document.
 */

/** The sitemap.org `changefreq` enumeration. */
export const CHANGEFREQ = [
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
] as const;

/** One of the sitemap.org `changefreq` values. */
export type ChangeFreq = (typeof CHANGEFREQ)[number];

/** The per-URL limit a single sitemap may not exceed. */
export const SITEMAP_LIMIT = 50000;

/** One `<url>` entry. `loc` may be relative and is resolved against `baseUrl`. */
export interface SitemapEntry {
  /** URL or path of the target page; joined with `baseUrl` unless absolute. */
  loc: string;
  /** W3C datetime (or date) of the last modification, passed through verbatim. */
  lastmod?: string;
  /** How often the page is expected to change. */
  changefreq?: ChangeFreq;
  /** Relative priority in `[0, 1]`, rendered as a bare number. */
  priority?: number;
}

/** Options for {@link buildSitemap}. */
export interface BuildSitemapOptions {
  /** Origin the relative `loc`s are resolved against, e.g. `https://noema.app`. */
  baseUrl: string;
}

/** Options for {@link paginateSitemap}. */
export interface PaginateSitemapOptions {
  /** Maximum entries per page. Defaults to {@link SITEMAP_LIMIT}. */
  max?: number;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const URLSET_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

/**
 * Escape the five characters that change XML parsing: `& < > " '`. The
 * ampersand is replaced first so the entities introduced by the later passes
 * are not re-escaped. An already-escaped entity is escaped again on purpose —
 * this treats its input as plain text, not markup.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Join a base origin with a path, producing a canonical URL.
 *
 * Trailing slashes are stripped from `base` and leading slashes from `path`
 * (so a single `/` always separates the two), while a trailing slash on the
 * `path` is preserved. An empty path collapses to `base`, a bare `/` collapses
 * to the root with a trailing slash, and query strings / fragments pass
 * through. A `path` that is already an absolute URL (has a `scheme://`) is
 * returned untouched, so rows stored with absolute links are never mangled.
 */
export function normalizeUrl(base: string, path: string): string {
  const origin = base.trim().replace(/\/+$/, "");
  const target = path.trim();
  if (target === "") return origin;
  if (ABSOLUTE_URL.test(target)) return target;
  return `${origin}/${target.replace(/^\/+/, "")}`;
}

const isChangeFreq = (value: string): value is ChangeFreq =>
  (CHANGEFREQ as readonly string[]).includes(value);

/**
 * Validate a single entry, throwing on a priority outside `[0, 1]` / non-finite
 * or a `changefreq` outside the protocol enum. `loc` is only required to be a
 * string; an empty loc still resolves to `baseUrl`.
 */
function assertValid(entry: SitemapEntry): void {
  const { priority, changefreq, loc } = entry;
  if (priority !== undefined && (!Number.isFinite(priority) || priority < 0 || priority > 1)) {
    throw new RangeError(`sitemap: priority for "${loc}" must be a finite number in [0, 1]`);
  }
  if (changefreq !== undefined && !isChangeFreq(changefreq)) {
    throw new RangeError(
      `sitemap: changefreq for "${loc}" must be one of ${CHANGEFREQ.join(", ")}`,
    );
  }
}

/**
 * Serialise entries into a sitemap.org `<urlset>` document.
 *
 * Relative `loc`s are resolved against `options.baseUrl` and escaped; each
 * optional child is emitted only when present, in `loc`, `lastmod`,
 * `changefreq`, `priority` order. Entry order is preserved and the document is
 * deterministic — LF line endings, a trailing newline, and no clock reads.
 */
export function buildSitemap(
  entries: readonly SitemapEntry[],
  options: BuildSitemapOptions,
): string {
  const lines: string[] = [XML_DECL, `<urlset xmlns="${URLSET_NS}">`];

  for (const entry of entries) {
    assertValid(entry);
    lines.push("<url>");
    lines.push(`<loc>${escapeXml(normalizeUrl(options.baseUrl, entry.loc))}</loc>`);
    if (entry.lastmod !== undefined) lines.push(`<lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    if (entry.changefreq !== undefined) lines.push(`<changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined) lines.push(`<priority>${String(entry.priority)}</priority>`);
    lines.push("</url>");
  }

  lines.push("</urlset>");
  return `${lines.join("\n")}\n`;
}

/**
 * Split an ordered entry list into pages of at most `max` entries, the shape a
 * caller fans out into one `<urlset>` per file plus a `<sitemapindex>` that
 * points at each. Order is preserved, an exact multiple never yields a trailing
 * empty page, and an empty list yields no pages. `max` must be a positive
 * integer.
 */
export function paginateSitemap<T>(
  entries: readonly T[],
  options: PaginateSitemapOptions = {},
): T[][] {
  const max = options.max ?? SITEMAP_LIMIT;
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError("sitemap: max must be a positive integer");
  }

  const pages: T[][] = [];
  for (let start = 0; start < entries.length; start += max) {
    pages.push(entries.slice(start, start + max));
  }
  return pages;
}
