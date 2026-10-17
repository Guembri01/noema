import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_NOTIFICATION_PREFS } from "@/lib/notification-prefs";

/**
 * dw09 — the notification-preferences form's pure quiet-hours validation plus a
 * `renderToStaticMarkup` pass over the real settings sections (channels,
 * per-type matrix, digest cadence, quiet hours). The server action and the Next
 * router are stubbed so the form renders without a request scope.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/server/actions/notifications", () => ({
  updateNotificationPrefs: vi.fn(async () => ({ ok: true, prefs: DEFAULT_NOTIFICATION_PREFS })),
}));

const {
  NotificationPreferencesForm,
  parseTimeOfDay,
  validateQuietHours,
  DEFAULT_QUIET_HOURS,
} = await import("@/components/notification-preferences-form");

const quiet = (overrides: Partial<typeof DEFAULT_QUIET_HOURS> = {}) => ({
  ...DEFAULT_QUIET_HOURS,
  enabled: true,
  ...overrides,
});

describe("parseTimeOfDay", () => {
  it("parses 24-hour HH:MM into minutes past midnight", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("07:00")).toBe(420);
    expect(parseTimeOfDay("22:30")).toBe(1350);
  });

  it("rejects malformed or out-of-range times", () => {
    expect(parseTimeOfDay("7:00")).toBeNull();
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("")).toBeNull();
  });
});

describe("validateQuietHours", () => {
  it("always accepts a disabled window, even with junk times", () => {
    expect(validateQuietHours({ ...DEFAULT_QUIET_HOURS, enabled: false, start: "x" })).toBeNull();
  });

  it("requires well-formed times once enabled", () => {
    expect(validateQuietHours(quiet({ start: "" }))).toBe("Enter a time as HH:MM.");
    expect(validateQuietHours(quiet({ end: "25:00" }))).toBe("Enter a time as HH:MM.");
  });

  it("rejects an empty window and accepts a distinct one (overnight allowed)", () => {
    expect(validateQuietHours(quiet({ start: "09:00", end: "09:00" }))).toBe(
      "Start and end must be different times.",
    );
    expect(validateQuietHours(quiet({ start: "22:00", end: "07:00" }))).toBeNull();
    expect(validateQuietHours(quiet({ start: "09:00", end: "17:00" }))).toBeNull();
  });
});

describe("NotificationPreferencesForm render", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationPreferencesForm, {
      initialPrefs: DEFAULT_NOTIFICATION_PREFS,
      locale: "en",
    }),
  );

  it("renders the form with tokenised settings sections", () => {
    expect(html).toContain('data-testid="notification-prefs-form"');
    expect(html).toContain("Notify me about");
    expect(html).toContain("Quiet hours");
    expect(html).toContain("Email digest");
  });

  it("adopts the Switch control for channels", () => {
    expect(html).toContain('role="switch"');
    expect(html).toContain("In-app");
  });

  it("renders the per-type matrix as Segmented controls", () => {
    expect(html).toContain('data-testid="segmented"');
    expect(html).toContain('data-testid="segmented-option-ALL"');
    expect(html).toContain('data-testid="segmented-option-NONE"');
    expect(html).toContain("Replies to my comments");
  });

  it("renders the digest cadence as a Select", () => {
    expect(html).toContain('data-testid="select-trigger"');
  });

  it("renders quiet hours as Field-wrapped time inputs", () => {
    expect(html).toContain('data-slot="field"');
    expect(html).toContain('type="time"');
  });

  it("provides a polite success live region", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
