/**
 * Place/location coordinate model (`docs/MISSING_FEATURES.md`, "Place/location
 * property").
 *
 * Pure, dependency-free and offline: parse/normalize a stored coordinate,
 * great-circle distance, an antimeridian- and pole-aware search bounding box,
 * plus the presentation helpers (decimal / DMS text and a cardinal heading).
 * Deliberately no geocoding or network access — the picker UI and DB column
 * are separate slices.
 */

/** A place coordinate. `label` is an optional human caption (e.g. "HQ"). */
export type GeoValue = { lat: number; lng: number; label?: string };

/** Latitude is limited to the poles; longitude is limited to ±180. */
export const MIN_LATITUDE = -90;
export const MAX_LATITUDE = 90;
export const MIN_LONGITUDE = -180;
export const MAX_LONGITUDE = 180;

/** Mean Earth radius in kilometres (IUGG), used by the haversine helpers. */
export const EARTH_RADIUS_KM = 6371.0088;

/** Kilometres per degree of latitude at the Earth's surface. */
const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180;

/** Kilometres in one statute mile. */
const KM_PER_MILE = 1.609344;

const DEGREES_TO_RADIANS = Math.PI / 180;

export type GeoParseResult =
  | { ok: true; value: GeoValue }
  | { ok: false; error: string };

/** A latitude/longitude search box. `maxLng < minLng` means it wraps ±180. */
export type GeoBoundingBox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  /** True when the box spans the antimeridian (180° / -180°). */
  crossesAntimeridian: boolean;
};

export type GeoFormatStyle = "decimal" | "dms";
export type GeoFormatOptions = {
  /** `"decimal"` (default) → `48.8566, 2.3522`; `"dms"` → `48°51'24"N, …`. */
  style?: GeoFormatStyle;
  /** Decimal places for the `"decimal"` style (default 4). */
  decimals?: number;
};

/** Compass heading, clockwise from north. */
export type CardinalDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** Shared validation for the object and string forms of {@link parseGeo}. */
function acceptCoords(
  lat: unknown,
  lng: unknown,
  label: unknown,
): GeoParseResult {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    return { ok: false, error: "Latitude and longitude must be finite numbers." };
  }
  if (!inRange(lat, MIN_LATITUDE, MAX_LATITUDE)) {
    return { ok: false, error: `Latitude must be between ${MIN_LATITUDE} and ${MAX_LATITUDE}.` };
  }
  if (!inRange(lng, MIN_LONGITUDE, MAX_LONGITUDE)) {
    return { ok: false, error: `Longitude must be between ${MIN_LONGITUDE} and ${MAX_LONGITUDE}.` };
  }
  const value: GeoValue = { lat, lng };
  if (typeof label === "string" && label.trim() !== "") value.label = label;
  return { ok: true, value };
}

/**
 * Parse a stored place value — either a `{ lat, lng, label? }` object or a
 * `"lat,lng"` string. Rejects non-finite numbers and coordinates outside
 * [-90, 90] / [-180, 180] (bounds inclusive).
 */
export function parseGeo(raw: unknown): GeoParseResult {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    return acceptCoords(record.lat, record.lng, record.label);
  }
  if (typeof raw === "string") {
    const parts = raw.split(",");
    if (parts.length !== 2) {
      return { ok: false, error: "Expected a coordinate as `lat, lng`." };
    }
    const latText = parts[0].trim();
    const lngText = parts[1].trim();
    if (latText === "" || lngText === "") {
      return { ok: false, error: "Expected a coordinate as `lat, lng`." };
    }
    return acceptCoords(Number(latText), Number(lngText), undefined);
  }
  return { ok: false, error: "Expected a coordinate object or `lat, lng` string." };
}

/**
 * Clamp latitude into [-90, 90] and wrap longitude into [-180, 180)
 * (190 → -170, -185 → 175, 180 → -180). The optional `label` is preserved.
 */
export function normalizeGeo(value: GeoValue): GeoValue {
  const lat = Math.max(MIN_LATITUDE, Math.min(MAX_LATITUDE, value.lat));
  // Skip the modulo when already in range so a stored value round-trips exactly.
  const lng =
    value.lng >= MIN_LONGITUDE && value.lng < MAX_LONGITUDE
      ? value.lng
      : ((((value.lng + MAX_LONGITUDE) % 360) + 360) % 360) - MAX_LONGITUDE;
  const result: GeoValue = { lat, lng };
  if (value.label !== undefined) result.label = value.label;
  return result;
}

