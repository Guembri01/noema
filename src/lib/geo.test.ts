import { describe, expect, it } from "vitest";
import {
  boundingBox,
  cardinalDirection,
  distanceKm,
  distanceMiles,
  formatGeo,
  normalizeGeo,
  parseGeo,
  withinBoundingBox,
  type GeoValue,
} from "@/lib/geo";

/**
 * Place/location property coordinate model (`docs/MISSING_FEATURES.md`).
 *
 * Pure helpers only: parsing a stored coordinate, normalizing it, great-circle
 * distance, a search bounding box (antimeridian + polar aware) and the
 * presentation helpers (decimal / DMS + cardinal heading). No network.
 */

// Fixed reference points used across the suite.
const PARIS: GeoValue = { lat: 48.8566, lng: 2.3522 };
const LONDON: GeoValue = { lat: 51.5074, lng: -0.1278 };

describe("parseGeo", () => {
  it("accepts a coordinate object and keeps an optional label", () => {
    expect(parseGeo({ lat: 48.8566, lng: 2.3522 })).toEqual({
      ok: true,
      value: { lat: 48.8566, lng: 2.3522 },
    });
    expect(parseGeo({ lat: 1, lng: 2, label: "HQ" })).toEqual({
      ok: true,
      value: { lat: 1, lng: 2, label: "HQ" },
    });
  });

  it("accepts a `lat,lng` string (with or without spaces)", () => {
    expect(parseGeo("48.8566, 2.3522")).toEqual({
      ok: true,
      value: { lat: 48.8566, lng: 2.3522 },
    });
    expect(parseGeo("-33.8688,151.2093")).toMatchObject({
      ok: true,
      value: { lat: -33.8688, lng: 151.2093 },
    });
  });

  it("accepts the inclusive range boundaries", () => {
    expect(parseGeo({ lat: -90, lng: -180 }).ok).toBe(true);
    expect(parseGeo({ lat: 90, lng: 180 }).ok).toBe(true);
    expect(parseGeo("-90,-180").ok).toBe(true);
  });

  it("rejects out-of-range, non-finite and malformed input", () => {
    expect(parseGeo({ lat: 90.1, lng: 0 }).ok).toBe(false);
    expect(parseGeo({ lat: -91, lng: 0 }).ok).toBe(false);
    expect(parseGeo({ lat: 0, lng: 180.5 }).ok).toBe(false);
    expect(parseGeo({ lat: 0, lng: -181 }).ok).toBe(false);
    expect(parseGeo({ lat: NaN, lng: 0 }).ok).toBe(false);
    expect(parseGeo({ lat: 0, lng: Infinity }).ok).toBe(false);
    expect(parseGeo("not-a-coordinate").ok).toBe(false);
    expect(parseGeo("91,0").ok).toBe(false);
    expect(parseGeo("0,181").ok).toBe(false);
    expect(parseGeo("1").ok).toBe(false);
    expect(parseGeo("1,2,3").ok).toBe(false);
    expect(parseGeo("1,").ok).toBe(false);
    expect(parseGeo("").ok).toBe(false);
    expect(parseGeo(null).ok).toBe(false);
    expect(parseGeo(42).ok).toBe(false);
  });

  it("returns a human-readable error message on failure", () => {
    const bad = parseGeo({ lat: 999, lng: 0 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(typeof bad.error).toBe("string");
  });
});

describe("normalizeGeo", () => {
  it("clamps latitude to [-90, 90]", () => {
    expect(normalizeGeo({ lat: 100, lng: 0 }).lat).toBe(90);
    expect(normalizeGeo({ lat: -100, lng: 0 }).lat).toBe(-90);
    expect(normalizeGeo({ lat: 48.8566, lng: 0 }).lat).toBe(48.8566);
  });

  it("wraps longitude into [-180, 180)", () => {
    expect(normalizeGeo({ lat: 0, lng: 190 }).lng).toBe(-170);
    expect(normalizeGeo({ lat: 0, lng: -185 }).lng).toBe(175);
    expect(normalizeGeo({ lat: 0, lng: 180 }).lng).toBe(-180);
    expect(normalizeGeo({ lat: 0, lng: -180 }).lng).toBe(-180);
    expect(normalizeGeo({ lat: 0, lng: 540 }).lng).toBe(-180);
    expect(normalizeGeo({ lat: 0, lng: 2.3522 }).lng).toBe(2.3522);
  });

  it("preserves an optional label", () => {
    expect(normalizeGeo({ lat: 100, lng: 190, label: "Far" })).toEqual({
      lat: 90,
      lng: -170,
      label: "Far",
    });
  });
});

describe("distance", () => {
  it("returns 0 for identical points", () => {
    expect(distanceKm(PARIS, PARIS)).toBe(0);
    expect(distanceMiles(LONDON, LONDON)).toBe(0);
  });

  it("measures Paris–London with the haversine formula (≈343.5 km)", () => {
    const km = distanceKm(PARIS, LONDON);
    expect(km).toBeGreaterThan(341.5);
    expect(km).toBeLessThan(345.5);
  });

  it("is symmetric", () => {
    expect(distanceKm(PARIS, LONDON)).toBeCloseTo(distanceKm(LONDON, PARIS), 9);
  });

  it("converts kilometres to miles consistently", () => {
    const km = distanceKm(PARIS, LONDON);
    const miles = distanceMiles(PARIS, LONDON);
    expect(miles).toBeCloseTo(km * 0.621371, 3);
    expect(miles).toBeGreaterThan(211);
    expect(miles).toBeLessThan(216);
  });
});

describe("boundingBox", () => {
  it("builds a normal box around a centre", () => {
    const box = boundingBox(PARIS, 100);
    expect(box.crossesAntimeridian).toBe(false);
    expect(box.minLat).toBeCloseTo(47.96, 2);
    expect(box.maxLat).toBeCloseTo(49.76, 2);
    expect(box.minLng).toBeCloseTo(0.99, 2);
    expect(box.maxLng).toBeCloseTo(3.72, 2);
    expect(box.minLat).toBeLessThan(box.maxLat);
    expect(box.minLng).toBeLessThan(box.maxLng);
  });

  it("clamps a polar box and spans all longitudes", () => {
    const box = boundingBox({ lat: 85, lng: 10 }, 1000);
    expect(box.maxLat).toBe(90);
    expect(box.minLat).toBeCloseTo(76.01, 1);
    expect(box.minLng).toBe(-180);
    expect(box.maxLng).toBe(180);
    expect(box.crossesAntimeridian).toBe(false);
  });

  it("flags a box that crosses the antimeridian", () => {
    const box = boundingBox({ lat: 0, lng: 179 }, 200);
    expect(box.crossesAntimeridian).toBe(true);
    expect(box.minLng).toBeCloseTo(177.2, 2);
    expect(box.maxLng).toBeCloseTo(-179.2, 2);
    expect(box.minLng).toBeGreaterThan(box.maxLng);
  });
});

describe("withinBoundingBox", () => {
  it("includes interior points and excludes points outside a normal box", () => {
    const box = boundingBox(PARIS, 100);
    expect(withinBoundingBox(box, PARIS)).toBe(true);
    expect(withinBoundingBox(box, { lat: 48.9, lng: 2.4 })).toBe(true);
    expect(withinBoundingBox(box, { lat: 60, lng: 2.35 })).toBe(false);
    expect(withinBoundingBox(box, { lat: 48.8566, lng: 40 })).toBe(false);
  });

  it("wraps around the antimeridian", () => {
    const box = boundingBox({ lat: 0, lng: 179 }, 200);
    expect(withinBoundingBox(box, { lat: 0, lng: 179 })).toBe(true);
    expect(withinBoundingBox(box, { lat: 0, lng: 179.5 })).toBe(true);
    expect(withinBoundingBox(box, { lat: 0, lng: -179.5 })).toBe(true);
    expect(withinBoundingBox(box, { lat: 0, lng: 0 })).toBe(false);
    expect(withinBoundingBox(box, { lat: 0, lng: 176 })).toBe(false);
  });

  it("matches any longitude inside a polar box", () => {
    const polar = boundingBox({ lat: 85, lng: 10 }, 1000);
    expect(withinBoundingBox(polar, { lat: 89, lng: -170 })).toBe(true);
    expect(withinBoundingBox(polar, { lat: 70, lng: 0 })).toBe(false);
  });
});

describe("formatGeo", () => {
  it("formats decimal coordinates", () => {
    expect(formatGeo(PARIS)).toBe("48.8566, 2.3522");
    expect(formatGeo(PARIS, { style: "decimal" })).toBe("48.8566, 2.3522");
  });

  it("rounds decimal coordinates consistently", () => {
    expect(formatGeo({ lat: 1.23456, lng: -1.23456 })).toBe("1.2346, -1.2346");
    expect(formatGeo({ lat: -48.8566, lng: -2.3522 })).toBe("-48.8566, -2.3522");
    expect(formatGeo({ lat: 1.5, lng: 2 })).toBe("1.5000, 2.0000");
    expect(formatGeo({ lat: 1.23456, lng: 2 }, { decimals: 2 })).toBe("1.23, 2.00");
  });

  it("formats DMS coordinates with hemispheres and zero padding", () => {
    expect(formatGeo(PARIS, { style: "dms" })).toBe(`48°51'24"N, 2°21'08"E`);
    expect(formatGeo({ lat: -33.8688, lng: 151.2093 }, { style: "dms" })).toBe(
      `33°52'08"S, 151°12'33"E`,
    );
    expect(formatGeo({ lat: 40.7128, lng: -74.006 }, { style: "dms" })).toBe(
      `40°42'46"N, 74°00'22"W`,
    );
  });

  it("carries DMS seconds into minutes and minutes into degrees", () => {
    expect(formatGeo({ lat: 0.99999, lng: 0 }, { style: "dms" })).toBe(
      `1°00'00"N, 0°00'00"E`,
    );
  });
});

describe("cardinalDirection", () => {
  it("covers all eight compass sectors from a fixed origin", () => {
    const origin: GeoValue = { lat: 0, lng: 0 };
    expect(cardinalDirection(origin, { lat: 10, lng: 0 })).toBe("N");
    expect(cardinalDirection(origin, { lat: 10, lng: 10 })).toBe("NE");
    expect(cardinalDirection(origin, { lat: 0, lng: 10 })).toBe("E");
    expect(cardinalDirection(origin, { lat: -10, lng: 10 })).toBe("SE");
    expect(cardinalDirection(origin, { lat: -10, lng: 0 })).toBe("S");
    expect(cardinalDirection(origin, { lat: -10, lng: -10 })).toBe("SW");
    expect(cardinalDirection(origin, { lat: 0, lng: -10 })).toBe("W");
    expect(cardinalDirection(origin, { lat: 10, lng: -10 })).toBe("NW");
  });

  it("points north-west from Paris toward London", () => {
    expect(cardinalDirection(PARIS, LONDON)).toBe("NW");
  });
});
