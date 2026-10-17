import type { PropertyType } from "@prisma/client";
import type { RelationData } from "@/server/queries";
import type { GeoValue } from "@/lib/geo";
import type { UniqueIdConfig } from "@/lib/unique-id";
import type { TagHue } from "@/lib/design-tokens";
import { hueEdge, hueInk, hueSurface, normalizeHue } from "@/lib/palette";

/**
 * The database shape shared by the view renderers.
 *
 * Extracted from `database-view.tsx` so a view component can be moved or tested
 * without importing the whole screen (docs/FIX_PLAN.md P3).
 */

export type PropertyConfig = {
  primary?: boolean;
  options?: { id: string; name: string; color: string; group?: string }[];
  groupByPropertyId?: string | null;
  /** NUMBER: "number" | "percent" | "currency". DATE: "date" | "friendly". */
  format?: string;
  /** NUMBER + format "currency": ISO 4217 code (defaults to USD). */
  currency?: string;
  /**
   * UNIQUE_ID: prefix / zero-pad / start-at / separator for the row-id
   * formatter (`@/lib/unique-id`). Every field is optional so unset values fall
   * back to the engine defaults ("ITEM"-style prefix, 4 digits, start at 1).
   */
  uniqueId?: Partial<UniqueIdConfig>;
  /**
   * PLACE: default map centre and zoom for the location picker
   * (`@/lib/geo`). Unset fields open the picker at the world view.
   */
  place?: Partial<GeoValue> & { zoom?: number };
  /**
   * DATE: range/all-day/time-zone defaults applied to new values
   * (`@/lib/date-range`). Optional so existing DATE properties are unchanged.
   */
  date?: {
    /** Offer an end date in addition to a start date. */
    allowRange?: boolean;
    /** Whether new values default to an all-day (date-only) range. */
    allDay?: boolean;
    /** Default IANA time zone, e.g. "Europe/Paris". See `isValidTimeZone`. */
    timeZone?: string;
  };
} | null;

export type DBProperty = {
  id: string;
  name: string;
  type: PropertyType;
  config: PropertyConfig;
};

export type DBRow = {
  id: string;
  title: string;
  icon: string | null;
  createdAt?: string;
  updatedAt?: string;
  createdByName?: string | null;
  /** Latest actor of a recorded row edit; falls back to the creator. */
  lastEditedByName?: string | null;
  propertyValues: { propertyId: string; value: unknown }[];
};

export type DBView = {
  id: string;
  name: string;
  type: string;
  config: { groupByPropertyId?: string | null } | null;
};

export type HeaderConfig = {
  databases: { id: string; title: string; icon: string | null }[];
  relations: { id: string; name: string }[];
  relationData: Record<string, RelationData>;
  onLinkDatabase: (property: DBProperty, targetDatabaseId: string) => void;
  onConfigureRollup: (property: DBProperty, config: Record<string, unknown>) => void;
};

export const COLOR_CHOICES = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

/** Class for the small filter/sort/group controls. */
export const CONTROL_CLASS =
  "h-8 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

/**
 * Resolve a persisted colour id to a hue in the shared tag palette
 * (`@/lib/palette`, the one colour catalogue). The stored ids are exactly
 * `COLOR_CHOICES`; anything
 * else — a stale id, a future hue, `null` — reads as `gray`, so a swatch is
 * never left unstyled. This is the single normaliser every option accessor
 * below calls, so a chip, a board dot and a chart series all agree.
 */
export function optionHue(color: string | null | undefined): TagHue {
  return normalizeHue(color);
}

/** The tag ink (`--tag-<hue>-fg`) for a persisted option colour id. */
export function optionInk(color: string | null | undefined): string {
  return hueInk(color);
}

/** The tag surface (`--tag-<hue>-bg`) for a persisted option colour id. */
export function optionSurface(color: string | null | undefined): string {
  return hueSurface(color);
}

/** The tag edge (`--tag-<hue>-bd`) for a persisted option colour id. */
export function optionEdge(color: string | null | undefined): string {
  return hueEdge(color);
}

/**
 * Option colour catalogue, shared by the table/board cells, the list chips and
 * the chart series.
 *
 * The keys are the persisted colour ids (`COLOR_CHOICES`) and are frozen: a
 * stored option `color` round-trips through the DB as one of these names, so
 * renaming a key would orphan every option that already uses it. The values used
 * to be raw hex and are now `var(--tag-<hue>-fg)` expressions resolved by
 * `tokens.css`, so light, dark and high-contrast stay in sync without a second
 * colour source. Reach for this map when a solid hue paint is wanted; use
 * `optionSurface` / `optionEdge` for the softer `-bg` / `-bd` tokens.
 */
export const OPTION_COLORS: Record<string, string> = {
  gray: hueInk("gray"),
  blue: hueInk("blue"),
  green: hueInk("green"),
  red: hueInk("red"),
  yellow: hueInk("yellow"),
  orange: hueInk("orange"),
  purple: hueInk("purple"),
  pink: hueInk("pink"),
  brown: hueInk("brown"),
};
