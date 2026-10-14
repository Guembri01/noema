/**
 * B96 — "Copy block link" / deep links (docs/MISSING_FEATURES.md §1, row 131).
 *
 * The page route in `src/app/` is `/w/[slug]/[pageId]`, so the canonical page
 * path is `/w/<workspaceSlug>/<pageId>`. Passing no `workspaceSlug` yields the
 * shorter workspace-relative form `/w/<pageId>` (correct prefix, used where the
 * slug is already in context). A block is addressed by the `#<blockId>`
 * fragment, replacing the old unstable `#block-<pos>` anchor
 * (`block-context-menu.tsx`) as stable block ids land.
 *
 * Pure string work only: build a link, parse one back (tolerating absolute URLs
 * from any origin, query strings and trailing slashes while rejecting foreign
 * page-path prefixes), and derive unicode-aware anchor slugs with `-1`/`-2`
 * dedupe. No DOM, no routes, no DB.
 */

/**
 * Canonical page-path prefix, learned from `src/app/w/[slug]/[pageId]`. Only
 * links whose path starts with this segment parse; `/p/…`, `/page/…` and every
 * other prefix are foreign.
 */
export const PAGE_ROUTE_PREFIX = "/w";

/** The single path segment that follows the leading slash of {@link PAGE_ROUTE_PREFIX}. */
const PREFIX_SEGMENT = PAGE_ROUTE_PREFIX.replace(/^\/+/, "");

export interface BlockDeepLinkOptions {
  /**
   * Absolute origin (e.g. `"https://noema.app"`). Omit for a site-relative
   * link. A trailing slash is ignored.
   */
  origin?: string;
  /**
   * Workspace slug for the real `/w/<slug>/<pageId>` route. Omit for the
   * workspace-relative `/w/<pageId>` short form.
   */
  workspaceSlug?: string;
}

/** A parsed deep link: the page id, plus the block id when the link had one. */
export type BlockDeepLinkParseResult =
  | { ok: true; pageId: string; blockId?: string }
  | { ok: false; error: string };

/** Percent-encode an id, trimming incidental whitespace first. */
function percentEncode(id: string): string {
  return encodeURIComponent(id.trim());
}

/**
 * Percent-decode, falling back to the raw text when the escape is malformed
 * (`"100%"` etc.) so callers never face a thrown `URIError`.
 */
function percentDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Trim, lowercase and (when it round-trips safely) percent-decode a page id so
 * links from any source compare reliably. A malformed percent escape is kept
 * verbatim rather than throwing.
 */
export function normalizePageId(id: string): string {
  return percentDecode(id.trim()).trim().toLowerCase();
}

/**
 * Build the deep link for a page (and optionally a block):
 *
 * - no `blockId` → the page path alone (`/w/acme/page-1`);
 * - with `blockId` → the page path plus the `#<blockId>` fragment;
 * - `opts.origin` → an absolute URL from that origin;
 * - `opts.workspaceSlug` → the full `/w/<slug>/<pageId>` route.
 *
 * Ids are percent-encoded; an empty/whitespace block id means "no anchor".
 */
export function buildBlockDeepLink(
  pageId: string,
  blockId?: string,
  opts: BlockDeepLinkOptions = {},
): string {
  const segments = [PREFIX_SEGMENT];
  if (opts.workspaceSlug !== undefined && opts.workspaceSlug.trim() !== "") {
    segments.push(percentEncode(opts.workspaceSlug));
  }
  segments.push(percentEncode(pageId));

  let link = `/${segments.join("/")}`;
  if (blockId !== undefined && blockId.trim() !== "") {
    link += `#${percentEncode(blockId)}`;
  }

  const origin = opts.origin?.trim().replace(/\/+$/, "");
  return origin ? `${origin}${link}` : link;
}

/**
 * Reduce a link to its path portion, accepting site-relative (`/w/…`),
 * protocol-relative (`//host/w/…`) and absolute (`https://host/w/…`) forms.
 * Returns `null` for non-http-ish schemes (`mailto:`, …) that can never be a
 * page path.
 */
function pathOf(value: string): string | null {
  if (value === "") return "/";

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(value);
  if (scheme) {
    const afterAuthority = value.slice(scheme[0].length);
    const slash = afterAuthority.indexOf("/");
    return slash === -1 ? "/" : afterAuthority.slice(slash);
  }

  if (value.startsWith("//")) {
    const slash = value.indexOf("/", 2);
    return slash === -1 ? "/" : value.slice(slash);
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;

  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * Parse a block/page deep link back into `{ pageId, blockId? }`.
 *
 * Tolerates absolute URLs of any origin, query strings and trailing slashes,
 * and percent-decodes the ids. Rejects links whose path does not start with
 * {@link PAGE_ROUTE_PREFIX}, links with no page id, and malformed/empty hashes.
 */
export function parseBlockDeepLink(link: string): BlockDeepLinkParseResult {
  const input = typeof link === "string" ? link.trim() : "";
  if (input === "") return { ok: false, error: "empty link" };

  // The fragment comes first: a "#" also terminates the path and any query.
  let rest = input;
  let hash: string | null = null;
  const hashIndex = rest.indexOf("#");
  if (hashIndex !== -1) {
    hash = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  const queryIndex = rest.indexOf("?");
  if (queryIndex !== -1) rest = rest.slice(0, queryIndex);

  const path = pathOf(rest);
  if (path === null) return { ok: false, error: "not a page link" };

  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments[0] !== PREFIX_SEGMENT) {
    return { ok: false, error: "not a Noema page link" };
  }
  if (segments.length < 2) return { ok: false, error: "missing page id" };

  const pageId = percentDecode(segments[segments.length - 1]).trim();
  if (pageId === "") return { ok: false, error: "missing page id" };

  if (hash === null) return { ok: true, pageId };

  const blockId = percentDecode(hash).trim();
  if (blockId === "") return { ok: false, error: "malformed hash" };
  return { ok: true, pageId, blockId };
}

/**
 * Whether two links point at the same page. Origin, workspace slug and block
 * anchor are irrelevant; unparseable links are never "the same" as anything.
 */
export function isSamePageLink(a: string, b: string): boolean {
  const left = parseBlockDeepLink(a);
  const right = parseBlockDeepLink(b);
  if (!left.ok || !right.ok) return false;
  return normalizePageId(left.pageId) === normalizePageId(right.pageId);
}

/**
 * Unicode-aware anchor slug: lowercase, trim, collapse every run of
 * non-letter/non-digit characters (whitespace, punctuation, emoji) into a
 * single hyphen, then trim the edges. Unicode letters/digits and internal
 * hyphens survive. Text with no slug-shaped characters yields `""` — unlike
 * `toc.ts`'s fallback this returns the honest empty string so callers can
 * decide whether to mint a dedupe suffix or skip the anchor.
 */
export function buildAnchorSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Collision-free slug against a caller-owned `seen` set: on a collision append
 * the `-1`, `-2`, … suffix chain, skipping suffixes already claimed, and
 * register the result back into `seen`. Pass one set across a document so every
 * anchor stays unique.
 */
export function slugWithDedup(slug: string, seen: Set<string>): string {
  let candidate = slug;
  for (let suffix = 1; seen.has(candidate); suffix += 1) {
    candidate = `${slug}-${suffix}`;
  }
  seen.add(candidate);
  return candidate;
}
