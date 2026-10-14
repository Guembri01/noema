import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_EVENT_TYPES,
  groupIntoDigest,
  normalizePrefs,
  shouldNotify,
} from "./notification-prefs";
import type {
  DeliveryLevel,
  DigestCadence,
  NotificationEvent,
  NotificationEventType,
  NotificationPrefs,
} from "./notification-prefs";

/**
 * docs/MISSING_FEATURES.md §7 "Notification preferences" + "Notification inbox"
 * (delivery-decision half).
 *
 * Red-first: `src/lib/notification-prefs.ts` does not exist until this lands -
 * the first run fails to resolve the import, then the suite goes green with the
 * implementation. Pure decisions only: no DB, no clock, no timers - a future
 * digest scheduler hands its own batch to `groupIntoDigest`.
 *
 * The event vocabulary is pinned to the dotted `Notification.type` strings the
 * app already writes (`src/server/actions/comments.ts`) and renders
 * (`src/app/w/[slug]/inbox/page.tsx`), so a rename there must trip this suite.
 */

/** A single notification event; `mentionsCurrentUser` mirrors the wire shape. */
function makeEvent(
  type: NotificationEventType,
  mentionsCurrentUser = false,
): NotificationEvent {
  return { type, mentionsCurrentUser };
}

/** Defaults merged with a test-local cadence and/or level overrides. */
function prefsWith(
  digest: DigestCadence,
  events: Partial<Record<NotificationEventType, DeliveryLevel>> = {},
): NotificationPrefs {
  return {
    events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...events },
    digest,
  };
}

describe("event catalog", () => {
  it("mirrors the notification type strings the app already writes", () => {
    // prisma Notification.type written by src/server/actions/comments.ts
    expect(NOTIFICATION_EVENT_TYPES).toContain("comment.reply");
    expect(NOTIFICATION_EVENT_TYPES).toContain("page.mention");
    // label already rendered by the inbox route
    expect(NOTIFICATION_EVENT_TYPES).toContain("page.shared");
    // dotted activity/webhook vocabulary for edits and invitations
    expect(NOTIFICATION_EVENT_TYPES).toContain("page.updated");
    expect(NOTIFICATION_EVENT_TYPES).toContain("member.invited");
  });

  it("contains no duplicates", () => {
    expect(new Set(NOTIFICATION_EVENT_TYPES).size).toBe(
      NOTIFICATION_EVENT_TYPES.length,
    );
  });
});

describe("defaults", () => {
  it("defines a level for every known event type and no others", () => {
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFS.events).sort()).toEqual(
      [...NOTIFICATION_EVENT_TYPES].sort(),
    );
  });

  it("delivers instantly out of the box", () => {
    expect(DEFAULT_NOTIFICATION_PREFS.digest).toBe("INSTANT");
  });

  it("alerts on every directed event but only mentions of page edits", () => {
    const levels = DEFAULT_NOTIFICATION_PREFS.events;
    expect(levels["page.mention"]).toBe("ALL");
    expect(levels["comment.reply"]).toBe("ALL");
    expect(levels["page.shared"]).toBe("ALL");
    expect(levels["member.invited"]).toBe("ALL");
    expect(levels["page.updated"]).toBe("MENTIONS"); // broadcast: edits are opt-in
  });
});

