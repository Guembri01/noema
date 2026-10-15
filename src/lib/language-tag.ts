/**
 * BCP-47 language tags.
 *
 * Every place the app reasons about a user's language — an `Accept-Language`
 * header, a workspace default, an account preference — hands us a tag that may
 * be differently cased, reordered, or deprecated (`EN-us`, `sl-rozaj-biske`,
 * `iw`). Rather than scatter ad-hoc string handling, this module funnels all of
 * it through the platform's canonicalisation (`Intl.getCanonicalLocales`) and
 * exposes a small, pure, DB-free surface:
 *
 *  - `parseLanguageTag`      — break a tag into `{ language, script?, region?, variants[] }`
 *  - `isValidLanguageTag`    — does it parse at all?
 *  - `normalizeLanguageTag`  — the canonical spelling, or `null`
 *  - `matchLanguage`         — pick the best available locale for a preference list
 *  - `SUPPORTED_LOCALES`     — the tags this app claims to serve
 *
 * The platform is the source of truth for what counts as a valid tag, so
 * validation, canonical casing, subtag ordering, and deprecated-subtag rewrites
 * (`iw` → `he`) all agree with `Intl` by construction. Extension subtags
 * (`-u-ca-gregory`) and private-use subtags (`-x-foo`) are accepted but not
 * surfaced — they are irrelevant to locale selection.
 */

/** A language tag split into its core subtags. `variants` is never undefined. */
export type LanguageTag = {
  /** ISO 639 language subtag, lowercased (`en`, `zh`, `sr`). */
  language: string;
  /** ISO 15924 script subtag, title-cased (`Latn`, `Hant`), when present. */
  script?: string;
  /** ISO 3166 region or UN M.49 area, canonical case (`US`, `TW`, `419`). */
  region?: string;
  /** Variant subtags in canonical order, e.g. `["1994", "biske", "rozaj"]`. */
  variants: string[];
};

/**
 * The tags the app ships UI for, in preference order. Kept explicit and
 * literal so it can drive a type (`SupportedLocale`) as well as runtime
 * matching; `matchLanguage` treats it like any other availability list.
 */
export const SUPPORTED_LOCALES = [
  "en",
  "en-US",
  "en-GB",
  "fr",
  "fr-FR",
  "es",
  "es-ES",
  "de",
  "de-DE",
  "pt",
  "pt-BR",
  "ar",
  "ja",
  "zh-Hans",
  "zh-Hant",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** RFC 5646 script subtag: exactly four ASCII letters. */
const SCRIPT_SUBTAG = /^[A-Za-z]{4}$/;

/** RFC 5646 region subtag: two letters (ISO 3166) or three digits (UN M.49). */
const REGION_SUBTAG = /^([A-Za-z]{2}|\d{3})$/;

/**
 * Canonicalise a single tag through the platform, collapsing the `RangeError`
 * for malformed input into `null`. This is the only place the module touches
 * `Intl`, so every other function inherits identical validation semantics.
 */
function canonicalize(tag: string): string | null {
  if (typeof tag !== "string" || tag === "") return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    return canonical ?? null;
  } catch {
    return null;
  }
}

/** True when `subtag` is an RFC 5646 variant (5-8 alphanumeric, or digit + 3). */
function isVariantSubtag(subtag: string): boolean {
  return /^[A-Za-z0-9]{5,8}$/.test(subtag) || /^\d[A-Za-z0-9]{3}$/.test(subtag);
}

/** True when the tag is a structurally valid BCP-47 language tag. */
export function isValidLanguageTag(tag: string): boolean {
  return canonicalize(tag) !== null;
}

/**
 * The canonical spelling of `tag`, or `null` when it is malformed. Canonical
 * form implies the platform's casing and subtag order, so `sl-rozaj-biske`
 * normalises to `sl-biske-rozaj` and `EN-us` to `en-US`.
 */
export function normalizeLanguageTag(tag: string): string | null {
  return canonicalize(tag);
}

/**
 * Split a tag into its core subtags, or `null` when it is malformed.
 *
 * Parsing runs on the canonical form, so callers get canonical casing and
 * ordering for free. The grammar consumed is `language [script] [region]
 * variant*`; anything after the first singleton subtag (an extension or
 * private-use block) is ignored.
 */
export function parseLanguageTag(tag: string): LanguageTag | null {
  const canonical = canonicalize(tag);
  if (canonical === null) return null;

  const subtags = canonical.split("-");
  const language = subtags[0];
  let index = 1;
  let script: string | undefined;
  let region: string | undefined;

  if (index < subtags.length && SCRIPT_SUBTAG.test(subtags[index])) {
    script = subtags[index];
    index += 1;
  }
  if (index < subtags.length && REGION_SUBTAG.test(subtags[index])) {
    region = subtags[index];
    index += 1;
  }

  const variants: string[] = [];
  while (index < subtags.length && isVariantSubtag(subtags[index])) {
    variants.push(subtags[index]);
    index += 1;
  }

  const parsed: LanguageTag = { language, variants };
  if (script !== undefined) parsed.script = script;
  if (region !== undefined) parsed.region = region;
  return parsed;
}

/**
 * Choose the available tag that best satisfies an ordered preference list.
 *
 * Lookup follows RFC 4647-style matching, from most to least specific, and
 * stops at the first preference that produces a hit:
 *
 *  1. an exact canonical match (`en-GB` → `en-GB`);
 *  2. same language *and* region (`en-GB` → `en-GB`, not `en-US`);
 *  3. same language, ignoring region (`en-GB` → `en-US`).
 *
 * The returned value is the canonical form of the matched *available* entry,
 * and `null` means no preference could be satisfied. Invalid entries on either
 * side are skipped rather than treated as matches.
 */
export function matchLanguage(
  preferred: readonly string[],
  available: readonly string[],
): string | null {
  const candidates: Array<{ tag: string; parts: LanguageTag }> = [];
  for (const entry of available) {
    const tag = canonicalize(entry);
    const parts = tag === null ? null : parseLanguageTag(tag);
    if (tag !== null && parts !== null) candidates.push({ tag, parts });
  }

  for (const entry of preferred) {
    const tag = canonicalize(entry);
    const parts = tag === null ? null : parseLanguageTag(tag);
    if (tag === null || parts === null) continue;

    const exact = candidates.find((candidate) => candidate.tag === tag);
    if (exact) return exact.tag;

    if (parts.region !== undefined) {
      const sameRegion = candidates.find(
        (candidate) =>
          candidate.parts.language === parts.language &&
          candidate.parts.region === parts.region,
      );
      if (sameRegion) return sameRegion.tag;
    }

    const sameLanguage = candidates.find(
      (candidate) => candidate.parts.language === parts.language,
    );
    if (sameLanguage) return sameLanguage.tag;
  }

  return null;
}
