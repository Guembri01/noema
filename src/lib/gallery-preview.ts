/**
 * Gallery card preview resolution
 * (docs/specs/database-deep.md R89.9, §3 "Gallery previews").
 *
 * A database gallery view stores a `PreviewConfig` per view: which property
 * supplies the card cover, which property (or the page body) supplies the text
 * excerpt, how the image fits its box, and which properties render as small
 * "badges" under the card. This module owns the whole pure decision:
 *
 * - `parsePreviewConfig` performs a strict structural parse of untrusted stored
 *   JSON so an editor can surface a real error.
 * - `resolveCardPreview` turns a row + config + schema into what a card actually
 *   renders (`{ cover?, excerpt?, badges }`), choosing the first cover-eligible
 *   (FILES/MEDIA/URL, case-insensitive) property when no cover is configured and
 *   clipping the excerpt to 256 characters on a word boundary.
 * - `validatePreviewConfig` reports one structured issue per problem (unknown
 *   or ineligible property, bad fit/aspect) instead of a bare boolean.
 * - `describePreview` renders a one-line summary for menus and tooltips.
 *
 * Design rules (same contract as `ai-autofill.ts` / `view-presets.ts`):
 *
 * - **Strict parse, fail-safe resolve.** `parsePreviewConfig` returns `ok:false`
 *   for malformed JSON or a wrong-typed field; everything else coerces an
 *   unreadable config back to the documented defaults and never throws — stored
 *   config round-trips through the DB as untrusted JSON.
 * - **URL safety.** A cover is only ever an absolute `http:`/`https:` URL;
 *   `javascript:`, `data:`, `ftp:` and relative/blank values are dropped rather
 *   than rendered into an `<img src>`.
 * - **Pure.** Neither the row nor its values are mutated.
 *
 * No DB, no routes, no React: a gallery toolbar or a linked-database block can
 * render a card with these functions and nothing else. The row/property shapes
 * are structural (see `GalleryRowLike` / `GalleryPropertyLike`), so they line up
 * with the query engine's `QueryRow` / `QueryProperty` without importing them.
 */

/** How a cover image fills its box (CSS `object-fit`). */
export type PreviewFit = "cover" | "contain";

/** The supported cover fit values, in menu order. */
export const PREVIEW_FITS = ["cover", "contain"] as const;

/** Property types whose value can act as a card cover image. */
export const COVER_IMAGE_PROPERTY_TYPES = ["files", "media", "url"] as const;

/**
 * Property types never rendered as a card badge: media types are the cover and
 * the title is the card heading, so neither belongs in the badge strip.
 */
export const BADGE_EXCLUDED_PROPERTY_TYPES = ["files", "media", "title"] as const;

/** How many characters of page content a card excerpt keeps before clipping. */
export const DEFAULT_PREVIEW_MAX_CHARS = 256;

/** The persisted gallery preview configuration (`View.config`). */
export type PreviewConfig = {
  /** Property holding the card cover; resolved automatically when unset. */
  coverPropertyId?: string;
  /** Property whose text becomes the excerpt; falls back to the page content. */
  contentPropertyId?: string;
  /** How the cover image fits its box. */
  fit: PreviewFit;
  /** Optional CSS `aspect-ratio` value (width ÷ height) for the cover box. */
  aspect?: number;
  /** Whether the card shows the row title. Defaults to `true`. */
  showTitle?: boolean;
  /** Property ids to render as badges, in order; all eligible when unset. */
  showProperties?: string[];
};

/** A loose config as authored by the UI; every field is optional. */
export type PreviewConfigInput = Partial<PreviewConfig>;

/** The result of a strict structural parse. */
export type PreviewParseResult =
  | { ok: true; config: PreviewConfig }
  | { ok: false; error: string };

/** A property definition as the preview needs it (id + optional type). */
export type GalleryPropertyLike = {
  id: string;
  name?: string;
  /** Property type, e.g. `"FILES"`, `"select"`. Compared case-insensitively. */
  type?: string;
};

/** One `propertyId → value` pair, the shape the query engine stores. */
export type GalleryValueLike = { propertyId: string; value: unknown };

