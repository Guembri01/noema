import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * DS20 — home gallery template styling.
 *
 * The accent → preview mapping is pure and pinned here: every accent resolves
 * to a token gradient (never a raw hex, and never a tag-coloured edge), an
 * unknown accent falls back to gray, and the mini-layout follows the template's
 * grouping.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/w/demo",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/server/actions/home-templates", () => ({
  createBlockTemplateAction: vi.fn(),
  createGalleryTemplateAction: vi.fn(),
  createQuickStartAction: vi.fn(),
  instantiateWorkspaceTemplateAction: vi.fn(),
  listWorkspaceTemplatesAction: vi.fn(async () => ({ ok: true, templates: [] })),
}));

import {
  GALLERY_ACCENTS,
  GALLERY_TEMPLATE_SKELETONS,
  isGalleryAccent,
  quickStartKinds,
  templatePreview,
  templatePreviewShape,
} from "./home-gallery";
import { GALLERY_TEMPLATES } from "@/lib/workflow-templates";

describe("templatePreview", () => {
  it("builds a token gradient for every accent, with no accent edge", () => {
    expect(GALLERY_ACCENTS).toHaveLength(8);
    for (const accent of GALLERY_ACCENTS) {
      const preview = templatePreview(accent, "Status");
      expect(preview.accent).toBe(accent);
      expect(preview.gradient).toContain(`var(--tag-${accent}-bg)`);
      expect(preview.gradient).toContain("var(--surface-2)");
      // The preview is tinted, never outlined: a tag-coloured border would make
      // the card read as a selected surface.
      expect(preview).not.toHaveProperty("border");
      // tokens only: no raw hex anywhere
      expect(preview.gradient).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("paints no tag-coloured edge in the gallery source", () => {
    const source = readFileSync(new URL("./home-gallery.tsx", import.meta.url), "utf8");
    // `-bd` is the tag-edge token suffix, `border-accent` the interactive
    // accent: the gallery preview must emit neither.
    expect(source).not.toMatch(/-bd\b/);
    expect(source).not.toMatch(/border-accent|border-primary/);
  });

  it("falls back to gray for an unknown accent", () => {
    const preview = templatePreview("chartreuse", null);
    expect(preview.accent).toBe("gray");
    expect(preview.gradient).toContain("var(--tag-gray-bg)");
  });
});

describe("templatePreviewShape", () => {
  it("draws a board only when the template groups by a property", () => {
    expect(templatePreviewShape("Status")).toBe("board");
    expect(templatePreviewShape(null)).toBe("table");
    expect(templatePreviewShape(undefined)).toBe("table");
    expect(templatePreviewShape("")).toBe("table");
  });

  it("reflects each gallery template's grouping", () => {
    for (const template of GALLERY_TEMPLATES) {
      expect(templatePreview(template.accent, template.boardBy).shape).toBe(
        template.boardBy ? "board" : "table",
      );
    }
  });
});

describe("isGalleryAccent + quickStartKinds", () => {
  it("guards the accent union", () => {
    for (const accent of GALLERY_ACCENTS) expect(isGalleryAccent(accent)).toBe(true);
    expect(isGalleryAccent("chartreuse")).toBe(false);
    expect(isGalleryAccent(null)).toBe(false);
  });

  it("offers exactly the two quick-start kinds", () => {
    expect(quickStartKinds()).toEqual(["page", "database"]);
    expect(GALLERY_TEMPLATE_SKELETONS).toBeGreaterThan(0);
  });
});