describe("normalizePrefs", () => {
  it("returns the defaults for missing or non-object input", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs("ALL")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs(7)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs([])).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("fills the gaps of a partial preference object", () => {
    expect(normalizePrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs({ events: { "page.mention": "NONE" } })).toEqual({
      events: {
        ...DEFAULT_NOTIFICATION_PREFS.events,
        "page.mention": "NONE",
      },
      digest: DEFAULT_NOTIFICATION_PREFS.digest,
    });
    expect(normalizePrefs({ digest: "WEEKLY" })).toEqual({
      events: { ...DEFAULT_NOTIFICATION_PREFS.events },
      digest: "WEEKLY",
    });
  });

  it("keeps every valid level and cadence verbatim", () => {
    const normalized = normalizePrefs({
      events: { "page.updated": "ALL", "comment.reply": "NONE" },
      digest: "WEEKLY",
    });
    expect(normalized.events["page.updated"]).toBe("ALL");
    expect(normalized.events["comment.reply"]).toBe("NONE");
    expect(normalized.digest).toBe("WEEKLY");
  });

  it("fails closed to the default level for unknown level values", () => {
    const normalized = normalizePrefs({
      events: { "page.mention": "SOMETIMES", "page.updated": 42 },
    });
    expect(normalized.events["page.mention"]).toBe(
      DEFAULT_NOTIFICATION_PREFS.events["page.mention"],
    );
    expect(normalized.events["page.updated"]).toBe(
      DEFAULT_NOTIFICATION_PREFS.events["page.updated"],
    );
  });

  it("fails closed to the default cadence for unknown cadence values", () => {
    expect(normalizePrefs({ digest: "HOURLY" }).digest).toBe(
      DEFAULT_NOTIFICATION_PREFS.digest,
    );
    expect(normalizePrefs({ digest: null }).digest).toBe(
      DEFAULT_NOTIFICATION_PREFS.digest,
    );
  });

  it("ignores unknown event types instead of storing them", () => {
    const normalized = normalizePrefs({
      events: { "page.exploded": "ALL", "spam.everything": "NONE" },
    });
    expect(Object.keys(normalized.events).sort()).toEqual(
      [...NOTIFICATION_EVENT_TYPES].sort(),
    );
  });

  it("survives junk nested values without throwing", () => {
    expect(() => normalizePrefs({ events: "nope", digest: {} })).not.toThrow();
    expect(normalizePrefs({ events: "nope", digest: {} })).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it("does not mutate its input", () => {
    const input = { events: { "page.mention": "NONE" } };
    const before = JSON.parse(JSON.stringify(input));
    normalizePrefs(input);
    expect(input).toEqual(before);
  });
});

describe("shouldNotify - per-event level", () => {
  it("alerts on every ALL event, mention or not", () => {
    const prefs = prefsWith("INSTANT", { "page.updated": "ALL" });
    expect(shouldNotify(prefs, makeEvent("page.updated", true))).toBe("ALERT");
    expect(shouldNotify(prefs, makeEvent("page.updated", false))).toBe("ALERT");
    expect(shouldNotify(prefs, makeEvent("page.mention", true))).toBe("ALERT");
  });

  it("alerts only on mentions at the MENTIONS level", () => {
    const prefs = prefsWith("INSTANT", { "comment.reply": "MENTIONS" });
    expect(shouldNotify(prefs, makeEvent("comment.reply", true))).toBe(
      "ALERT",
    );
    expect(shouldNotify(prefs, makeEvent("comment.reply", false))).toBe(
      "SUPPRESSED",
    );
  });

  it("suppresses everything at the NONE level", () => {
    const prefs = prefsWith("INSTANT", {
      "page.mention": "NONE",
      "page.shared": "NONE",
    });
    expect(shouldNotify(prefs, makeEvent("page.mention", true))).toBe(
      "SUPPRESSED",
    );
    expect(shouldNotify(prefs, makeEvent("page.shared", true))).toBe(
      "SUPPRESSED",
    );
  });

  it("applies the defaults when handed an empty preferences object", () => {
    expect(shouldNotify({}, makeEvent("page.mention", true))).toBe("ALERT");
    expect(shouldNotify({}, makeEvent("page.updated", true))).toBe("ALERT");
    expect(shouldNotify({}, makeEvent("page.updated", false))).toBe(
      "SUPPRESSED",
    );
  });

  it("fails closed on an unrecognised event type", () => {
    const junk = makeEvent("page.exploded" as NotificationEventType, true);
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, junk)).toBe("SUPPRESSED");
    expect(shouldNotify(prefsWith("DAILY"), junk)).toBe("SUPPRESSED");
  });
});

