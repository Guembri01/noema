/**
 * Gallery card previews + list view models
 * (docs/MISSING_FEATURES.md §3 row "Gallery previews": "Show cover or page
 * content on cards"), plus the list-view density model that shares the same
 * row/property shapes.
 *
 * These are the pure decision halves of two database view modes:
 *
 * - **Gallery** — `resolveCardPreview` decides which image a card shows (the
 *   page cover property first, the page icon second, otherwise nothing) and
 *   `cardFieldOrder` decides which properties the card lists, in schema order,
 *   skipping the one the cover already shows. `CARD_SIZES` / `cardSizeFor`
 *   turn a size name or a container width into a concrete column/aspect spec.
 * - **List** — `listRowModel` builds a row's primary/secondary text and whether
 *   it is expanded, under a compact/comfortable `density`.
 *
 * No DB, no routes, no React: a view toolbar can render a gallery or list with
 * these functions and nothing else. The row/property shapes are structural
 * (see `ViewRowLike` / `ViewPropertyLike`), so they line up with the query
 * engine's `QueryRow` / `QueryProperty` without importing them.
 */

/** A property definition as the view needs it (id + optional type metadata). */
export type ViewPropertyLike = {
  id: string;
  name?: string;
  /** Property type, e.g. `"files"`, `"select"`, `"title"`. Loose on purpose. */
  type?: string;
};

/** One `propertyId → value` pair, the shape the query engine stores. */
export type ViewValueLike = { propertyId: string; value: unknown };

/** A database row, reduced to what a gallery card or list row renders. */
export type ViewRowLike = {
  id?: string;
  title?: string;
  icon?: string | null;
  propertyValues?: readonly ViewValueLike[];
};

/**
 * The resolved card preview.
 *
 * `value` is the chosen cover URL or icon string; it is absent for `"none"`.
 */
export type CardPreview = { kind: "cover" | "icon" | "none"; value?: string };

export type CardPreviewOptions = {
  /** Property holding the page cover (a files/media/url property). */
  coverPropertyId?: string | null;
  /** Page icon fallback; when set and non-blank it wins over `row.icon`. */
  icon?: string | null;
};

export type CardFieldOrderOptions = {
  /** Property id already represented by the card preview; never listed twice. */
  previewPropertyId?: string | null;
  /**
   * Cap on the number of fields returned. Defaults to
   * `DEFAULT_CARD_FIELDS` (3); `Infinity` returns every field.
   */
  maxFields?: number;
};

/** Named gallery card sizes, from densest (`small`) to roomiest (`large`). */
export type CardSizeName = "small" | "medium" | "large";

export type CardSizeSpec = {
  /** Fixed column count; more columns means smaller cards. */
  columns: number;
  /** CSS `aspect-ratio` value for the cover/preview box. */
  aspect: string;
  /** Whether the card renders the resolved preview at this size. */
  showPreview: boolean;
};

export type ListDensity = "compact" | "comfortable";

export type ListRowModel = {
  /** Title line; empty when the row has no title. */
  primary: string;
  /** First non-empty property value, rendered to text; empty when none. */
  secondary: string;
  /** Compact rows collapse to a single line; comfortable rows expand. */
  expanded: boolean;
};

export type ListRowModelOptions = { density?: ListDensity };

export type DensityOption = { value: ListDensity; label: string };

/** Default number of properties a gallery card lists. */
export const DEFAULT_CARD_FIELDS = 3;

/** Property types whose value can act as a card cover image. */
export const COVER_PROPERTY_TYPES = ["files", "media", "url"] as const;

/** The supported list densities, in menu order. */
export const LIST_DENSITIES = ["compact", "comfortable"] as const;

/**
 * Gallery size presets. `small` packs four preview-less columns; `medium` and
 * `large` trade columns for a visible cover (`showPreview`).
 */
export const CARD_SIZES: Record<CardSizeName, CardSizeSpec> = {
  small: { columns: 4, aspect: "1 / 1", showPreview: false },
  medium: { columns: 3, aspect: "4 / 3", showPreview: true },
  large: { columns: 2, aspect: "16 / 9", showPreview: true },
};

/**
 * Container-width breakpoints (px) at which `cardSizeFor` steps up a size.
 * Below `medium` the size is `small`.
 */
export const CARD_SIZE_BREAKPOINTS = { medium: 640, large: 1024 } as const;

/** Trim a value to a non-empty string, or `undefined` when it is not one. */
function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a row's raw value for `propertyId` (first match wins). */
function readPropertyValue(
  row: ViewRowLike | null | undefined,
  propertyId: string,
): unknown {
  const values = row?.propertyValues;
  if (!values) return undefined;
  for (const entry of values) {
    if (entry && entry.propertyId === propertyId) return entry.value;
  }
  return undefined;
}

/**
 * Pull the first usable media URL out of a cover value: a URL string, the
 * first URL in a files array, or the `url`/`src`/`href` of an object. Blank
 * and malformed entries are skipped.
 */
function firstMediaUrl(value: unknown): string | undefined {
  const direct = normalizeText(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstMediaUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const directUrl =
      normalizeText(object.url) ??
      normalizeText(object.src) ??
      normalizeText(object.href);
    if (directUrl) return directUrl;
    // FILES values store `{ files: [{ name, url, mimeType }] }`; the legacy
    // gallery path must read the same shape the FILES cell renders, otherwise
    // an unconfigured gallery shows a file placeholder instead of its image.
    if (Array.isArray(object.files)) {
      for (const file of object.files) {
        const url = firstMediaUrl(file);
        if (url) return url;
      }
    }
  }
  return undefined;
}

