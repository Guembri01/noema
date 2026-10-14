import { describe, expect, it } from "vitest";

import {
  WEBHOOK_EVENTS,
  filterSubscribed,
  isWebhookEventType,
  validateEventPayload,
} from "./webhook-event-catalog";
import { WEBHOOK_EVENTS as EVENT_IDS } from "./webhook-events";

/**
 * B91 — the webhook event catalog's *behaviour*: a required-field schema per
 * event, payload validation against it, and subscription matching with a `*`
 * wildcard / `page.*` prefix. The catalog's identity lives in
 * `webhook-events.ts` (R24.18); this module derives from it so ids, labels and
 * descriptions cannot drift.
 */

describe("WEBHOOK_EVENTS catalog (B91)", () => {
  it("derives its event types from the single catalog — order included", () => {
    expect(WEBHOOK_EVENTS.map((event) => event.type)).toEqual([...EVENT_IDS]);
  });

  it("every event carries a non-empty label, description and requiredFields list", () => {
    for (const event of WEBHOOK_EVENTS) {
      expect(event.label.trim().length, event.type).toBeGreaterThan(0);
      expect(event.description.trim().length, event.type).toBeGreaterThan(0);
      expect(Array.isArray(event.requiredFields), event.type).toBe(true);
    }
  });

  it("declares the payload fields each dispatch site actually sends", () => {
    const required = Object.fromEntries(
      WEBHOOK_EVENTS.map((event) => [event.type, event.requiredFields]),
    );
    expect(required["page.created"]).toContain("pageId");
    expect(required["page.updated"]).toContain("pageId");
    expect(required["row.created"]).toEqual(
      expect.arrayContaining(["rowId", "databasePageId"]),
    );
    expect(required["comment.created"]).toContain("commentId");
  });

  it("has a type that equals its label, matching the picker's wire text", () => {
    for (const { type, label } of WEBHOOK_EVENTS) expect(label).toBe(type);
  });
});

describe("isWebhookEventType (B91)", () => {
  it("accepts every catalog event type", () => {
    for (const event of WEBHOOK_EVENTS) expect(isWebhookEventType(event.type)).toBe(true);
  });

  it("rejects unknown, wildcard and non-string values", () => {
    expect(isWebhookEventType("page.archived")).toBe(false);
    expect(isWebhookEventType("page.*")).toBe(false);
    expect(isWebhookEventType("*")).toBe(false);
    expect(isWebhookEventType("")).toBe(false);
    expect(isWebhookEventType(undefined)).toBe(false);
    expect(isWebhookEventType(42)).toBe(false);
    expect(isWebhookEventType(null)).toBe(false);
  });
});

describe("validateEventPayload (B91)", () => {
  it("accepts a complete payload", () => {
    expect(validateEventPayload("page.created", { pageId: "p1" })).toEqual([]);
  });

  it("accepts extra fields alongside the required ones", () => {
    expect(validateEventPayload("page.updated", { pageId: "p1", title: "x" })).toEqual([]);
  });

  it("flags a missing required field", () => {
    const issues = validateEventPayload("page.created", {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "pageId", code: "missing_field" });
  });

  it("treats null, undefined and blank strings as missing", () => {
    expect(validateEventPayload("page.created", { pageId: null })).toHaveLength(1);
    expect(validateEventPayload("page.created", { pageId: "   " })).toHaveLength(1);
    expect(validateEventPayload("row.created", { rowId: "r1" })).toHaveLength(1);
  });

  it("reports every missing field on a multi-field event", () => {
    const issues = validateEventPayload("row.created", {});
    expect(issues.map((issue) => issue.field).sort()).toEqual(["databasePageId", "rowId"]);
  });

  it("rejects a non-object payload", () => {
    expect(validateEventPayload("page.created", null)[0]).toMatchObject({
      code: "not_an_object",
    });
    expect(validateEventPayload("page.created", "p1")[0]).toMatchObject({
      code: "not_an_object",
    });
  });

  it("rejects an unknown event type", () => {
    expect(validateEventPayload("page.archived", { pageId: "p1" })[0]).toMatchObject({
      code: "unknown_event",
    });
  });
});

describe("filterSubscribed (B91)", () => {
  const ids = WEBHOOK_EVENTS.map((event) => event.type);

  it("returns nothing when no subscription matches", () => {
    expect(filterSubscribed(ids, ["page.archived"])).toEqual([]);
  });

  it("matches an exact event id", () => {
    expect(filterSubscribed(ids, ["page.created"])).toEqual(["page.created"]);
  });

  it("expands the `*` wildcard to every event", () => {
    expect(filterSubscribed(ids, ["*"])).toEqual([...ids]);
  });

  it("treats an empty subscription list as `*` (dispatch semantics)", () => {
    expect(filterSubscribed(ids, [])).toEqual([...ids]);
  });

  it("expands a prefix wildcard", () => {
    expect(filterSubscribed(ids, ["page.*"])).toEqual(["page.created", "page.updated"]);
  });

  it("unions exact and prefix subscriptions, preserving catalog order", () => {
    expect(filterSubscribed(ids, ["page.*", "comment.created"])).toEqual([
      "page.created",
      "page.updated",
      "comment.created",
    ]);
  });

  it("does not treat a bare prefix as a match", () => {
    expect(filterSubscribed(ids, ["page"])).toEqual([]);
  });

  it("ignores unknown subscription patterns", () => {
    expect(filterSubscribed(ids, ["nope.*", "page.created"])).toEqual(["page.created"]);
  });
});
