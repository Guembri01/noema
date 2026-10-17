import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B54 — the meetings tab of the sidebar.
 *
 * Subscribing a calendar is a workspace-wide write the server refuses for a
 * guest (`canEditContent`), so the sidebar must not offer the door to it: the
 * empty state a guest sees carries no "connect" button and no paste form.
 */

vi.mock("@/server/actions/calendar", () => ({
  connectCalendarFeedAction: vi.fn(),
  createMeetingNoteAction: vi.fn(),
  disconnectCalendarFeedAction: vi.fn(),
  refreshCalendarFeedsAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { SidebarMeetings } from "./sidebar-meetings";

const render = (role: string) =>
  renderToStaticMarkup(
    createElement(SidebarMeetings, {
      workspaceId: "ws1",
      slug: "acme",
      events: [],
      feeds: [],
      locale: "en",
      role,
    }),
  );

describe("SidebarMeetings — a guest", () => {
  it("offers no way to subscribe a calendar", () => {
    const html = render("GUEST");

    expect(html).not.toContain("Connect a calendar");
    expect(html).not.toContain("Paste an iCalendar (ICS) URL");
    expect(html).not.toContain("Connect calendar");
  });

  it("still renders the empty state", () => {
    const html = render("GUEST");

    expect(html).toContain("No calendar connected yet.");
  });
});

describe("SidebarMeetings — everybody else", () => {
  it("offers the subscribe form", () => {
    const html = render("MEMBER");

    expect(html).toContain("Connect a calendar");
    expect(html).toContain("Paste an iCalendar (ICS) URL");
  });
});
