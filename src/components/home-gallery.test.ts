import { describe, expect, it, vi } from "vitest";

/**
 * DS20 — home gallery template styling.
 *
 * The accent → preview mapping is pure and pinned here: every accent resolves
 * to a token gradient / border (never a raw hex), an unknown accent falls back
 * to gray, and the mini-layout follows the template's grouping.
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
  it("builds a token gradient + border for every accent", () => {
    expect(GALLERY_ACCENTS).toHaveLength(8);
    for (const accent of GALLERY_ACCENTS) {
      const preview = templatePreview(accent, "Status");
      expect(preview.accent).toBe(accent);
      expect(preview.gradient).toContain(`var(--tag-${accent}-bg)`);
      expect(preview.gradient).toContain("var(--surface-2)");
      expect(preview.border).toBe(`var(--tag-${accent}-bd)`);
      // tokens only: no raw hex anywhere
      expect(preview.gradient).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(preview.border).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
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
