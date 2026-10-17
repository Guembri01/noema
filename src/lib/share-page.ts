import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
  parseCoverPosition,
  type CoverPosition,
} from "@/lib/cover-position";
import { GRADIENTS, coverCss, type GradientId } from "@/lib/page-cover";

/**
 * The public share-page model.
 *
 * These are the pure decisions `src/app/s/[token]/page.tsx` makes: whether a
 * link is still available, whether a document embeds a database (and so wants
 * the wide reading measure), and how a stored cover becomes a banner. They are
 * DOM-free and DB-free so the server component, the share dialog and the tests
 * can all share one implementation.
 *
 * They used to live in `src/components/share-dialog.tsx`, next to the dialog
 * that also uses them. That module is `"use client"`, so every non-component
 * export becomes a *client reference*: the server component imported the
 * functions, Next resolved them to a proxy, and calling one threw
 * "Attempted to call … from the server but … is on the client". The public page
 * — the whole point of a share link — 500'd for anonymous visitors, and no unit
 * test could see it because the functions themselves were correct.
 *
 * A module boundary is the fix: a client module may be *rendered* from a server
 * component, but a plain function must come from a module without the directive.
 */

/** Reading measure for a prose page (§3: comfortable measure). */
export const PROSE_MEASURE = "max-w-[720px]";
/** Reading measure for a page containing databases — wide enough for tables. */
export const WIDE_MEASURE = "max-w-[1100px]";

/** The wrapper width for a page, widened when it embeds a database. */
export function readingMeasure(hasDatabase: boolean): string {
  return hasDatabase ? WIDE_MEASURE : PROSE_MEASURE;
}

/** Doc node types that make a page "contain a database". */
const DATABASE_NODE_TYPES: ReadonlySet<string> = new Set([
  "linkedDatabase",
  "database",
  "inlineDatabase",
  "inline_database",
  "databaseView",
]);

/**
 * Whether a stored document embeds a database block. Walks the ProseMirror tree
 * generically (unknown shapes are ignored) and is cycle-safe, so malformed or
 * hostile content reads as "no database" rather than hanging.
 */
export function documentHasDatabase(content: unknown): boolean {
  const root =
    content && typeof content === "object" ? (content as { content?: unknown }) : null;
  const stack: unknown[] = Array.isArray(root?.content) ? [...root.content] : [];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const record = node as { type?: unknown; content?: unknown };
    if (typeof record.type === "string" && DATABASE_NODE_TYPES.has(record.type)) return true;
    if (Array.isArray(record.content)) {
      for (const child of record.content) stack.push(child);
    }
  }
  return false;
}

/** A page wants the wide measure when it is a database or embeds one. */
export function usesWideMeasure(page: {
  type?: string | null;
  content?: unknown;
}): boolean {
  return page.type === "DATABASE" || documentHasDatabase(page.content);
}

/** Coerce a Date or ISO string to epoch millis, or `null` when unusable. */
function toEpoch(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Whether a shared page should show the "no longer available" state: a missing
 * link, a soft-deleted page, or a link whose expiry has passed. The expiry
 * instant itself counts as expired (matching the guest-grant engine), and a
 * corrupt/absent expiry never hides a live page.
 */
export function isSharedPageUnavailable(
  link: { expiresAt?: Date | string | null } | null | undefined,
  page: { deletedAt?: Date | string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!link || !page) return true;
  if (page.deletedAt) return true;
  const expiresAt = toEpoch(link.expiresAt);
  return expiresAt !== null && expiresAt <= now.getTime();
}

/**
 * The title a share link shows while the page behind it may not be disclosed.
 */
export const GENERIC_SHARED_TITLE = "Shared page";

/**
 * The title a share link may disclose.
 *
 * A page's title is content, so it may only leave the server once the reader
 * is allowed to see the page: the link must still be available (not deleted,
 * not expired) and a password-protected link must be unlocked — the same state
 * check the page body makes. Everything else gets the generic title, so
 * neither the `<title>` tag nor the Open Graph metadata names a page that is
 * still locked (B36).
 */
export function sharedPageTitle(
  link:
    | { passwordHash?: string | null; expiresAt?: Date | string | null }
    | null
    | undefined,
  page: { title?: string | null; deletedAt?: Date | string | null } | null | undefined,
  options: { unlocked?: boolean } = {},
): string {
  if (!link || !page) return GENERIC_SHARED_TITLE;
  if (isSharedPageUnavailable(link, page)) return GENERIC_SHARED_TITLE;
  if (link.passwordHash && !options.unlocked) return GENERIC_SHARED_TITLE;
  return page.title || GENERIC_SHARED_TITLE;
}

/** Renderable banner: the `background-image` plus its focal point. */
export type CoverBanner = { backgroundImage: string; backgroundPosition: string };

/** Reverse lookup `coverCss` output → gradient preset id (mirrors the editor). */
const GRADIENT_ID_BY_CSS: ReadonlyMap<string, GradientId> = new Map(
  (Object.keys(GRADIENTS) as GradientId[]).map((id) => [GRADIENTS[id], id] as const),
);

/**
 * Split a stored cover string into its CSS value and the focal point encoded
 * after it (`"<css> <x>% <y>%"`). A cover without a position decodes centred.
 */
function splitStoredCover(raw: string): { css: string; position: CoverPosition } {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/**
 * Decode a persisted cover into a safe banner, or `null` for an absent or
 * unrecognised value. Gradients match the catalog by CSS value; an image URL is
 * re-validated through `coverCss`, so a hostile string never becomes a banner.
 * The stored position is threaded into `background-position`.
 */
export function coverBannerStyle(raw: string | null | undefined): CoverBanner | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const { css, position } = splitStoredCover(raw.trim());
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) {
    return {
      backgroundImage: coverCss({ type: "gradient", gradientId }),
      backgroundPosition: formatObjectPosition(position),
    };
  }
  // Accept both a bare URL and the `url("…")` form the cover encoder writes,
  // then re-validate the URL through `coverCss` so nothing unsafe paints.
  const wrapped = css.match(/^url\(\s*"([^"]*)"\s*\)$/);
  const backgroundImage = coverCss({ type: "image", url: wrapped ? wrapped[1] : css });
  if (backgroundImage === "") return null;
  return {
    backgroundImage,
    backgroundPosition: formatObjectPosition(position),
  };
}
