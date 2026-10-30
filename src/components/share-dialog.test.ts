import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The share panel has two halves worth pinning without a browser: the pure
 * "switch state → single-field patch" mapping, and the presentational sections
 * the panel is built from. Radix's portal renders nothing on the server, so
 * `renderToStaticMarkup` of the individual sections is the live check that the
 * copy, link and publish chrome actually reaches the DOM.
 */

vi.mock("@/server/actions/share", () => ({
  createShareLinkAction: vi.fn(async () => ({ url: "/s/abc" })),
  getShareLinkStateAction: vi.fn(async () => ({
    published: false,
    token: null,
    allowEditing: false,
    hasPassword: false,
    expiresAt: null,
    indexing: true,
  })),
  revokeShareLinkAction: vi.fn(async () => ({ ok: true, removed: 0 })),
}));
vi.mock("@/server/actions/page-permissions", () => ({
  listPagePermissionsAction: vi.fn(async () => []),
  setPagePermissionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  generateShortCode,
  isValidShortCode,
  SHORT_CODE_LENGTH,
  shortUrl,
} from "@/lib/short-link";
import {
  COPY_FEEDBACK_MS,
  LinkSecuritySection,
  LinkSection,
  PUBLISH_TOGGLES,
  PublishSettingsSection,
  ShareSection,
  Switch,
  linkSecurityPatch,
  publishTogglePatch,
  type LinkSecurityIntent,
  type PublishToggleId,
} from "./share-dialog";

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("PUBLISH_TOGGLES", () => {
  it("offers only the settings the public share page can honour", () => {
    expect(PUBLISH_TOGGLES.map((toggle) => toggle.id)).toEqual(["indexing"]);
  });

  it("promises nothing the public share page does not do", () => {
    // The public page offers no export and no "copy into my workspace": the
    // switches that promised them were removed rather than left lying (B36).
    for (const toggle of PUBLISH_TOGGLES) {
      expect(toggle.hint).not.toMatch(/export|duplicate|copy the published/i);
    }
  });
});

describe("publishTogglePatch", () => {
  it("turns one switch into exactly one single-field patch", () => {
    expect(publishTogglePatch("indexing", true)).toEqual({ indexing: true });
  });

  it("keeps each patch to a single key, never touching password or expiry", () => {
    for (const id of PUBLISH_TOGGLES.map((toggle) => toggle.id)) {
      const patch = publishTogglePatch(id, true);
      expect(Object.keys(patch)).toEqual([id]);
      expect(patch).not.toHaveProperty("allowEditing");
    }
  });

  it("rejects an unknown id with an empty patch", () => {
    expect(publishTogglePatch("nope" as PublishToggleId, true)).toEqual({});
  });

  it("pins the copy success feedback window", () => {
    expect(COPY_FEEDBACK_MS).toBe(1500);
  });
});

describe("ShareSection", () => {
  it("renders its title, hint and children inside the card shell", () => {
    const html = renderToStaticMarkup(
      createElement(ShareSection, { title: "General access", hint: "Hint text" }, "body"),
    );
    expect(html).toContain("General access");
    expect(html).toContain("Hint text");
    expect(html).toContain("body");
    expect(html).toContain("rounded-card");
  });
});

describe("PublishSettingsSection", () => {
  it("renders one switch per setting with the matching aria-checked state", () => {
    const html = renderToStaticMarkup(
      createElement(PublishSettingsSection, {
        settings: { indexing: true },
        onToggle: vi.fn(),
      }),
    );
    expect(count(html, 'role="switch"')).toBe(PUBLISH_TOGGLES.length);
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(count(html, 'aria-checked="false"')).toBe(0);
    expect(html).toContain('aria-label="Search-engine indexing"');
  });

  it("carries the explanatory hint for every setting", () => {
    const html = renderToStaticMarkup(
      createElement(PublishSettingsSection, {
        settings: { indexing: false },
        onToggle: vi.fn(),
      }),
    );
    for (const toggle of PUBLISH_TOGGLES) {
      expect(html).toContain(toggle.label);
      expect(html).toContain(toggle.hint);
    }
  });

  it("disables every switch while a change is pending", () => {
    const html = renderToStaticMarkup(
      createElement(PublishSettingsSection, {
        settings: { indexing: false },
        pending: true,
        onToggle: vi.fn(),
      }),
    );
    expect(count(html, "disabled")).toBe(PUBLISH_TOGGLES.length);
  });
});

describe("Switch", () => {
  it("is a labelled switch button reflecting its checked state", () => {
    const on = renderToStaticMarkup(
      createElement(Switch, { checked: true, label: "Indexing", onCheckedChange: vi.fn() }),
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('type="button"');

    const off = renderToStaticMarkup(
      createElement(Switch, { checked: false, label: "Indexing", onCheckedChange: vi.fn() }),
    );
    expect(off).toContain('aria-checked="false"');
  });
});

/**
 * P3-T01 — the live link's password and expiry used to be frozen: the publish
 * form (the only place either was set) is hidden once the link exists. These
 * pins cover the intent→patch mapping and the rendered clea/replace affordances
 * of the new settings section.
 */
describe("linkSecurityPatch (P3-T01)", () => {
  it("maps one security intent to exactly one explicit patch key", () => {
    expect(linkSecurityPatch("clearPassword")).toEqual({ clearPassword: true });
    expect(linkSecurityPatch("clearExpiry")).toEqual({ clearExpiry: true });
    expect(linkSecurityPatch("setPassword", { password: "s3cret" })).toEqual({
      password: "s3cret",
    });
    expect(linkSecurityPatch("setExpiry", { expiresInDays: 7 })).toEqual({
      expiresInDays: 7,
    });
  });

  it("patches nothing for a set intent without a usable value", () => {
    expect(linkSecurityPatch("setPassword", {})).toEqual({});
    expect(linkSecurityPatch("setPassword", { password: "   " })).toEqual({});
    expect(linkSecurityPatch("setExpiry", { expiresInDays: 0 })).toEqual({});
    expect(linkSecurityPatch("setExpiry", { expiresInDays: -3 })).toEqual({});
  });

  it("never smuggles an unrelated field onto the wire", () => {
    // Each intent is exactly one key; provided set values ride on that key
    // and nothing else (no allowEditing, no indexing, no stray fields).
    const expectedKeys: Record<LinkSecurityIntent, string[]> = {
      setPassword: ["password"],
      clearPassword: ["clearPassword"],
      setExpiry: ["expiresInDays"],
      clearExpiry: ["clearExpiry"],
    };
    for (const intent of Object.keys(expectedKeys) as LinkSecurityIntent[]) {
      const patch = linkSecurityPatch(intent, { password: "p", expiresInDays: 7 });
      expect({ intent, keys: Object.keys(patch).sort() }).toEqual({
        intent,
        keys: expectedKeys[intent],
      });
    }
  });
});

describe("LinkSecuritySection (P3-T01)", () => {
  it("offers clearing a set password and replacing it", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: true,
        expiresAt: null,
        onUpdate: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Remove password"');
    expect(html).toContain('aria-label="Update password"');
    expect(html).toContain("Password-protected");
    expect(html).not.toContain('aria-label="Add password"');
  });

  it("offers adding a password when none is set", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: false,
        expiresAt: null,
        onUpdate: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Add password"');
    expect(html).toContain("No password");
    expect(html).not.toContain("Remove password");
  });

  it("offers clearing a set expiry and shows when the link expires", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: false,
        expiresAt: "2026-12-01T00:00:00Z",
        onUpdate: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Remove expiry"');
    expect(html).toContain('aria-label="Update expiry"');
    expect(html).toContain("Expiring link");
    expect(html).toContain("2026");
    expect(html).not.toContain('aria-label="Add expiry"');
  });

  it("offers adding an expiry when the link never expires", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: false,
        expiresAt: null,
        onUpdate: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Add expiry"');
    expect(html).toContain("Never expires");
    expect(html).not.toContain("Remove expiry");
  });

  it("disables its controls while a change is pending", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: true,
        expiresAt: "2026-12-01T00:00:00Z",
        pending: true,
        onUpdate: vi.fn(),
      }),
    );
    // All four action buttons render and are locked while pending.
    for (const label of ["Remove password", "Update password", "Remove expiry", "Update expiry"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('type="password"');
    // Inputs stay editable; only the four actions disable, so a draft
    // survives a slow roundtrip. (`disabled=""` per button — the class list
    // alone mentions the word more often.)
    expect(count(html, 'disabled=""')).toBe(4);
  });

  it("carries typed password inputs on both rows", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSecuritySection, {
        hasPassword: false,
        expiresAt: null,
        onUpdate: vi.fn(),
      }),
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('type="number"');
  });
});

