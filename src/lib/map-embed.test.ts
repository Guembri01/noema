import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  bboxForPoint,
  isValidZoom,
  mapEmbedUrl,
  mapLinkUrl,
  type MapProvider,
} from "@/lib/map-embed";
import type { GeoValue } from "@/lib/geo";

/**
 * Map block helpers (`docs/MISSING_FEATURES.md`): provider-agnostic embed /
 * link URL builders from a place coordinate. Pure and offline — every case
 * pins the strict-https output plus coordinate/zoom rejection.
 */

const PARIS: GeoValue = { lat: 48.8566, lng: 2.3522 };
const ORIGIN: GeoValue = { lat: 0, lng: 0 };

describe("isValidZoom", () => {
  it("accepts whole tile levels across the inclusive range", () => {
    expect(isValidZoom(MIN_ZOOM)).toBe(true);
    expect(isValidZoom(1)).toBe(true);
    expect(isValidZoom(DEFAULT_ZOOM)).toBe(true);
    expect(isValidZoom(MAX_ZOOM)).toBe(true);
  });

  it("rejects out-of-range, fractional and non-number zooms", () => {
    expect(isValidZoom(-1)).toBe(false);
    expect(isValidZoom(MAX_ZOOM + 1)).toBe(false);
    expect(isValidZoom(12.5)).toBe(false);
    expect(isValidZoom(Number.NaN)).toBe(false);
    expect(isValidZoom(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidZoom("12")).toBe(false);
  });
});

describe("bboxForPoint", () => {
  it("centres the box on the point (exact at the equator)", () => {
    expect(bboxForPoint(0, 0, 12)).toEqual({
      minLat: -0.0823974609375,
      maxLat: 0.0823974609375,
      minLng: -0.10986328125,
      maxLng: 0.10986328125,
    });
  });

  it("shrinks the box as the zoom grows", () => {
    const coarse = bboxForPoint(0, 0, 10);
    const fine = bboxForPoint(0, 0, 14);
    expect(coarse).not.toBeNull();
    expect(fine).not.toBeNull();
    const coarseSpan = (coarse?.maxLng ?? 0) - (coarse?.minLng ?? 0);
    const fineSpan = (fine?.maxLng ?? 0) - (fine?.minLng ?? 0);
    expect(fineSpan).toBeGreaterThan(0);
    expect(coarseSpan).toBeCloseTo(fineSpan * 16, 10);
  });

  it("scales the latitude span by cos(latitude)", () => {
    const box = bboxForPoint(PARIS.lat, PARIS.lng, 12);
    expect(box).not.toBeNull();
    if (!box) return;
    const latSpan = box.maxLat - box.minLat;
    const lngSpan = box.maxLng - box.minLng;
    const expected =
      (DEFAULT_VIEWPORT_HEIGHT / DEFAULT_VIEWPORT_WIDTH) *
      Math.cos((PARIS.lat * Math.PI) / 180);
    expect(latSpan / lngSpan).toBeCloseTo(expected, 6);
    expect((box.minLat + box.maxLat) / 2).toBeCloseTo(PARIS.lat, 10);
    expect((box.minLng + box.maxLng) / 2).toBeCloseTo(PARIS.lng, 10);
  });

  it("rejects invalid coordinates and zooms", () => {
    expect(bboxForPoint(91, 0, 12)).toBeNull();
    expect(bboxForPoint(0, 181, 12)).toBeNull();
    expect(bboxForPoint(Number.NaN, 0, 12)).toBeNull();
    expect(bboxForPoint(0, 0, 12.5)).toBeNull();
    expect(bboxForPoint(0, 0, -1)).toBeNull();
  });
});

describe("mapEmbedUrl", () => {
  it("builds an OpenStreetMap embed with bbox and marker (default provider)", () => {
    expect(mapEmbedUrl(ORIGIN)).toBe(
      "https://www.openstreetmap.org/export/embed.html?bbox=-0.109863,-0.082397,0.109863,0.082397&marker=0,0",
    );
  });

  it("honours an explicit zoom for the OSM embed", () => {
    const url = mapEmbedUrl(ORIGIN, { provider: "osm", zoom: 13 });
    expect(url).toMatch(/^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=/);
    expect(url).toContain("&marker=0,0");
    expect(url).not.toContain("z=13");
  });

  it("builds a Google Maps embed with q and z", () => {
    expect(mapEmbedUrl(PARIS, { provider: "google", zoom: 12 })).toBe(
      "https://www.google.com/maps?q=48.8566,2.3522&z=12",
    );
    expect(mapEmbedUrl(PARIS)).not.toContain("google");
  });

  it("keeps the Google marker when the zoom is customised", () => {
    expect(mapEmbedUrl(PARIS, { provider: "google", zoom: 15 })).toBe(
      "https://www.google.com/maps?q=48.8566,2.3522&z=15",
    );
  });

  it("always emits a strict https URL (no javascript/data schemes)", () => {
    const urls = [
      mapEmbedUrl(PARIS),
      mapEmbedUrl(PARIS, { provider: "google" }),
      mapEmbedUrl(ORIGIN, { provider: "osm", zoom: 4 }),
    ];
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\//);
      expect(url).not.toMatch(/javascript:|data:/i);
    }
  });

  it("rejects invalid coordinates, zooms and providers", () => {
    expect(mapEmbedUrl({ lat: 91, lng: 0 })).toBeNull();
    expect(mapEmbedUrl({ lat: 0, lng: 181 })).toBeNull();
    expect(mapEmbedUrl({ lat: Number.NaN, lng: 0 })).toBeNull();
    expect(mapEmbedUrl(PARIS, { zoom: 21 })).toBeNull();
    expect(mapEmbedUrl(PARIS, { zoom: 11.5 })).toBeNull();
    expect(mapEmbedUrl(PARIS, { provider: "bing" as MapProvider })).toBeNull();
  });
});

describe("mapLinkUrl", () => {
  it("links to OpenStreetMap with a pin at the default zoom", () => {
    expect(mapLinkUrl(PARIS)).toBe(
      "https://www.openstreetmap.org/?mlat=48.8566&mlon=2.3522#map=12/48.8566/2.3522",
    );
    expect(mapLinkUrl(ORIGIN)).toBe(
      "https://www.openstreetmap.org/?mlat=0&mlon=0#map=12/0/0",
    );
  });

  it("rejects invalid coordinates", () => {
    expect(mapLinkUrl({ lat: 90.0001, lng: 0 })).toBeNull();
    expect(mapLinkUrl({ lat: 0, lng: -181 })).toBeNull();
    expect(mapLinkUrl({ lat: Number.POSITIVE_INFINITY, lng: 0 })).toBeNull();
  });
});
