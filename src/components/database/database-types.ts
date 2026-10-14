import type { PropertyType } from "@prisma/client";
import type { RelationData } from "@/server/queries";
import type { GeoValue } from "@/lib/geo";
import type { UniqueIdConfig } from "@/lib/unique-id";

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

/** Option chip colours, shared by the table/board cells and the chart series. */
export const OPTION_COLORS: Record<string, string> = {
  gray: "#8a8a85",
  blue: "#2563eb",
  green: "#16a34a",
  red: "#dc2626",
  yellow: "#ca8a04",
  orange: "#ea580c",
  purple: "#7c3aed",
  pink: "#db2777",
  brown: "#9f6b53",
};
