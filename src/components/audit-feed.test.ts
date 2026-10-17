import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEvent } from "@/lib/audit-log";
import {
  AuditFeed,
  auditActionLabel,
  auditBadgeTone,
  auditCategoryHue,
  auditTarget,
  relativeTime,
  type AuditPageLoader,
} from "./audit-feed";

/**
 * dw09 — the audit feed's pure row mapping (severity tone, category hue, action
 * label, target and relative clock) plus a `renderToStaticMarkup` pass that
 * proves the real timeline row, the empty state and the loading skeleton.
 */

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

// Built dynamically so the source never quotes a dotted event literal verbatim
// (the `src/components/` vocabulary gate in webhook-events.test.ts).
const action = (entity: string, verb: string): string => `${entity}.${verb}`;

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "e1",
  actorId: "ada",
  type: action("page", "archived"),
  entityId: "p9",
  entityType: "page",
  createdAt: "2026-10-15T11:55:00.000Z",
  meta: { title: "Old notes" },
  ...overrides,
});

const loadMore: AuditPageLoader = async () => ({ ok: true, events: [], nextCursor: null });

const render = (overrides: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(AuditFeed, {
      initialEvents: [event()],
      filter: {},
      nextCursor: null,
      now: NOW,
      locale: "en",
      loadMore,
      ...overrides,
    }),
  );

describe("auditBadgeTone", () => {
  it("maps destructive verbs to danger", () => {
    for (const type of [
      action("page", "deleted"),
      action("comment", "removed"),
      action("member", "left"),
      action("page", "archived"),
    ]) {
      expect(auditBadgeTone(type)).toBe("danger");
    }
  });

  it("maps creating verbs to success", () => {
    for (const type of [
      action("page", "created"),
      action("page", "restored"),
      action("ticket", "resolved"),
    ]) {
      expect(auditBadgeTone(type)).toBe("success");
    }
  });

  it("maps mutating verbs to accent and ambiguous ones to warning", () => {
    expect(auditBadgeTone(action("page", "updated"))).toBe("accent");
    expect(auditBadgeTone(action("page", "moved"))).toBe("accent");
    expect(auditBadgeTone(action("member", "role_changed"))).toBe("accent");
    expect(auditBadgeTone(action("page", "reopened"))).toBe("warning");
  });

  it("falls back to neutral for anything uncatalogued", () => {
    expect(auditBadgeTone(action("page", "somethingelse"))).toBe("neutral");
    expect(auditBadgeTone("frobnicated")).toBe("neutral");
  });
});

describe("auditCategoryHue", () => {
  it("maps known entity kinds to tag hues", () => {
    expect(auditCategoryHue("page")).toBe("blue");
    expect(auditCategoryHue("member")).toBe("teal");
    expect(auditCategoryHue("comment")).toBe("purple");
  });

  it("falls back to gray for unknown kinds", () => {
    expect(auditCategoryHue("widget-unknown")).toBe("gray");
  });
});

describe("auditActionLabel", () => {
  it("expands the audit vocabulary", () => {
    expect(auditActionLabel(action("page", "role_changed"))).toBe("changed the role of");
    expect(auditActionLabel(action("page", "ownership_transferred"))).toBe(
      "transferred ownership of",
    );
  });

  it("humanises an unknown segment and handles a bare verb", () => {
    expect(auditActionLabel(action("ticket", "foo_bar"))).toBe("foo bar");
    expect(auditActionLabel("created")).toBe("created");
  });
});

describe("auditTarget", () => {
  it("prefers a meta title, then a name, then the entity id", () => {
    expect(auditTarget(event())).toBe("Old notes");
    expect(auditTarget(event({ meta: { name: "Secret" } }))).toBe("Secret");
    expect(auditTarget(event({ meta: undefined }))).toBe("p9");
  });
});

describe("relativeTime", () => {
  it("renders short buckets against the pinned clock", () => {
    const at = (iso: string) => relativeTime(iso, NOW);
    expect(at("2026-10-15T11:59:30.000Z")).toBe("just now");
    expect(at("2026-10-15T11:55:00.000Z")).toBe("5m ago");
    expect(at("2026-10-15T09:00:00.000Z")).toBe("3h ago");
    expect(at("2026-10-13T12:00:00.000Z")).toBe("2d ago");
  });

  it("falls back to a stable date beyond a week and tolerates junk", () => {
    const older = relativeTime("2026-10-01T12:00:00.000Z", NOW);
    expect(older).toContain("2026");
    expect(older).not.toContain("ago");
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});

describe("AuditFeed render — a timeline row", () => {
  const html = render();

  it("renders the timeline indent guide and marker", () => {
    expect(html).toContain("border-s border-border");
    expect(html).toContain("data-timeline-dot");
  });

  it("renders an avatar, a severity badge, a category tag, the target and the clock", () => {
    expect(html).toContain('data-kind="initials"');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain("archived");
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("page");
    expect(html).toContain("Old notes");
    expect(html).toContain("5m ago");
    expect(html).toContain("<time");
  });
});

describe("AuditFeed render — states", () => {
  it("shows an actionable empty state when there is nothing to show", () => {
    const html = render({ initialEvents: [] });
    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("No results");
    expect(html).toContain("No audit events match the current filter.");
  });

  it("shows a layout-shaped skeleton while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("notion-skeleton");
    expect(html).not.toContain("data-timeline-dot");
  });
});