describe("LinkSection", () => {
  it("shows the public link, the short link and a copy affordance for each", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSection, {
        url: "https://noema.test/s/public-token",
        shortUrl: "https://noema.test/s/XyZ",
        shortCode: "XyZ",
      }),
    );
    expect(html).toContain('value="https://noema.test/s/public-token"');
    expect(html).toContain('value="https://noema.test/s/XyZ"');
    expect(html).toContain("XyZ");
    expect(count(html, ">Copy</span>")).toBe(2);
  });

  it("hides the short-link row when no short code is available", () => {
    const html = renderToStaticMarkup(
      createElement(LinkSection, { url: "https://noema.test/s/only", shortUrl: null }),
    );
    expect(html).toContain('value="https://noema.test/s/only"');
    expect(count(html, ">Copy</span>")).toBe(1);
  });
});

/* ------------------------------------------------------------------ public page */

// The pure public-page model moved to `@/lib/share-page` (a client module cannot
// export a function a server component may call). Its own spec lives there.

/**
 * P1-T02 — the "Link" row advertises the deterministic short code derived from
 * the page id; `/s/<code>` now resolves it (the public page keeps a unique,
 * indexed alias per page). These pins keep the dialog on its seed: same page
 * id → same valid code, same URL shape, every render.
 */
describe("the deterministic short link (P1-T02)", () => {
  it("derives the same valid code from a page id on every render", () => {
    const first = generateShortCode({ seed: "page-1" });
    const second = generateShortCode({ seed: "page-1" });

    expect(second).toBe(first);
    expect(first).toBe("FDfpLNM");
    expect(first.length).toBe(SHORT_CODE_LENGTH);
    expect(isValidShortCode(first)).toBe(true);
  });

  it("pins the exact long-lived URL the dialog hands out and the resolver honours", () => {
    const code = generateShortCode({ seed: "page-1" });

    expect(shortUrl("https://noema.test/s", code)).toBe(
      `https://noema.test/s/${code}`,
    );
    expect(isValidShortCode(code)).toBe(true);
  });

  it("renders the deterministic short URL, not a session token", () => {
    const code = generateShortCode({ seed: "page-1" });
    const html = renderToStaticMarkup(
      createElement(LinkSection, {
        url: "https://noema.test/s/public-token",
        shortUrl: `https://noema.test/s/${code}`,
        shortCode: code,
      }),
    );

    expect(html).toContain(`value="https://noema.test/s/${code}"`);
    expect(html).toContain(code);
  });
});
