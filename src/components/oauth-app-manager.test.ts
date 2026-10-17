import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * OAuth app manager — node tests.
 *
 * The pure mappings (scope chips, URI parsing/validation, default scopes) plus
 * a `renderToStaticMarkup` pass over an app card, the create/edit form and the
 * list's loading / empty / error / populated states. No DOM.
 */

vi.mock("@/server/actions/oauth-apps", () => ({
  createOAuthAppAction: vi.fn(async () => ({
    clientId: "noema_abc",
    clientSecret: "shh",
  })),
  deleteOAuthAppAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  DEFAULT_OAUTH_SCOPES,
  OAUTH_APP_LABELS,
  OAUTH_SCOPES,
  OAuthAppCard,
  OAuthAppForm,
  OAuthAppList,
  ScopeTags,
  invalidRedirectUris,
  isOAuthScopeId,
  isValidRedirectUri,
  parseRedirectUris,
  redirectUriError,
  sanitizeScopes,
  scopeMeta,
  scopesForApp,
  toggleScope,
  type OAuthScopeId,
} from "./oauth-app-manager";

const h = createElement;

const APP = {
  id: "app_1",
  name: "Reporting",
  clientId: "noema_reporting",
  redirectUris: ["https://example.com/callback", "https://example.com/alt"],
  scopes: ["read", "comments"],
};

describe("scope chip list", () => {
  it("ships a stable catalogue with token hues", () => {
    expect(OAUTH_SCOPES.map((scope) => scope.id)).toEqual([
      "read",
      "write",
      "comments",
      "admin",
    ]);
    for (const scope of OAUTH_SCOPES) {
      expect(scope.hue).toBeTruthy();
      expect(scope.label.trim()).not.toBe("");
    }
    expect(scopeMeta("admin").hue).toBe("red");
    expect(scopeMeta("read").hue).toBe("blue");
  });

  it("guards unknown scope ids", () => {
    expect(isOAuthScopeId("read")).toBe(true);
    expect(isOAuthScopeId("delete")).toBe(false);
    expect(isOAuthScopeId(null)).toBe(false);
  });

  it("toggles one scope and keeps catalogue order", () => {
    expect(toggleScope(["read"], "admin")).toEqual(["read", "admin"]);
    expect(toggleScope(["read", "admin"], "read")).toEqual(["admin"]);
    // Order is always the catalogue's, regardless of insertion order.
    expect(toggleScope(["comments"], "read")).toEqual(["read", "comments"]);
  });

  it("sanitizes a persisted list: known only, de-duplicated, ordered", () => {
    expect(sanitizeScopes(["admin", "nope", "read", "admin"])).toEqual([
      "read",
      "admin",
    ]);
    expect(sanitizeScopes(null)).toEqual([]);
    expect(sanitizeScopes(undefined)).toEqual([]);
  });

  it("falls back to the default scopes when an app carries none", () => {
    expect(scopesForApp({})).toEqual([...DEFAULT_OAUTH_SCOPES]);
    expect(scopesForApp({ scopes: [] })).toEqual([...DEFAULT_OAUTH_SCOPES]);
    expect(scopesForApp({ scopes: ["write"] })).toEqual(["write"]);
  });
});

describe("redirect URI parsing", () => {
  it("splits on commas and whitespace and trims", () => {
    expect(parseRedirectUris("https://a.test/cb, https://b.test/cb")).toEqual([
      "https://a.test/cb",
      "https://b.test/cb",
    ]);
    expect(parseRedirectUris("  https://a.test/cb\nhttps://b.test/cb  ")).toEqual([
      "https://a.test/cb",
      "https://b.test/cb",
    ]);
    expect(parseRedirectUris("   ")).toEqual([]);
  });

  it("validates absolute URLs", () => {
    expect(isValidRedirectUri("https://a.test/cb")).toBe(true);
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isValidRedirectUri("not a url")).toBe(false);
    expect(isValidRedirectUri("/relative")).toBe(false);
    expect(invalidRedirectUris("https://a.test/cb nope")).toEqual(["nope"]);
  });

  it("reports the first blocking problem", () => {
    expect(redirectUriError("")).toBe("Add at least one redirect URI.");
    expect(redirectUriError("https://a.test/cb")).toBeNull();
    expect(redirectUriError("https://a.test/cb nope")).toBe(
      "Invalid redirect URI: nope",
    );
  });
});

describe("ScopeTags", () => {
  it("renders one tag per scope with a stable data attribute", () => {
    const html = renderToStaticMarkup(
      h(ScopeTags, { scopes: ["read", "admin"] as OAuthScopeId[], label: "Scopes" }),
    );
    expect(html).toContain("Scopes");
    expect((html.match(/data-scope=/g) ?? []).length).toBe(2);
    expect(html).toContain('data-scope="read"');
    expect(html).toContain('data-scope="admin"');
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("tag tag-red");
  });
});

describe("OAuthAppCard", () => {
  it("shows the name, client id, redirect URIs and scope tags", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppCard, { app: APP, onCopy: () => {} }),
    );
    expect(html).toContain('data-testid="oauth-app-card"');
    expect(html).toContain("Reporting");
    expect(html).toContain("noema_reporting");
    expect(html).toContain("https://example.com/callback");
    expect(html).toContain("https://example.com/alt");
    expect(html).toContain(OAUTH_APP_LABELS.clientId);
    // Scopes render as tags.
    expect(html).toContain('data-scope="read"');
    expect(html).toContain('data-scope="comments"');
    // Edit + delete affordances are labelled.
    expect(html).toContain(`aria-label="${OAUTH_APP_LABELS.edit}"`);
    expect(html).toContain(`aria-label="${OAUTH_APP_LABELS.delete}"`);
  });

  it("shows the checkmark on the client id once copied", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppCard, {
        app: APP,
        copied: APP.clientId,
        onCopy: () => {},
      }),
    );
    expect(html).toContain('data-copied="true"');
    expect(html).toContain(`aria-label="${OAUTH_APP_LABELS.copied}"`);
  });

  it("stays token-only (no raw hex)", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppCard, { app: APP, onCopy: () => {} }),
    );
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("OAuthAppForm", () => {
  const base = {
    name: "Reporting",
    uris: "https://example.com/callback",
    scopes: ["read"] as OAuthScopeId[],
    onNameChange: () => {},
    onUrisChange: () => {},
    onScopesChange: () => {},
    onSubmit: () => {},
    onCancel: () => {},
  };

  it("renders the name field, the URI field and one checkbox per scope", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppForm, { ...base, mode: "create" }),
    );
    expect(html).toContain('data-testid="oauth-app-form"');
    expect(html).toContain(OAUTH_APP_LABELS.name);
    expect(html).toContain(OAUTH_APP_LABELS.uris);
    expect((html.match(/role="checkbox"/g) ?? []).length).toBe(OAUTH_SCOPES.length);
    // Exactly one scope is checked (read).
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect(html).toContain(OAUTH_APP_LABELS.create);
  });

  it("switches the primary action to Save in edit mode", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppForm, { ...base, mode: "edit" }),
    );
    expect(html).toContain(OAUTH_APP_LABELS.save);
    expect(html).not.toContain(OAUTH_APP_LABELS.create);
  });

  it("flags an invalid redirect URI with the danger ring + message", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppForm, { ...base, mode: "create", uris: "nope" }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid redirect URI: nope");
    expect(html).toContain("border-danger");
  });
});