/**
 * Resolve what a gallery card shows as its preview, by precedence:
 *
 * 1. the page **cover** — the value of `coverPropertyId`, when that property
 *    exists in `props` and is not declared with a non-media type;
 * 2. the **icon** — `options.icon` when non-blank, otherwise `row.icon`;
 * 3. **none**.
 *
 * Blank covers and unknown/non-media cover properties fall through rather than
 * render an empty image, so a card never reserves space for a broken cover.
 * Pure: neither the row nor its values are mutated.
 */
export function resolveCardPreview(
  row: ViewRowLike | null | undefined,
  props: readonly ViewPropertyLike[],
  options: CardPreviewOptions = {},
): CardPreview {
  const coverId = options.coverPropertyId;
  if (coverId) {
    const property = props.find((candidate) => candidate?.id === coverId);
    const coverEligible =
      !property?.type ||
      (COVER_PROPERTY_TYPES as readonly string[]).includes(property.type);
    if (coverEligible) {
      const url = firstMediaUrl(readPropertyValue(row, coverId));
      if (url) return { kind: "cover", value: url };
    }
  }

  const icon = normalizeText(options.icon) ?? normalizeText(row?.icon);
  if (icon) return { kind: "icon", value: icon };

  return { kind: "none" };
}

/** Normalise a `maxFields` argument to a usable, non-negative limit. */
function resolveFieldLimit(maxFields: number | null | undefined): number {
  if (maxFields === undefined || maxFields === null) return DEFAULT_CARD_FIELDS;
  if (maxFields === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxFields)) return DEFAULT_CARD_FIELDS;
  return Math.max(0, Math.trunc(maxFields));
}

/**
 * The property ids a gallery card lists, in schema order.
 *
 * - The property shown by the card preview (`previewPropertyId`) is excluded so
 *   a cover is never repeated as a field.
 * - Keyless and duplicate ids are dropped defensively.
 * - The result is capped at `maxFields` (default `DEFAULT_CARD_FIELDS` = 3;
 *   `0` → none, `Infinity` → all), applied *after* the exclusion.
 * - Pure: the schema array is never mutated.
 */
export function cardFieldOrder(
  props: readonly ViewPropertyLike[],
  options: CardFieldOrderOptions = {},
): string[] {
  const limit = resolveFieldLimit(options.maxFields);
  const ordered: string[] = [];
  for (const property of props) {
    const id = property?.id;
    if (!id || id === options.previewPropertyId || ordered.includes(id)) continue;
    if (ordered.length >= limit) break;
    ordered.push(id);
  }
  return ordered;
}

/**
 * The gallery size for a container `width` in px: `small` below the medium
 * breakpoint (also for degenerate widths), then `medium`, then `large` at
 * `CARD_SIZE_BREAKPOINTS`. Wider containers get roomier cards.
 */
export function cardSizeFor(width: number): CardSizeName {
  if (!Number.isFinite(width) || width < CARD_SIZE_BREAKPOINTS.medium) {
    return "small";
  }
  if (width < CARD_SIZE_BREAKPOINTS.large) return "medium";
  return "large";
}

/** Render an arbitrary property value to a short, human-readable string. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value
      .map(renderValue)
      .filter((part) => part.length > 0)
      .join(", ");
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      normalizeText(object.name) ??
      normalizeText(object.title) ??
      normalizeText(object.url) ??
      ""
    );
  }
  return "";
}

/** The first non-empty rendered value across `props`, or `""`. */
function firstRenderedValue(
  row: ViewRowLike | null | undefined,
  props: readonly ViewPropertyLike[],
): string {
  for (const property of props) {
    const id = property?.id;
    if (!id) continue;
    const rendered = renderValue(readPropertyValue(row, id));
    if (rendered) return rendered;
  }
  return "";
}

/**
 * Build a list-view row model.
 *
 * - `primary` is the row title (empty when absent).
 * - `secondary` is the first non-empty property value, in schema order,
 *   rendered to text (numbers as-is, booleans as `Yes`/`No`, arrays joined
 *   with `", "`).
 * - `expanded` is `true` for `"comfortable"` density and `false` for
 *   `"compact"` (the default, also used for a missing/unknown density).
 * - Pure: the row is never mutated.
 */
export function listRowModel(
  row: ViewRowLike | null | undefined,
  props: readonly ViewPropertyLike[],
  options: ListRowModelOptions = {},
): ListRowModel {
  const density: ListDensity =
    options.density === "comfortable" ? "comfortable" : "compact";
  return {
    primary: normalizeText(row?.title) ?? "",
    secondary: firstRenderedValue(row, props),
    expanded: density === "comfortable",
  };
}

/**
 * The density choices a list-view toolbar offers, in menu order. Returns a
 * fresh array (and fresh option objects) each call so callers can sort or
 * annotate the result without touching shared state.
 */
export function densityOptions(): DensityOption[] {
  return LIST_DENSITIES.map((value) => ({
    value,
    label: value === "compact" ? "Compact" : "Comfortable",
  }));
}
