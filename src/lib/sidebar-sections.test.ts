import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_SECTIONS,
  hasVisibleSidebarSection,
  parseSidebarSections,
  toggleSidebarSection,
} from "./sidebar-sections";

describe("sidebar section visibility", () => {
  it("shows every section by default", () => {
    expect(parseSidebarSections(null)).toEqual(DEFAULT_SIDEBAR_SECTIONS);
    expect(hasVisibleSidebarSection(DEFAULT_SIDEBAR_SECTIONS)).toBe(true);
  });

  it("reads persisted false values and defaults missing keys to visible", () => {
    expect(parseSidebarSections('{"favorites":false}')).toEqual({
      homeLinks: true,
      favorites: false,
      pages: true,
    });
  });

  it("fails closed to the defaults on malformed input", () => {
    expect(parseSidebarSections("{")).toEqual(DEFAULT_SIDEBAR_SECTIONS);
    expect(parseSidebarSections("null")).toEqual(DEFAULT_SIDEBAR_SECTIONS);
  });

  it("toggles one section without mutating the input", () => {
    const next = toggleSidebarSection(DEFAULT_SIDEBAR_SECTIONS, "pages");
    expect(next.pages).toBe(false);
    expect(DEFAULT_SIDEBAR_SECTIONS.pages).toBe(true);
  });

  it("reports when every section is hidden", () => {
    expect(
      hasVisibleSidebarSection({ homeLinks: false, favorites: false, pages: false }),
    ).toBe(false);
  });
});
