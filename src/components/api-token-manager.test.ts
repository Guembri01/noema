import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * API-token panel — node tests.
 *
 * Pins the pure mappings that no browser is needed to exercise (scope chip hue,
 * expiry → badge tone by proximity, relative time), then statically renders the
 * presentational row, the created-token reveal and the table states. Both token
 * surfaces share `ApiTokenPanelBody`, so one body is tested for both entries.
 */

vi.mock("@/server/actions/tokens", () => ({
  createApiTokenAction: vi.fn(async () => ({ token: "noema_test" })),
  revokeApiTokenAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/server/actions/api-tokens", () => ({
  createApiTokenAction: vi.fn(async () => ({ token: "noema_scoped" })),
  revokeApiTokenAction: vi.fn(async () => ({ ok: true })),
  listApiTokensAction: vi.fn(async () => []),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { isTagHue, TAG_HUES } from "@/lib/design-tokens";
import { API_SCOPE_IDS } from "@/lib/api-token-scope";
import { ApiTokensPanel } from "./api-tokens-panel";
import {
  ApiTokenManager,
  COPY_FEEDBACK_MS,
  SCOPE_RESOURCE_HUES,
  ScopeChips,
  ScopePicker,
  TOKEN_EXPIRY_WARN_MS,
  TokenReveal,
  TokenRow,
  TokenTable,
  relativeTime,
  scopeChipLabel,
  scopeHue,
  tokenExpiryLabel,
  tokenExpiryTone,
  type ApiTokenRow,
} from "./api-token-manager";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const token = (over: Partial<ApiTokenRow> = {}): ApiTokenRow => ({
  id: "tok1",
  name: "CI deploy",
  scopes: ["read:pages", "write:databases"],
  createdAt: iso(-10 * DAY),
  lastUsedAt: iso(-2 * MINUTE),
  ...over,
});

/* ------------------------------------------------------------------ pure */

describe("scopeHue", () => {
  it("maps each resource to a distinct palette hue, read and write alike", () => {
    expect(scopeHue("read:pages")).toBe("blue");
    expect(scopeHue("write:pages")).toBe("blue");
    expect(scopeHue("write:databases")).toBe("purple");
    expect(scopeHue("read:tickets")).toBe("orange");
    expect(scopeHue("admin:workspace")).toBe("red");
  });

  it("falls back to gray for malformed or unknown scopes", () => {
    expect(scopeHue("read:unknown")).toBe("gray");
    expect(scopeHue("nonsense")).toBe("gray");
    expect(scopeHue("")).toBe("gray");
  });

  it("only ever emits a known tag hue", () => {
    for (const id of API_SCOPE_IDS) expect(isTagHue(scopeHue(id))).toBe(true);
    for (const hue of Object.values(SCOPE_RESOURCE_HUES)) {
      expect(TAG_HUES).toContain(hue);
    }
  });
});

describe("scopeChipLabel", () => {
  it("turns an action:resource id into a short human label", () => {
    expect(scopeChipLabel("read:pages")).toBe("Read pages");
    expect(scopeChipLabel("write:databases")).toBe("Write databases");
    expect(scopeChipLabel("admin:workspace")).toBe("Admin workspace");
  });

  it("passes a scope with no action:resource shape through unchanged", () => {
    expect(scopeChipLabel("garbage")).toBe("garbage");
  });
});

describe("relativeTime", () => {
  it("phrases a past instant against the injected clock", () => {
    expect(relativeTime(iso(-2 * MINUTE), NOW)).toBe("2 minutes ago");
    expect(relativeTime(iso(-3 * DAY), NOW)).toBe("3 days ago");
  });

  it("phrases a future instant", () => {
    expect(relativeTime(iso(3 * HOUR), NOW)).toBe("in 3 hours");
  });

  it("renders nothing for a missing or unparseable instant", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});

describe("tokenExpiryTone", () => {
  it("reads neutral when there is no expiry", () => {
    expect(tokenExpiryTone(null, NOW)).toBe("neutral");
    expect(tokenExpiryTone(undefined, NOW)).toBe("neutral");
    expect(tokenExpiryTone("not-a-date", NOW)).toBe("neutral");
  });

  it("grades by proximity: expired danger, near warning, else success", () => {
    expect(tokenExpiryTone(iso(-1), NOW)).toBe("danger");
    expect(tokenExpiryTone(iso(0), NOW)).toBe("danger");
    expect(tokenExpiryTone(iso(TOKEN_EXPIRY_WARN_MS), NOW)).toBe("warning");
    expect(tokenExpiryTone(iso(TOKEN_EXPIRY_WARN_MS + 1), NOW)).toBe("success");
    expect(tokenExpiryTone(iso(60 * DAY), NOW)).toBe("success");
  });
});

describe("tokenExpiryLabel", () => {
  it("is empty without an expiry, 'Expired' once past, else a short duration", () => {
    expect(tokenExpiryLabel(null, NOW)).toBe("");
    expect(tokenExpiryLabel(iso(-1), NOW)).toBe("Expired");
    expect(tokenExpiryLabel(iso(2 * DAY), NOW)).toBe("2d");
  });
});

/* ---------------------------------------------------------- presentation */

describe("renderToStaticMarkup — a token row", () => {
  it("renders name, scope chips, relative last use and a proximity expiry badge", () => {
    const html = renderToStaticMarkup(
      createElement(TokenRow, { token: token(), now: NOW, locale: "en", onRevoke: () => {} }),
    );
    expect(html).toContain('data-testid="token-row"');
    expect(html).toContain("CI deploy");
    expect(html).toContain("Read pages");
    expect(html).toContain("Write databases");
    expect(html).toContain("--tag-blue-fg");
    expect(html).toContain("--tag-purple-fg");
    expect(html).toContain("2 minutes ago");
    expect(html).toContain('aria-label="Revoke token"');
  });

  it("shows a warning expiry badge inside the warn window", () => {
    const html = renderToStaticMarkup(
      createElement(TokenRow, {
        token: token({ expiresAt: iso(3 * DAY) }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('data-testid="token-expiry"');
    expect(html).toContain('data-tone="warning"');
  });

  it("reads 'never used' and hides the badge when there is neither", () => {
    const html = renderToStaticMarkup(
      createElement(TokenRow, {
        token: token({ lastUsedAt: null, expiresAt: null, scopes: [] }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain("never used");
    expect(html).not.toContain('data-testid="token-expiry"');
    expect(html).not.toContain("--tag-");
  });

  it("marks a token without any scope as 'No access' — its grant is empty", () => {
    const html = renderToStaticMarkup(
      createElement(TokenRow, {
        token: token({ scopes: [] }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('data-testid="token-no-scopes"');
    expect(html).toContain("No access");
    expect(html).toContain('data-tone="warning"');
  });

  it("shows no 'No access' marker for a token that carries a scope", () => {
    const html = renderToStaticMarkup(
      createElement(TokenRow, {
        token: token({ scopes: ["read:pages"] }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).not.toContain('data-testid="token-no-scopes"');
    expect(html).toContain("Read pages");
  });
});

describe("renderToStaticMarkup — the scope picker", () => {
  it("warns that the token grants nothing while no scope is picked", () => {
    const html = renderToStaticMarkup(
      createElement(ScopePicker, { selected: [], onToggle: () => {}, locale: "en" }),
    );
    expect(html).toContain('data-testid="token-scope-empty-hint"');
    expect(html).toContain("No scope selected");
    expect(html).not.toContain('data-testid="token-effective-scopes"');
  });

  it("shows the effective grant instead of the hint once a scope is picked", () => {
    const html = renderToStaticMarkup(
      createElement(ScopePicker, { selected: ["write:pages"], onToggle: () => {}, locale: "en" }),
    );
    expect(html).toContain('data-testid="token-effective-scopes"');
    expect(html).toContain("Read pages");
    expect(html).not.toContain('data-testid="token-scope-empty-hint"');
  });
});

describe("renderToStaticMarkup — the created-token reveal", () => {
  it("shows the plaintext once with the copy affordance", () => {
    const html = renderToStaticMarkup(
      createElement(TokenReveal, { token: "noema_secret_value", locale: "en" }),
    );
    expect(html).toContain('data-testid="token-reveal"');
    expect(html).toContain("noema_secret_value");
    expect(html).toContain("Copy this token now");
    expect(html).toContain('aria-label="Copy token"');
  });

  it("pins the checkmark feedback window", () => {
    expect(COPY_FEEDBACK_MS).toBe(1500);
  });
});

describe("renderToStaticMarkup — table states", () => {
  it("renders an actionable empty state", () => {
    const html = renderToStaticMarkup(
      createElement(TokenTable, {
        tokens: [],
        now: NOW,
        locale: "en",
        onRevoke: () => {},
        emptyAction: createElement("button", null, "Create token"),
      }),
    );
    expect(html).toContain('data-testid="token-empty-state"');
    expect(html).toContain("No API tokens yet.");
    expect(html).toContain("Create token");
    expect(html).not.toContain('data-testid="token-list"');
  });

  it("renders a loading skeleton matching the table", () => {
    const html = renderToStaticMarkup(
      createElement(TokenTable, { tokens: [], now: NOW, locale: "en", loading: true, onRevoke: () => {} }),
    );
    expect(html).toContain('data-testid="token-table-skeleton"');
    expect(html).toContain('data-skeleton="table"');
  });

  it("renders a header and one row per token", () => {
    const html = renderToStaticMarkup(
      createElement(TokenTable, {
        tokens: [token(), token({ id: "tok2", name: "Backup" })],
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('data-testid="token-list"');
    expect((html.match(/data-testid="token-row"/g) ?? [])).toHaveLength(2);
    expect(html).toContain("Token name");
    expect(html).toContain("last used");
  });

  it("renders ScopeChips empty input as nothing", () => {
    expect(renderToStaticMarkup(createElement(ScopeChips, { scopes: [] }))).toBe("");
  });
});

/* ------------------------------------------------- consolidation checks */

describe("regression — both token surfaces survive via the shared body", () => {
  it("ApiTokenManager still exports and renders its own section", () => {
    const html = renderToStaticMarkup(
      createElement(ApiTokenManager, { tokens: [token()], locale: "en", now: NOW }),
    );
    expect(html).toContain('data-testid="api-token-manager"');
    expect(html).toContain("API tokens");
    expect(html).toContain('data-testid="token-scope-picker"');
    expect(html).toContain("CI deploy");
  });

  it("ApiTokensPanel keeps its data-testid and renders the same body", () => {
    const html = renderToStaticMarkup(
      createElement(ApiTokensPanel, {
        initialTokens: [
          {
            id: "tok1",
            name: "CI deploy",
            scopes: ["read:pages"],
            createdAt: iso(-DAY),
            lastUsedAt: null,
          },
        ],
        locale: "en",
        now: NOW,
      }),
    );
    expect(html).toContain('data-testid="api-tokens-panel"');
    expect(html).toContain('data-testid="token-scope-picker"');
    expect(html).toContain("Read pages");
  });
});