/** A database row, reduced to what a gallery card renders. */
export type GalleryRowLike = {
  id?: string;
  title?: string;
  icon?: string | null;
  /** Page body plain text, used for the excerpt when no property is set. */
  content?: string | null;
  propertyValues?: readonly GalleryValueLike[];
};

/** The resolved cover of a card. */
export type CardCover = {
  url: string;
  fit: PreviewFit;
  /** Present only when the config set one. */
  aspect?: number;
};

/** The resolved text excerpt of a card. */
export type CardExcerpt = { text: string; truncated: boolean };

/** One resolved badge: the property and its rendered value. */
export type CardBadge = { propertyId: string; value: string };

/** Everything a gallery card renders. */
export type ResolvedCardPreview = {
  cover?: CardCover;
  excerpt?: CardExcerpt;
  badges: CardBadge[];
};

/** Options for `resolveCardPreview`: the database schema the row belongs to. */
export type ResolveCardPreviewOptions = {
  properties?: readonly GalleryPropertyLike[];
};

/** Options for `validatePreviewConfig`: the database schema. */
export type ValidatePreviewOptions = {
  properties?: readonly GalleryPropertyLike[];
};

/** Options for `excerpt`. */
export type ExcerptOptions = { maxChars?: number };

/** A problem `validatePreviewConfig` can report. */
export type PreviewIssueCode =
  | "INVALID_CONFIG"
  | "INVALID_FIT"
  | "INVALID_ASPECT"
  | "UNKNOWN_COVER_PROPERTY"
  | "COVER_NOT_MEDIA"
  | "UNKNOWN_CONTENT_PROPERTY"
  | "UNKNOWN_SHOW_PROPERTY";

/** One problem with a gallery preview configuration. */
export type PreviewIssue = { code: PreviewIssueCode; message: string };

const COVER_MEDIA_TYPES: ReadonlySet<string> = new Set(COVER_IMAGE_PROPERTY_TYPES);
const BADGE_EXCLUDED_TYPES: ReadonlySet<string> = new Set(BADGE_EXCLUDED_PROPERTY_TYPES);

const INVALID_CONFIG_ISSUE: PreviewIssue = {
  code: "INVALID_CONFIG",
  message: "Gallery preview config must be an object.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a config source: a JSON string is decoded (falling back to `null` when
 * malformed), anything else is passed through unchanged. Never throws.
 */
