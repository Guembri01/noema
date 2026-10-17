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
    allowDuplicate: false,
    indexing: true,
    exportRestricted: false,
  })),
  revokeShareLinkAction: vi.fn(async () => ({ ok: true })),
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
  COPY_FEEDBACK_MS,
  LinkSection,
  PUBLISH_TOGGLES,
  PublishSettingsSection,
  ShareSection,
  Switch,
  publishTogglePatch,
  type PublishToggleId,
} from "./share-dialog";

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("publishTogglePatch", () => {
  it("turns one switch into exactly one single-field patch", () => {
    expect(publishTogglePatch("allowDuplicate", true)).toEqual({ allowDuplicate: true });
    expect(publishTogglePatch("indexing", false)).toEqual({ indexing: false });
    expect(publishTogglePatch("exportRestricted", true)).toEqual({ exportRestricted: true });
  });

  it("keeps each patch to a single key, never touching password or expiry", () => {
    for (const id of ["allowDuplicate", "indexing", "exportRestricted"] as const) {
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
    expect(html).toContain("rounded-md");
  });
});

describe("PublishSettingsSection", () => {
  it("renders one switch per setting with the matching aria-checked state", () => {
    const html = renderToStaticMarkup(
      createElement(PublishSettingsSection, {
        settings: { allowDuplicate: true, indexing: false, exportRestricted: true },
        onToggle: vi.fn(),
      }),
    );
    expect(count(html, 'role="switch"')).toBe(PUBLISH_TOGGLES.length);
    expect(count(html, 'aria-checked="true"')).toBe(2);
    expect(count(html, 'aria-checked="false"')).toBe(1);
    expect(html).toContain('aria-label="Search-engine indexing"');
  });

  it("carries the explanatory hint for every setting", () => {
    const html = renderToStaticMarkup(
      createElement(PublishSettingsSection, {
        settings: { allowDuplicate: false, indexing: false, exportRestricted: false },
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
        settings: { allowDuplicate: false, indexing: false, exportRestricted: false },
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
