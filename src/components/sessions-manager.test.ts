import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Sessions panel — node tests.
 *
 * Pins the pure mappings behind the device list (the parsed device/browser
 * label, the status → badge tone map, the expiry view) and statically renders a
 * session row in its current / expired and plain variants.
 */

vi.mock("@/server/actions/auth-sessions", () => ({
  revokeSessionAction: vi.fn(async () => ({ ok: true, signedOut: false })),
  revokeAllSessionsAction: vi.fn(async () => ({ ok: true, revoked: 1, signedOut: true })),
}));
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

import {
  SESSION_STATUSES,
  SessionList,
  SessionListItem,
  SessionsManager,
  isSessionStatus,
  sessionDeviceLabel,
  sessionExpiry,
  sessionStatus,
  sessionStatusTone,
  type SessionRow,
} from "./sessions-manager";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  sid: "s1",
  device: null,
  createdAt: iso(-3 * DAY),
  lastActiveAt: iso(-2 * MINUTE),
  current: false,
  userAgent: CHROME_WINDOWS,
  ip: "203.0.113.7",
  ...over,
});

/* ------------------------------------------------------------------ pure */

describe("isSessionStatus / sessionStatusTone", () => {
  it("accepts the four statuses and rejects everything else", () => {
    for (const status of SESSION_STATUSES) expect(isSessionStatus(status)).toBe(true);
    expect(isSessionStatus("offline")).toBe(false);
    expect(isSessionStatus(null)).toBe(false);
    expect(isSessionStatus(3)).toBe(false);
  });

  it("maps active to success, idle to warning, expired/revoked to danger", () => {
    expect(sessionStatusTone("active")).toBe("success");
    expect(sessionStatusTone("idle")).toBe("warning");
    expect(sessionStatusTone("expired")).toBe("danger");
    expect(sessionStatusTone("revoked")).toBe("danger");
    expect(sessionStatusTone(null)).toBe("neutral");
    expect(sessionStatusTone("nope")).toBe("neutral");
  });
});

describe("sessionDeviceLabel", () => {
  it("prefers the stored label over re-parsing", () => {
    expect(sessionDeviceLabel({ device: "Firefox on macOS", userAgent: CHROME_WINDOWS })).toBe(
      "Firefox on macOS",
    );
  });

  it("parses a browser/OS label from the raw user-agent", () => {
    expect(sessionDeviceLabel({ device: null, userAgent: CHROME_WINDOWS })).toBe(
      "Chrome on Windows",
    );
    expect(sessionDeviceLabel({ device: "  ", userAgent: CHROME_WINDOWS })).toBe(
      "Chrome on Windows",
    );
  });

  it("returns null when nothing can be described", () => {
    expect(sessionDeviceLabel({})).toBeNull();
    expect(sessionDeviceLabel({ device: null, userAgent: "totally unrecognisable" })).toBeNull();
  });
});

describe("sessionStatus", () => {
  it("prefers an explicit status", () => {
    expect(sessionStatus({ status: "revoked" }, NOW)).toBe("revoked");
    expect(sessionStatus({ status: "idle" }, NOW)).toBe("idle");
  });

  it("derives expired from a past deadline and ignores a future one", () => {
    expect(sessionStatus({ status: "bogus", expiresAt: iso(-1) }, NOW)).toBe("expired");
    expect(sessionStatus({ expiresAt: iso(HOUR) }, NOW)).toBeNull();
    expect(sessionStatus({}, NOW)).toBeNull();
  });

  it("only shows explicit statuses before the clock is known", () => {
    expect(sessionStatus({ expiresAt: iso(-1) }, null)).toBeNull();
    expect(sessionStatus({ status: "expired" }, null)).toBe("expired");
  });
});

describe("sessionExpiry", () => {
  it("reports the remaining window and whether to warn", () => {
    expect(
      sessionExpiry(session({ expiresAt: iso(2 * HOUR) }), NOW),
    ).toEqual({ remaining: 2 * HOUR, warn: true });
  });

  it("returns null without a parseable deadline", () => {
    expect(sessionExpiry(session({ expiresAt: null }), NOW)).toBeNull();
    expect(sessionExpiry(session({ expiresAt: "not-a-date" }), NOW)).toBeNull();
  });
});

/* ---------------------------------------------------------- presentation */

describe("renderToStaticMarkup — a session row", () => {
  it("renders the parsed device label, IP and relative last activity", () => {
    const html = renderToStaticMarkup(
      createElement(SessionListItem, { session: session(), now: NOW, locale: "en", onRevoke: () => {} }),
    );
    expect(html).toContain('data-testid="session-row"');
    expect(html).toContain("Chrome on Windows");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain("2 minutes ago");
    expect(html).toContain('aria-label="Revoke session"');
  });

  it("badges an expired session with the danger tone", () => {
    const html = renderToStaticMarkup(
      createElement(SessionListItem, {
        session: session({ status: "expired", expiresAt: iso(-1) }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('data-testid="session-status-badge"');
    expect(html).toContain("Expired");
    expect(html).toContain('data-tone="danger"');
  });

  it("badges a signed-out session", () => {
    const html = renderToStaticMarkup(
      createElement(SessionListItem, {
        session: session({ status: "revoked" }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain("Signed out");
    expect(html).toContain('data-tone="danger"');
  });

  it("marks the current session and offers no revoke for it", () => {
    const html = renderToStaticMarkup(
      createElement(SessionListItem, {
        session: session({ current: true, expiresAt: iso(6 * HOUR) }),
        now: NOW,
        locale: "en",
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('data-testid="session-current-badge"');
    expect(html).toContain("This device");
    expect(html).not.toContain('data-testid="session-revoke"');
    expect(html).toContain("expires");
  });
});

describe("renderToStaticMarkup — list and panel states", () => {
  it("renders a loading skeleton", () => {
    const html = renderToStaticMarkup(
      createElement(SessionList, { sessions: [], now: NOW, locale: "en", loading: true, onRevoke: () => {} }),
    );
    expect(html).toContain('data-testid="sessions-skeleton"');
  });

  it("renders an empty state", () => {
    const html = renderToStaticMarkup(
      createElement(SessionList, { sessions: [], now: NOW, locale: "en", onRevoke: () => {} }),
    );
    expect(html).toContain('data-testid="sessions-empty"');
    expect(html).toContain("No signed-in devices to show.");
  });

  it("SessionsManager renders the section, rows and the danger revoke-all", () => {
    const html = renderToStaticMarkup(
      createElement(SessionsManager, {
        sessions: [session({ current: true }), session({ sid: "s2" })],
        locale: "en",
        now: NOW,
      }),
    );
    expect(html).toContain('data-testid="sessions-section"');
    expect(html).toContain('data-testid="sessions-list"');
    expect(html).toContain('data-testid="revoke-all-sessions"');
    expect(html).toContain("Sign out of all sessions");
  });
});