describe("shouldNotify - digest cadence", () => {
  it("alerts immediately when the cadence is INSTANT", () => {
    expect(shouldNotify(prefsWith("INSTANT"), makeEvent("page.mention", true))).toBe(
      "ALERT",
    );
    expect(
      shouldNotify(prefsWith("INSTANT", { "page.updated": "ALL" }), makeEvent("page.updated", false)),
    ).toBe("ALERT");
  });

  it("defers accepted events into a DAILY digest", () => {
    expect(shouldNotify(prefsWith("DAILY"), makeEvent("page.mention", true))).toBe(
      "DIGEST",
    );
    expect(
      shouldNotify(prefsWith("DAILY", { "page.updated": "ALL" }), makeEvent("page.updated", false)),
    ).toBe("DIGEST");
  });

  it("defers accepted events into a WEEKLY digest", () => {
    expect(shouldNotify(prefsWith("WEEKLY"), makeEvent("comment.reply", true))).toBe(
      "DIGEST",
    );
  });

  it("still suppresses level-filtered events under a digest cadence", () => {
    expect(
      shouldNotify(prefsWith("DAILY", { "page.updated": "MENTIONS" }), makeEvent("page.updated", false)),
    ).toBe("SUPPRESSED");
    expect(
      shouldNotify(prefsWith("WEEKLY", { "page.shared": "NONE" }), makeEvent("page.shared", true)),
    ).toBe("SUPPRESSED");
  });

  it("OFF suppresses everything, mentions included", () => {
    const off = prefsWith("OFF");
    expect(shouldNotify(off, makeEvent("page.mention", true))).toBe("SUPPRESSED");
    expect(shouldNotify(off, makeEvent("page.updated", false))).toBe("SUPPRESSED");
    expect(
      shouldNotify(prefsWith("OFF", { "page.mention": "NONE" }), makeEvent("page.mention", true)),
    ).toBe("SUPPRESSED");
  });

  it("normalizes corrupted preferences before deciding", () => {
    const corrupted = {
      digest: "HOURLY",
      events: "junk",
    } as unknown as NotificationPrefs;
    // Falls back to the defaults: page.mention defaults to ALL + INSTANT.
    expect(shouldNotify(corrupted, makeEvent("page.mention", true))).toBe("ALERT");
    // ...and a non-mention of a MENTIONS-default type stays suppressed.
    expect(shouldNotify(corrupted, makeEvent("page.updated", false))).toBe(
      "SUPPRESSED",
    );
  });
});

describe("groupIntoDigest", () => {
  const batch: NotificationEvent[] = [
    makeEvent("page.mention", true),
    makeEvent("comment.reply", true),
    makeEvent("page.updated", false),
    makeEvent("page.shared", true),
  ];

  it("buckets every accepted event under a DAILY cadence", () => {
    // page.updated defaults to MENTIONS, so raise it to ALL to accept the
    // whole batch - level filtering gets its own test below.
    const prefs = prefsWith("DAILY", { "page.updated": "ALL" });
    expect(groupIntoDigest(batch, prefs)).toEqual({ DAILY: batch });
  });

  it("buckets every accepted event under a WEEKLY cadence", () => {
    const prefs = prefsWith("WEEKLY", { "page.updated": "ALL" });
    expect(groupIntoDigest(batch, prefs)).toEqual({ WEEKLY: batch });
  });

  it("returns no buckets when alerts are instant", () => {
    expect(groupIntoDigest(batch, prefsWith("INSTANT"))).toEqual({});
    expect(groupIntoDigest(batch, DEFAULT_NOTIFICATION_PREFS)).toEqual({});
  });

  it("returns no buckets when the cadence is OFF", () => {
    expect(groupIntoDigest(batch, prefsWith("OFF"))).toEqual({});
  });

  it("drops events the level filter suppresses", () => {
    const prefs = prefsWith("DAILY", {
      "page.updated": "MENTIONS", // batch event is not a mention
      "page.shared": "NONE",
    });
    const buckets = groupIntoDigest(batch, prefs);
    expect(buckets.DAILY).toEqual([
      makeEvent("page.mention", true),
      makeEvent("comment.reply", true),
    ]);
  });

  it("keeps richer event records intact inside the bucket", () => {
    const rich = [
      {
        type: "page.mention" as const,
        mentionsCurrentUser: true,
        id: "n1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const buckets = groupIntoDigest(rich, prefsWith("DAILY"));
    expect(buckets.DAILY).toEqual(rich);
    expect(buckets.DAILY?.[0]?.id).toBe("n1");
  });

  it("excludes runtime-junk event types", () => {
    const junk = [
      { type: "toast.selfdestruct", mentionsCurrentUser: true },
    ] as unknown as NotificationEvent[];
    expect(groupIntoDigest(junk, prefsWith("DAILY"))).toEqual({});
  });

  it("returns an empty result when there is nothing to send", () => {
    expect(groupIntoDigest([], prefsWith("DAILY"))).toEqual({});
  });
});
