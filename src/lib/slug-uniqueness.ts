/**
 * Unique slug allocation: the pure engine that turns a desired name into a
 * free, URL-safe slug.
 *
 * Workspaces, pages and databases all expose a human-readable `slug`, and a
 * user may type the same name twice. This module resolves that collision
 * deterministically: the first free candidate wins, then `base-1`, `base-2`, …
 * It never touches the DB, React or the clock, and reuses `slugify` from
 * `@/lib/slug` so a returned slug is always shaped exactly like a stored one.
 *
 * Design choices:
 *
 * - Comparison is case-insensitive and trims surrounding whitespace, so
 *   `"Post"`, `"post "` and `"POST"` are the same slug.
 * - The first *free* suffix is used (`post`, taken `post-2` → `post-1`), not
 *   `taken.size + 1`, so a deleted slug is re-usable while duplicates stay
 *   minimal.
 * - A small set of route words (`new`, `settings`, …) can never be handed out,
 *   because a workspace slug doubles as a `/<slug>` path segment. Callers may
 *   add more via `reserved`.
 * - An empty or punctuation-only base falls back to `slugify`'s `"workspace"`,
 *   which is deliberately *not* reserved so the fallback stays predictable.
 * - `reserveSlug` returns a *new* set (the input is never mutated), letting a
 *   caller build a `taken` collection functionally.
 */

import { slugify } from "@/lib/slug";

/** Route words that must never be handed out as a slug. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "help",
  "home",
  "inbox",
  "library",
  "login",
  "logout",
  "new",
  "search",
  "settings",
  "signup",
  "static",
  "templates",
  "trash",
]);

/** A collection of slugs, as either a `Set<string>` or a `string[]`. */
export type SlugTaken = Iterable<string>;

/** Extra options shared by the allocation helpers. */
export type UniqueSlugOptions = {
  /** Additional slugs to treat as taken, on top of the built-in route words. */
  reserved?: SlugTaken;
};

/** Normalise a slug for case-insensitive comparison; non-strings become "". */
function normalizeEntry(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Merge any number of slug collections into one normalised lookup set. */
function toEntrySet(...sources: (SlugTaken | undefined)[]): Set<string> {
  const used = new Set<string>();
  for (const source of sources) {
    if (source === undefined) continue;
    if (typeof source === "string") {
      const normalized = normalizeEntry(source);
      if (normalized) used.add(normalized);
      continue;
    }
    for (const entry of source) {
      const normalized = normalizeEntry(entry);
      if (normalized) used.add(normalized);
    }
  }
  return used;
}

/** The `index`-th candidate for `stem`: the stem itself, then `stem-1`, `stem-2`… */
function candidate(stem: string, index: number): string {
  return index === 0 ? stem : `${stem}-${index}`;
}

/** First candidate for `stem` that is not already in `used` (finite and safe). */
function firstFree(stem: string, used: Set<string>): string {
  for (let index = 0; ; index += 1) {
    const slug = candidate(stem, index);
    if (!used.has(slug.toLowerCase())) return slug;
  }
}

/** Slugify a (possibly mistyped) base, falling back to the slugify default. */
function stemOf(base: string): string {
  return slugify(typeof base === "string" ? base : "");
}

/**
 * A free, URL-safe slug for `base`.
 *
 * The base is run through `slugify`, then the first candidate not present in
 * `taken`, the built-in `RESERVED_SLUGS` or the extra `options.reserved` is
 * returned — `base`, then `base-1`, `base-2`, … Comparison is case-insensitive.
 * An empty or punctuation-only base becomes `"workspace"`.
 */
export function uniqueSlug(
  base: string,
  taken: SlugTaken = [],
  options: UniqueSlugOptions = {},
): string {
  const used = toEntrySet(RESERVED_SLUGS, options.reserved, taken);
  return firstFree(stemOf(base), used);
}

/**
 * Allocate a unique slug for every base in `bases`, in order.
 *
 * Each allocated slug is added to the working set, so identical bases within
 * one batch never collide (`["post", "post"]` → `["post", "post-1"]`) and the
 * result is also free of `taken`, `RESERVED_SLUGS` and `options.reserved`.
 */
export function allocateSlugs(
  bases: SlugTaken,
  taken: SlugTaken = [],
  options: UniqueSlugOptions = {},
): string[] {
  const used = toEntrySet(RESERVED_SLUGS, options.reserved, taken);
  const allocated: string[] = [];
  const list: Iterable<string> = typeof bases === "string" ? [bases] : bases;
  for (const base of list) {
    const slug = firstFree(stemOf(base), used);
    used.add(slug.toLowerCase());
    allocated.push(slug);
  }
  return allocated;
}

/**
 * Claim `slug`, returning a new set of taken slugs — a copy of `taken` plus the
 * normalised `slug`. Idempotent, never mutates `taken`, and the result can be
 * fed straight back into `uniqueSlug`/`allocateSlugs`.
 *
 * @throws Error when `slug` is empty or whitespace-only.
 */
export function reserveSlug(slug: string, taken: SlugTaken = []): Set<string> {
  const normalized = normalizeEntry(slug);
  if (!normalized) {
    throw new Error("Cannot reserve an empty slug.");
  }
  const used = toEntrySet(taken);
  used.add(normalized);
  return used;
}
