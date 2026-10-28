/**
 * Sidebar section visibility, kept pure so the dialog's persistence and the
 * "reset" path share one contract (and so it is testable outside the DOM).
 */

export const SIDEBAR_SECTIONS_STORAGE_KEY = "noema:sidebar-sections";

export type SidebarSectionId = "homeLinks" | "favorites" | "pages";

export type SidebarSectionVisibility = Record<SidebarSectionId, boolean>;

export const SIDEBAR_SECTIONS: readonly {
  id: SidebarSectionId;
  label: string;
  description: string;
}[] = [
  {
    id: "homeLinks",
    label: "Home shortcuts",
    description: "Home, projects, tickets and other quick links.",
  },
  {
    id: "favorites",
    label: "Favorites",
    description: "Pages and databases you starred.",
  },
  {
    id: "pages",
    label: "Pages and imports",
    description: "The private page tree and the import button.",
  },
];

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionVisibility = Object.freeze({
  homeLinks: true,
  favorites: true,
  pages: true,
});

/** Parse persisted JSON; unknown/missing keys fall back to visible. */
export function parseSidebarSections(raw: string | null): SidebarSectionVisibility {
  if (!raw) return { ...DEFAULT_SIDEBAR_SECTIONS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_SIDEBAR_SECTIONS };
    const record = value as Record<string, unknown>;
    return {
      homeLinks: record.homeLinks !== false,
      favorites: record.favorites !== false,
      pages: record.pages !== false,
    };
  } catch {
    return { ...DEFAULT_SIDEBAR_SECTIONS };
  }
}

/** Flip one section and return a fresh record. */
export function toggleSidebarSection(
  current: SidebarSectionVisibility,
  id: SidebarSectionId,
): SidebarSectionVisibility {
  return { ...current, [id]: !current[id] };
}

/** Whether any section is visible (drives the empty-state hint). */
export function hasVisibleSidebarSection(current: SidebarSectionVisibility): boolean {
  return Object.values(current).some(Boolean);
}