function toRadians(degrees: number): number {
  return degrees * DEGREES_TO_RADIANS;
}

/** Great-circle distance between two coordinates, in kilometres (haversine). */
export function distanceKm(a: GeoValue, b: GeoValue): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const dPhi = toRadians(b.lat - a.lat);
  const dLambda = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance between two coordinates, in statute miles. */
export function distanceMiles(a: GeoValue, b: GeoValue): number {
  return distanceKm(a, b) / KM_PER_MILE;
}

/**
 * A latitude/longitude box enclosing every point within `radiusKm` of
 * `center`. Latitude is clamped at the poles (where the box spans all
 * longitudes) and, when the span crosses ±180, the result is reported with
 * `minLng > maxLng` and `crossesAntimeridian: true`.
 */
export function boundingBox(center: GeoValue, radiusKm: number): GeoBoundingBox {
  const latDelta = radiusKm / KM_PER_DEGREE;
  const minLat = Math.max(MIN_LATITUDE, center.lat - latDelta);
  const maxLat = Math.min(MAX_LATITUDE, center.lat + latDelta);
  const hitsPole = center.lat - latDelta <= MIN_LATITUDE || center.lat + latDelta >= MAX_LATITUDE;
  if (hitsPole) {
    return { minLat, maxLat, minLng: MIN_LONGITUDE, maxLng: MAX_LONGITUDE, crossesAntimeridian: false };
  }

  const cosLat = Math.cos(toRadians(center.lat));
  const lngDelta = radiusKm / (KM_PER_DEGREE * cosLat);
  if (lngDelta >= MAX_LONGITUDE || !Number.isFinite(lngDelta)) {
    return { minLat, maxLat, minLng: MIN_LONGITUDE, maxLng: MAX_LONGITUDE, crossesAntimeridian: false };
  }

  const rawMin = center.lng - lngDelta;
  const rawMax = center.lng + lngDelta;
  if (rawMax > MAX_LONGITUDE) {
    return { minLat, maxLat, minLng: rawMin, maxLng: rawMax - 360, crossesAntimeridian: true };
  }
  if (rawMin < MIN_LONGITUDE) {
    return { minLat, maxLat, minLng: rawMin + 360, maxLng: rawMax, crossesAntimeridian: true };
  }
  return { minLat, maxLat, minLng: rawMin, maxLng: rawMax, crossesAntimeridian: false };
}

/** True when `point` lies inside `box`, honouring antimeridian wrapping. */
export function withinBoundingBox(
  box: GeoBoundingBox,
  point: { lat: number; lng: number },
): boolean {
  if (point.lat < box.minLat || point.lat > box.maxLat) return false;
  if (box.crossesAntimeridian) {
    return point.lng >= box.minLng || point.lng <= box.maxLng;
  }
  return point.lng >= box.minLng && point.lng <= box.maxLng;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * One hemisphere-free DMS triple, rounded to whole seconds with carries
 * (60" → 1', 60' → 1°). `seconds` is zero-padded to two digits.
 */
function toDms(value: number): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = Math.round((minutesFloat - minutes) * 60);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    degrees += 1;
  }
  return `${degrees}°${pad2(minutes)}'${pad2(seconds)}"`;
}

function dmsHemisphere(lat: number, lng: number): string {
  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";
  return `${toDms(lat)}${latDir}, ${toDms(lng)}${lngDir}`;
}

/**
 * Render a coordinate for display. `decimal` (default, 4 places) → 
 * `"48.8566, 2.3522"`; `dms` → `"48°51'24\"N, 2°21'08\"E"` (negative → S/W,
 * minutes/seconds zero-padded, seconds rounded to whole with carries).
 */
export function formatGeo(value: GeoValue, options: GeoFormatOptions = {}): string {
  if (options.style === "dms") return dmsHemisphere(value.lat, value.lng);
  const decimals = Number.isInteger(options.decimals)
    ? Math.max(0, Math.min(20, options.decimals as number))
    : 4;
  return `${value.lat.toFixed(decimals)}, ${value.lng.toFixed(decimals)}`;
}

const COMPASS: readonly CardinalDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * The 8-point compass heading from `from` to `to`, derived from the initial
 * great-circle bearing (clockwise from north, rounded to the nearest 45°).
 */
export function cardinalDirection(from: GeoValue, to: GeoValue): CardinalDirection {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const dLambda = toRadians(to.lng - from.lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const bearing = ((Math.atan2(y, x) / DEGREES_TO_RADIANS) + 360) % 360;
  const index = Math.round(bearing / 45) % 8;
  return COMPASS[index];
}