function toSource(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Trim a value to a non-empty string, or `undefined` when it is not one. */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Upper-cased property type, or `""` when absent/unreadable. */
function normalizeType(type: unknown): string {
  return typeof type === "string" ? type.trim().toLowerCase() : "";
}

/** Normalise a fit, defaulting to `"cover"` for anything unrecognised. */
function normalizeFit(value: unknown): PreviewFit {
  return value === "contain" ? "contain" : "cover";
}

/** Trim, drop blank entries and de-duplicate an id list. */
function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = readString(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Coerce an untrusted config into the canonical `PreviewConfig`. Accepts an
 * already-normalised object or a raw `View.config`; a malformed source, a blank
 * id or an invalid aspect/fit falls back to the documented default rather than
 * throwing. Idempotent and never throws.
 */
function normalizeConfig(raw: unknown): PreviewConfig {
  const source = toSource(raw);
  const record = isRecord(source) ? source : {};

  const config: PreviewConfig = { fit: normalizeFit(record.fit) };

  const cover = readString(record.coverPropertyId);
  if (cover) config.coverPropertyId = cover;

  const content = readString(record.contentPropertyId);
  if (content) config.contentPropertyId = content;

  const aspect = record.aspect;
  if (typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0) {
    config.aspect = aspect;
  }

  if (typeof record.showTitle === "boolean") config.showTitle = record.showTitle;

  const showProperties = readStringList(record.showProperties);
  if (showProperties.length > 0) config.showProperties = showProperties;

  return config;
}

/**
 * Parse a raw config into the canonical shape, reporting structural problems.
 * Accepts an object or a JSON string; a missing `fit` becomes `"cover"`, blank
 * ids are dropped and duplicate badge ids collapse. Wrong-typed fields and
 * malformed JSON return `ok: false` with a message (never a throw).
 */
export function parsePreviewConfig(raw: unknown): PreviewParseResult {
  const source = toSource(raw);
  if (!isRecord(source)) {
    return {
      ok: false,
      error:
        typeof raw === "string"
          ? "Gallery preview config is not valid JSON."
          : "Gallery preview config must be an object.",
    };
  }

  for (const key of ["coverPropertyId", "contentPropertyId"] as const) {
    const value = source[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return { ok: false, error: `${key} must be a string.` };
    }
  }

  const fit = source.fit;
  if (fit !== undefined && fit !== null && fit !== "cover" && fit !== "contain") {
    return { ok: false, error: 'fit must be "cover" or "contain".' };
  }

  const aspect = source.aspect;
  if (aspect !== undefined && aspect !== null) {
    if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0) {
      return { ok: false, error: "aspect must be a positive number." };
    }
  }

  const showTitle = source.showTitle;
  if (showTitle !== undefined && showTitle !== null && typeof showTitle !== "boolean") {
    return { ok: false, error: "showTitle must be a boolean." };
  }

  const showProperties = source.showProperties;
  if (showProperties !== undefined && showProperties !== null) {
    if (!Array.isArray(showProperties) || showProperties.some((e) => typeof e !== "string")) {
      return { ok: false, error: "showProperties must be an array of strings." };
    }
  }

  return { ok: true, config: normalizeConfig(source) };
}

/** Read a row's raw value for `propertyId` (first match wins). */
function readPropertyValue(
  row: GalleryRowLike | null | undefined,
  propertyId: string,
): unknown {
  const values = row?.propertyValues;
  if (!values) return undefined;
  for (const entry of values) {
    if (entry && entry.propertyId === propertyId) return entry.value;
  }
  return undefined;
}

/** Whether a property's type can supply a cover image (case-insensitive). */
function isCoverEligible(property: GalleryPropertyLike | undefined): boolean {
  return COVER_MEDIA_TYPES.has(normalizeType(property?.type));
}

/** Whether a property's type may render as a badge (title/media excluded). */
function isBadgeEligible(property: GalleryPropertyLike): boolean {
  return !BADGE_EXCLUDED_TYPES.has(normalizeType(property.type));
}

/**
 * The absolute `http:`/`https:` URL of a value, trimmed, or `undefined` for
 * blank strings, relative paths, other schemes (`data:`, `javascript:`, `ftp:`)
 * and malformed input. This is the URL-safety gate every cover passes through.
 */
function safeUrl(value: unknown): string | undefined {
  const trimmed = readString(value);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function firstHttpUrl(value: unknown): string | undefined {
  const direct = safeUrl(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstHttpUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (isRecord(value)) {
    const file = firstHttpUrl(value.files);
    if (file) return file;
    for (const key of ["url", "src", "href"] as const) {
      const url = safeUrl(value[key]);
      if (url) return url;
    }
  }
  return undefined;
}

/**
 * Pull the first usable cover image URL out of a property value: an absolute
 * `http:`/`https:` string, the first such URL in an array or a `{ files: [...] }`
 * value, or the `url`/`src`/`href` of an object. Relative and non-http(s) URLs
 * are skipped so a card never renders an unsafe `src`.
 */
export function extractFirstImage(propertyValue: unknown): string | undefined {
  return firstHttpUrl(propertyValue);
}

/** Clamp an excerpt limit to a usable, non-negative character count. */
function resolveMaxChars(value: number | null | undefined): number {
  if (value === undefined || value === null) return DEFAULT_PREVIEW_MAX_CHARS;
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return DEFAULT_PREVIEW_MAX_CHARS;
  return Math.max(0, Math.trunc(value));
}

/**
 * Clip plain text to `maxChars` (default 256) on a word boundary, collapsing
 * runs of whitespace first. Returns the clipped text and whether anything was
 * removed; text that already fits is returned unchanged with `truncated: false`.
 * Pure and never throws.
 */
export function excerpt(text: unknown, options: ExcerptOptions = {}): CardExcerpt {
  const maxChars = resolveMaxChars(options.maxChars);
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (normalized === "") return { text: "", truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  if (maxChars <= 0) return { text: "", truncated: true };
  const slice = normalized.slice(0, maxChars);
  const boundary = slice.lastIndexOf(" ");
  return { text: boundary > 0 ? slice.slice(0, boundary) : slice, truncated: true };
}

/** Render a raw cell value to a short badge string, or `undefined` when empty. */
function renderBadgeValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return readString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const rendered = renderBadgeValue(item);
      if (rendered) parts.push(rendered);
    }
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (isRecord(value)) {
    const direct =
      renderBadgeValue(value.text) ??
      renderBadgeValue(value.name) ??
      renderBadgeValue(value.optionId) ??
      renderBadgeValue(value.start) ??
      renderBadgeValue(value.checked) ??
      renderBadgeValue(value.number) ??
      renderBadgeValue(value.label) ??
      renderBadgeValue(value.url);
    if (direct) return direct;
    return (
      renderBadgeValue(value.names) ?? renderBadgeValue(value.optionIds) ?? undefined
    );
  }
  return undefined;
}

/**
 * The cover-eligible properties in the order they are tried: the configured
 * cover first (when it exists and is media), then the rest of the schema's
 * media properties. An unset or unusable cover therefore falls back to the
 * database's first cover-eligible property, matching today's behaviour.
 */
function coverOrder(
  coverPropertyId: string | undefined,
  properties: readonly GalleryPropertyLike[],
): GalleryPropertyLike[] {
  const eligible = properties.filter(isCoverEligible);
  if (!coverPropertyId) return eligible;
  const explicit = eligible.find((property) => property.id === coverPropertyId);
  if (!explicit) return eligible;
  return [explicit, ...eligible.filter((property) => property.id !== coverPropertyId)];
}

function resolveCover(
  row: GalleryRowLike | null | undefined,
  config: PreviewConfig,
  properties: readonly GalleryPropertyLike[],
): CardCover | undefined {
  for (const property of coverOrder(config.coverPropertyId, properties)) {
    const url = extractFirstImage(readPropertyValue(row, property.id));
    if (!url) continue;
    const cover: CardCover = { url, fit: config.fit };
    if (config.aspect !== undefined) cover.aspect = config.aspect;
    return cover;
  }
  return undefined;
}

function resolveExcerpt(
  row: GalleryRowLike | null | undefined,
  config: PreviewConfig,
): CardExcerpt | undefined {
  let text: string | undefined;
  if (config.contentPropertyId) {
    text = renderBadgeValue(readPropertyValue(row, config.contentPropertyId));
  }
  if (text === undefined && typeof row?.content === "string") text = row.content;
  if (text === undefined) return undefined;
  const result = excerpt(text);
  return result.text === "" ? undefined : result;
}

function resolveBadges(
  row: GalleryRowLike | null | undefined,
  config: PreviewConfig,
  properties: readonly GalleryPropertyLike[],
): CardBadge[] {
  const byId = new Map(properties.map((property) => [property.id, property]));
  const candidates = config.showProperties ?? properties.map((property) => property.id);
  const badges: CardBadge[] = [];
  const seen = new Set<string>();
  for (const propertyId of candidates) {
    if (seen.has(propertyId)) continue;
    if (propertyId === config.coverPropertyId || propertyId === config.contentPropertyId) {
      continue;
    }
    const property = byId.get(propertyId);
    if (!property || !isBadgeEligible(property)) continue;
    const value = renderBadgeValue(readPropertyValue(row, propertyId));
    if (value === undefined) continue;
    seen.add(propertyId);
    badges.push({ propertyId, value });
  }
  return badges;
}

/**
 * Resolve what a gallery card renders for a row under a config.
 *
 * - **Cover** — the configured cover property (when cover-eligible), otherwise
 *   the first cover-eligible property in schema order, followed by the next
 *   eligible image when the chosen one is blank. Only absolute `http:`/`https:`
 *   URLs are used.
 * - **Excerpt** — the configured content property's text, falling back to the
 *   page content, clipped to `DEFAULT_PREVIEW_MAX_CHARS` on a word boundary.
 * - **Badges** — the configured `showProperties` (schema order when unset),
 *   dropping media/title types, the cover/content properties and empty cells.
 *
 * Pure: neither the row nor its property values are mutated.
 */
export function resolveCardPreview(
  row: GalleryRowLike | null | undefined,
  config: PreviewConfigInput = {},
  options: ResolveCardPreviewOptions = {},
): ResolvedCardPreview {
  const normalized = normalizeConfig(config);
  const properties = options.properties ?? [];

  const result: ResolvedCardPreview = {
    badges: resolveBadges(row, normalized, properties),
  };

  const cover = resolveCover(row, normalized, properties);
  if (cover) result.cover = cover;

  const text = resolveExcerpt(row, normalized);
  if (text) result.excerpt = text;

  return result;
}

/**
 * Validate a gallery preview configuration, returning one issue per problem and
 * never throwing. Reads the raw input (object or JSON string) so an unreadable
 * config is reported rather than silently defaulted. Checks: the fit and aspect
 * are in range, the cover/content properties exist (and the cover is media) and
 * every `showProperties` id exists in the schema.
 */
export function validatePreviewConfig(
  config: unknown,
  options: ValidatePreviewOptions = {},
): PreviewIssue[] {
  const issues: PreviewIssue[] = [];
  try {
    const source = toSource(config);
    if (!isRecord(source)) {
      issues.push(INVALID_CONFIG_ISSUE);
      return issues;
    }

    const fit = source.fit;
    if (fit !== undefined && fit !== null && fit !== "cover" && fit !== "contain") {
      issues.push({ code: "INVALID_FIT", message: 'fit must be "cover" or "contain".' });
    }

    const aspect = source.aspect;
    if (
      aspect !== undefined &&
      aspect !== null &&
      (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0)
    ) {
      issues.push({
        code: "INVALID_ASPECT",
        message: "aspect must be a positive number.",
      });
    }

    const properties = options.properties ?? [];
    const byId = new Map(properties.map((property) => [property.id, property]));

    const cover = readString(source.coverPropertyId);
    if (cover) {
      const property = byId.get(cover);
      if (!property) {
        issues.push({
          code: "UNKNOWN_COVER_PROPERTY",
          message: `Unknown cover property "${cover}".`,
        });
      } else if (!isCoverEligible(property)) {
        issues.push({
          code: "COVER_NOT_MEDIA",
          message: `Cover property "${cover}" is not a files/media/url property.`,
        });
      }
    }

    const content = readString(source.contentPropertyId);
    if (content && !byId.has(content)) {
      issues.push({
        code: "UNKNOWN_CONTENT_PROPERTY",
        message: `Unknown content property "${content}".`,
      });
    }

    if (Array.isArray(source.showProperties)) {
      for (const entry of source.showProperties) {
        const id = readString(entry);
        if (!id || byId.has(id)) continue;
        issues.push({
          code: "UNKNOWN_SHOW_PROPERTY",
          message: `Unknown badge property "${id}".`,
        });
      }
    }
  } catch {
    // Fail-safe: exotic input must never break the caller.
    if (!issues.some((issue) => issue.code === "INVALID_CONFIG")) {
      issues.push(INVALID_CONFIG_ISSUE);
    }
  }
  return issues;
}

/**
 * A one-line, human-readable description of a gallery card preview, e.g.
 * `Gallery preview: cover "cover", content auto, fit contain, aspect 1.5, title
 * shown, badges status, owner`. Unreadable input falls back to the defaults and
 * never throws.
 */
export function describePreview(config: unknown): string {
  const normalized = normalizeConfig(config);

  const cover = normalized.coverPropertyId
    ? `"${normalized.coverPropertyId}"`
    : "auto";
  const content = normalized.contentPropertyId
    ? `"${normalized.contentPropertyId}"`
    : "auto";

  const parts = [`fit ${normalized.fit}`];
  if (normalized.aspect !== undefined) parts.push(`aspect ${normalized.aspect}`);
  parts.push(normalized.showTitle === false ? "title hidden" : "title shown");
  parts.push(
    normalized.showProperties && normalized.showProperties.length > 0
      ? `badges ${normalized.showProperties.join(", ")}`
      : "no badges",
  );

  return `Gallery preview: cover ${cover}, content ${content}, ${parts.join(", ")}`;
}