describe("OAuthAppList states", () => {
  it("loading: renders card skeletons matching the layout", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppList, { apps: [], loading: true, onCopy: () => {} }),
    );
    expect(html).toContain('data-testid="oauth-apps-loading"');
    expect((html.match(/data-skeleton="card"/g) ?? []).length).toBe(2);
  });

  it("empty: renders an actionable EmptyState", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppList, { apps: [], onCopy: () => {}, onCreate: () => {} }),
    );
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain(OAUTH_APP_LABELS.emptyTitle);
    expect(html).toContain(OAUTH_APP_LABELS.emptyHint);
    expect(html).toContain(OAUTH_APP_LABELS.create);
  });

  it("error: renders the message with a retry", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppList, {
        apps: [],
        error: "Boom",
        onCopy: () => {},
        onRetry: () => {},
      }),
    );
    expect(html).toContain('data-testid="oauth-apps-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Boom");
    expect(html).toContain(OAUTH_APP_LABELS.retry);
    expect(html).toContain("text-danger");
  });

  it("populated: renders one card per app", () => {
    const html = renderToStaticMarkup(
      h(OAuthAppList, {
        apps: [APP, { ...APP, id: "app_2", name: "Second" }],
        onCopy: () => {},
      }),
    );
    expect(html).toContain('data-testid="oauth-app-list"');
    expect((html.match(/data-testid="oauth-app-card"/g) ?? []).length).toBe(2);
    expect(html).toContain("Second");
  });
});
