import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationEventType,
} from "@/lib/notification-prefs";
import {
  CADENCE_LABELS,
  DELIVERY_LEVELS,
  DIGEST_CADENCES,
  EVENT_DESCRIPTIONS,
  EVENT_LABELS,
  EVENT_TYPES,
  LEVEL_LABELS,
  draftsEqual,
  fromDraft,
  toDraft,
  type PrefsDraft,
} from "./prefs-view";

/**
 * The notification settings form maps between the persisted `NotificationPrefs`
 * shape and an editable draft. These are pure projections/labellings, so they
 * are pinned here rather than through the route: a corrupt row must render as
 * the defaults, and a malformed draft must normalize (narrow) instead of being
 * written back verbatim.
 */

describe("notification prefs view labels", () => {
  it("labels every event type, level and cadence the unions expose", () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_LABELS[type]).toBeTruthy();
      expect(EVENT_DESCRIPTIONS[type]).toBeTruthy();
    }
    for (const level of DELIVERY_LEVELS) expect(LEVEL_LABELS[level]).toBeTruthy();
    for (const cadence of DIGEST_CADENCES) expect(CADENCE_LABELS[cadence]).toBeTruthy();
  });

  it("covers exactly the delivery levels and digest cadences", () => {
    expect([...DELIVERY_LEVELS].sort()).toEqual(["ALL", "MENTIONS", "NONE"]);
    expect([...DIGEST_CADENCES].sort()).toEqual(["DAILY", "INSTANT", "OFF", "WEEKLY"]);
  });
});

describe("toDraft", () => {
  it("fills a null/corrupt row with the defaults", () => {
    expect(toDraft(null)).toEqual(toDraft(DEFAULT_NOTIFICATION_PREFS));
    expect(toDraft({ events: "nope", digest: 7 })).toEqual(toDraft(DEFAULT_NOTIFICATION_PREFS));
  });

  it("keeps valid stored values and replaces ill-typed ones per key", () => {
    const draft = toDraft({
      events: { "page.mention": "NONE", "page.updated": "bogus", "comment.reply": "MENTIONS" },
      digest: "WEEKLY",
    });
    expect(draft.digest).toBe("WEEKLY");
    expect(draft.events["page.mention"]).toBe("NONE");
    expect(draft.events["comment.reply"]).toBe("MENTIONS");
    // Unknown level falls back to the default for that type.
    expect(draft.events["page.updated"]).toBe(DEFAULT_NOTIFICATION_PREFS.events["page.updated"]);
    // Missing keys are filled with defaults too.
    expect(draft.events["page.shared"]).toBe(DEFAULT_NOTIFICATION_PREFS.events["page.shared"]);
  });
});

describe("fromDraft", () => {
  it("normalizes an ill-typed draft rather than persisting it verbatim", () => {
    const draft = {
      events: {
        ...DEFAULT_NOTIFICATION_PREFS.events,
        "page.mention": "not-a-level",
      } as Record<NotificationEventType, unknown>,
      digest: "sometimes",
    } as unknown as PrefsDraft;
    const prefs = fromDraft(draft);
    expect(prefs.events["page.mention"]).toBe(DEFAULT_NOTIFICATION_PREFS.events["page.mention"]);
    expect(prefs.digest).toBe(DEFAULT_NOTIFICATION_PREFS.digest);
  });

  it("round-trips a valid draft through the persisted shape", () => {
    const draft: PrefsDraft = {
      events: {
        ...DEFAULT_NOTIFICATION_PREFS.events,
        "page.mention": "MENTIONS",
        "page.updated": "NONE",
      },
      digest: "DAILY",
    };
    expect(toDraft(fromDraft(draft))).toEqual(draft);
  });
});

describe("draftsEqual", () => {
  it("is true for identical and false for differing drafts", () => {
    const base = toDraft(DEFAULT_NOTIFICATION_PREFS);
    expect(draftsEqual(base, toDraft(DEFAULT_NOTIFICATION_PREFS))).toBe(true);
    expect(
      draftsEqual(base, { ...base, digest: base.digest === "INSTANT" ? "DAILY" : "INSTANT" }),
    ).toBe(false);
    expect(
      draftsEqual(base, {
        ...base,
        events: {
          ...base.events,
          "page.mention": base.events["page.mention"] === "NONE" ? "ALL" : "NONE",
        },
      }),
    ).toBe(false);
  });
});
