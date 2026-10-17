import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GALLERY_SECTIONS, galleryCoveredFiles } from "./gallery-manifest";

/**
 * Completeness test for the internal design gallery (`/dev/ui`).
 *
 * The whole point of the gallery is that it cannot drift: if a primitive is
 * added to `src/components/ui/`, this test fails until a section in
 * `gallery-manifest.ts` claims it (and therefore renders it on screen). It also
 * fails if the manifest names a file that no longer exists.
 *
 * No DOM: it reads the filesystem and the page source, so the node test
 * environment is enough.
 */

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(here, "../../../components/ui");

/** Every primitive source file, as a basename without the `.tsx` extension. */
function primitiveFiles(): string[] {
  return readdirSync(uiDir)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => name.slice(0, -".tsx".length))
    .sort();
}

describe("design gallery completeness", () => {
  it("covers every primitive in src/components/ui", () => {
    const onDisk = primitiveFiles();
    const covered = galleryCoveredFiles();

    expect(onDisk.length).toBeGreaterThan(0);
    // Set equality, so a missing entry and a stale entry both fail loudly.
    expect(covered).toEqual(onDisk);
  });

  it("claims no file twice (one owning section per primitive)", () => {
    const claimed = GALLERY_SECTIONS.flatMap((section) => section.files);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("has a unique id and at least one token per section", () => {
    const ids = GALLERY_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of GALLERY_SECTIONS) {
      expect(section.files.length).toBeGreaterThan(0);
      expect(section.tokens.length).toBeGreaterThan(0);
    }
  });

  it("renders the manifest in the gallery component", () => {
    const gallery = readFileSync(join(here, "design-gallery.tsx"), "utf8");
    expect(gallery).toContain("GALLERY_SECTIONS");
    expect(gallery).toContain("galleryCoveredFiles");
  });

  it("guards the route so it can never ship in production", () => {
    const page = readFileSync(join(here, "page.tsx"), "utf8");
    expect(page).toContain('process.env.NODE_ENV !== "production"');
    expect(page).toContain("notFound()");
    expect(page).toContain("DesignGallery");
  });

  it("renders every section the manifest lists", () => {
    const gallery = readFileSync(join(here, "design-gallery.tsx"), "utf8");
    // The content map is an exhaustive `Record<GallerySectionId, …>` (tsc
    // enforces every id is present) and the render loop reads it by id.
    expect(gallery).toContain("Record<GallerySectionId, ReactNode>");
    expect(gallery).toContain("content[section.id]");
  });
});
