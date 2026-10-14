/**
 * Provider-agnostic map block helpers (`docs/MISSING_FEATURES.md`, "Map
 * block").
 *
 * Pure, dependency-free and offline: turn a stored {@link GeoValue} into a
 * safe embed URL (OpenStreetMap or Google Maps) or a plain external link.
 * Coordinates are validated through `parseGeo` and every number is
 * re-serialised at a fixed precision, so a stored value can never smuggle a
 * protocol, query separator or exponent notation into the URL. No network.
 */

import { parseGeo, type GeoValue } from "@/lib/geo";

/** The map providers this module can build URLs for. */
export const MAP_PROVIDERS = ["osm", "google"] as const;

export type MapProvider = (typeof MAP_PROVIDERS)[number];

/** Web-Mercator tile size in pixels; the world is `256 * 2^zoom` px wide. */
export const TILE_SIZE = 256;

/** Default embed viewport in pixels, used to derive the OSM bounding box. */
export const DEFAULT_VIEWPORT_WIDTH = 640;
export const DEFAULT_VIEWPORT_HEIGHT = 480;

/** Zoom is a whole tile-level integer; Google clamps to 21 and OSM to 19. */
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 20;
export const DEFAULT_ZOOM = 12;

export type MapEmbedOptions = {
  /** `"osm"` (default) → openstreetmap.org iframe; `"google"` → Google Maps. */
  provider?: MapProvider;
  /** Tile zoom level; must satisfy {@link isValidZoom}. Defaults to 12. */
  zoom?: number;
};

/** A plain latitude/longitude box, ready to be serialised into a URL. */
export type MapBbox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

/**
 * True when `zoom` is a whole tile level inside `[MIN_ZOOM, MAX_ZOOM]`.
 * Fractional, non-finite and non-number inputs are rejected so a zoom can
 * never be interpolated straight into a URL.
 */
export function isValidZoom(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ZOOM &&
    value <= MAX_ZOOM
  );
}

/** Validate/normalise a stored value, or `null` when the coordinates are bad. */
function coordsOf(value: unknown): GeoValue | null {
  const parsed = parseGeo(value);
  return parsed.ok ? parsed.value : null;
}

/**
 * Serialise a number for a URL: fixed 6 decimals (never exponent or locale
 * form), trailing zeros trimmed and `-0` normalised to `0`.
 */
function num(value: number): string {
  const v = value === 0 ? 0 : value;
  const fixed = v.toFixed(6);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
}

/**
 * A latitude/longitude box centred on `(lat, lng)` at the given `zoom`, sized
 * by {@link DEFAULT_VIEWPORT_WIDTH}×{@link DEFAULT_VIEWPORT_HEIGHT} pixels.
 * Longitude span is exact for the zoom; the latitude span is scaled by
 * `cos(lat)` (an equirectangular approximation valid for a small viewport) so
 * the box looks square on screen. Latitude is clamped at the poles.
 *
 * Returns `null` for non-finite / out-of-range coordinates or an invalid zoom.
 */
export function bboxForPoint(lat: number, lng: number, zoom: number): MapBbox | null {
  if (!isValidZoom(zoom)) return null;
  const coords = coordsOf({ lat, lng });
  if (!coords) return null;

  const worldPixels = TILE_SIZE * 2 ** zoom;
  const degreesPerPixel = 360 / worldPixels;
  const lngHalf = (DEFAULT_VIEWPORT_WIDTH * degreesPerPixel) / 2;
  const latHalf =
    (DEFAULT_VIEWPORT_HEIGHT * degreesPerPixel * Math.cos((coords.lat * Math.PI) / 180)) / 2;

  return {
    minLat: Math.max(-90, coords.lat - latHalf),
    maxLat: Math.min(90, coords.lat + latHalf),
    minLng: coords.lng - lngHalf,
    maxLng: coords.lng + lngHalf,
  };
}

/**
 * Build a safe `https://` embed URL for a coordinate, or `null` when the
 * coordinate is invalid or the zoom is out of range.
 *
 * - `osm` → `https://www.openstreetmap.org/export/embed.html?bbox=…&marker=lat,lng`
 * - `google` → `https://www.google.com/maps?q=lat,lng&z=zoom`
 */
export function mapEmbedUrl(value: GeoValue, options: MapEmbedOptions = {}): string | null {
  const coords = coordsOf(value);
  if (!coords) return null;

  const provider: string = options.provider ?? "osm";
  if (provider !== "osm" && provider !== "google") return null;

  const zoom = options.zoom ?? DEFAULT_ZOOM;
  if (!isValidZoom(zoom)) return null;

  const marker = `${num(coords.lat)},${num(coords.lng)}`;

  if (provider === "google") {
    return `https://www.google.com/maps?q=${marker}&z=${zoom}`;
  }

  const bbox = bboxForPoint(coords.lat, coords.lng, zoom);
  if (!bbox) return null;
  const bboxParam = `${num(bbox.minLng)},${num(bbox.minLat)},${num(bbox.maxLng)},${num(bbox.maxLat)}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bboxParam}&marker=${marker}`;
}

/**
 * Build a plain `https://` external map link for a coordinate (OpenStreetMap,
 * pin at the default zoom), or `null` when the coordinate is invalid. Unsafe
 * for an iframe — use {@link mapEmbedUrl} for that.
 */
export function mapLinkUrl(value: GeoValue): string | null {
  const coords = coordsOf(value);
  if (!coords) return null;
  return `https://www.openstreetmap.org/?mlat=${num(coords.lat)}&mlon=${num(coords.lng)}#map=${DEFAULT_ZOOM}/${num(coords.lat)}/${num(coords.lng)}`;
}
