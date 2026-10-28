import { describe, expect, it } from "vitest";
import {
  isActiveSettingsPath,
  settingsNavItems,
  settingsPath,
  settingsSectionPath,
} from "./settings-nav";

/**
 * Pure mapping behind the settings nav: the section list and the active test
 * that drives `aria-current="page"` on the live pathname.
 */

describe("settings nav mapping", () => {
  it("lists the index first (exact) and every member-reachable section", () => {
    const items = settingsNavItems("acme", "en");
    expect(items[0]).toMatchObject({ href: "/w/acme/settings", exact: true });
    expect(items.map((item) => item.href)).toEqual([
      "/w/acme/settings",
      "/w/acme/settings/billing",
      "/w/acme/settings/move",
      "/w/acme/settings/prompts",
      "/w/acme/settings/import",
      "/w/acme/settings/notifications",
      "/w/acme/settings/data",
      "/w/acme/settings/tokens",
    ]);
    // The manager-only audit log is linked from the Activity block instead.
    expect(items.some((item) => item.href.endsWith("/audit"))).toBe(false);
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.group.length).toBeGreaterThan(0);
    }
  });

  it("builds canonical paths", () => {
    expect(settingsPath("acme")).toBe("/w/acme/settings");
    expect(settingsSectionPath("acme", "tokens")).toBe("/w/acme/settings/tokens");
  });

  it("marks exactly the section you are on", () => {
    // The index is exact: it never wins on a child route.
    expect(isActiveSettingsPath("/w/acme/settings", "/w/acme/settings", true)).toBe(true);
    expect(isActiveSettingsPath("/w/acme/settings/tokens", "/w/acme/settings", true)).toBe(
      false,
    );

    // Sections match themselves and their descendants.
    expect(isActiveSettingsPath("/w/acme/settings/tokens", "/w/acme/settings/tokens")).toBe(
      true,
    );
    expect(
      isActiveSettingsPath("/w/acme/settings/tokens/extra", "/w/acme/settings/tokens"),
    ).toBe(true);

    // A sibling prefix must not match.
    expect(isActiveSettingsPath("/w/acme/settingsx", "/w/acme/settings")).toBe(false);
    expect(isActiveSettingsPath("", "/w/acme/settings")).toBe(false);
  });
});
