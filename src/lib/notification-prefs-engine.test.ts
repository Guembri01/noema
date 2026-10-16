import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  applyFollow,
  defaultPrefs,
  describePrefs,
  groupDigest,
  nextDigestAt,
  parsePrefs,
  resolveRecipients,
  shouldDeliver,
  validatePrefs,
} from "./notification-prefs-engine";
import type {
  DigestEvent,
  NotificationPrefs,
  NotificationType,
} from "./notification-prefs-engine";

/**
 * docs/specs/collaboration-deep.md §7 "Notification inbox & preferences"
 * (+ Following pages / PageFollow dispatch) and the per-user preference,
 * quiet-hours, digest and follow-dispatch half of docs/specs/notifications.md
 * R82.15-R82.18 / R82.27.
 *
 * Red-first: `src/lib/notification-prefs-engine.ts` does not exist until this
 * lands, so the first run fails to resolve the import and the suite goes green
 * with the implementation. Everything here is pure - no DB, no clock, no
 * timers: every helper is handed its `at` / `now` and an explicit
 * `tzOffsetMinutes` keeps the quiet-hours matrix deterministic.
 */

const U1 = "u1";

/** Defaults merged with a partial override; keeps each test to one concern. */
function withPrefs(over: Partial<NotificationPrefs>): NotificationPrefs {
  return { ...defaultPrefs(U1), ...over };
}

describe("catalog and defaults", () => {
  it("pins the dotted notification types the app already writes", () => {
    expect(NOTIFICATION_TYPES).toContain("page.mention");
    expect(NOTIFICATION_TYPES).toContain("comment.reply");
    expect(NOTIFICATION_TYPES).toContain("page.shared");
    expect(NOTIFICATION_TYPES).toContain("page.updated");
    expect(NOTIFICATION_TYPES).toContain("member.invited");
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
    expect(NOTIFICATION_CHANNELS).toEqual(["inApp", "email", "push"]);
  });

  it("delivers in-app only, with no digest, out of the box", () => {
    expect(DEFAULT_PREFS.channels).toEqual({
      inApp: true,
      email: false,
      push: false,
    });
    expect(DEFAULT_PREFS.digest).toBe("off");
    expect(DEFAULT_PREFS.quietHours).toBeUndefined();
  });

  it("defaults comments-following on but page-following opt-in", () => {
    expect(DEFAULT_PREFS.followDefaults).toEqual({
      pages: false,
      comments: true,
    });
    expect(Object.keys(DEFAULT_PREFS.perType).sort()).toEqual(
      [...NOTIFICATION_TYPES].sort(),
    );
  });

  it("stamps the caller's user id via defaultPrefs without mutating defaults", () => {
    const mine = defaultPrefs("u9");
    expect(mine.userId).toBe("u9");
    expect(mine.perType).toEqual(DEFAULT_PREFS.perType);
    expect(mine.perType).not.toBe(DEFAULT_PREFS.perType);
    expect(DEFAULT_PREFS.userId).toBe("");
  });
});

describe("parsePrefs", () => {
  it("returns the defaults for missing, junk or non-object input", () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("daily")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(7)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs([])).toEqual(DEFAULT_PREFS);
  });

  it("merges a partial object over the defaults", () => {
    const parsed = parsePrefs({ userId: "u2", digest: "weekly", channels: { email: true } });
    expect(parsed.userId).toBe("u2");
    expect(parsed.digest).toBe("weekly");
    expect(parsed.channels).toEqual({ inApp: true, email: true, push: false });
    expect(parsed.perType).toEqual(DEFAULT_PREFS.perType);
    expect(parsed.followDefaults).toEqual(DEFAULT_PREFS.followDefaults);
  });

  it("keeps valid per-type overrides and ignores unknown type keys", () => {
    const parsed = parsePrefs({
      perType: {
        "page.mention": { inApp: false, email: true },
        "page.exploded": { inApp: false, email: false },
      },
    });
    expect(parsed.perType["page.mention"]).toEqual({ inApp: false, email: true });
    expect(Object.keys(parsed.perType).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("parses well-formed quiet hours and drops malformed ones", () => {
    const good = parsePrefs({
      quietHours: { start: "22:00", end: "07:00", tz: "America/New_York" },
    });
    expect(good.quietHours).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/New_York",
    });
    expect(parsePrefs({ quietHours: { start: "25:00", end: "07:00", tz: "UTC" } }).quietHours).toBeUndefined();
    expect(parsePrefs({ quietHours: { start: "22:00", end: "22:00", tz: "UTC" } }).quietHours).toBeUndefined();
    expect(parsePrefs({ quietHours: { start: "22:00", end: "07:00", tz: "" } }).quietHours).toBeUndefined();
  });

  it("fails closed on invalid enums and booleans, and never mutates input", () => {
    const parsed = parsePrefs({ digest: "hourly", channels: { inApp: "yes", push: 1 } });
    expect(parsed.digest).toBe(DEFAULT_PREFS.digest);
    expect(parsed.channels).toEqual(DEFAULT_PREFS.channels);

    const input = { channels: { email: true }, digest: "daily" };
    const before = JSON.parse(JSON.stringify(input));
    parsePrefs(input);
    expect(input).toEqual(before);
  });
});

describe("validatePrefs", () => {
  it("accepts a complete default preferences value", () => {
    const result = validatePrefs(defaultPrefs(U1));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(defaultPrefs(U1));
  });

  it("rejects a malformed digest cadence", () => {
    const result = validatePrefs({ ...defaultPrefs(U1), digest: "hourly" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("digest");
  });

  it("rejects malformed quiet-hour windows and unknown zones", () => {
    const bad = validatePrefs({
      ...defaultPrefs(U1),
      quietHours: { start: "25:00", end: "7:00", tz: "not a zone" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toContain("`quietHours.start` must be HH:MM (00:00-23:59).");
      expect(bad.errors.join(" ")).toContain("quietHours.end");
      expect(bad.errors.join(" ")).toContain("tz");
    }
  });

  it("rejects unknown per-type keys and missing type entries", () => {
    const unknown = validatePrefs({
      ...defaultPrefs(U1),
      perType: {
        ...defaultPrefs(U1).perType,
        "page.exploded": { inApp: true, email: true },
      },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join(" ")).toContain("page.exploded");

    const { "page.mention": _drop, ...missing } = defaultPrefs(U1).perType;
    void _drop;
    const incomplete = validatePrefs({ ...defaultPrefs(U1), perType: missing });
    expect(incomplete.ok).toBe(false);
  });

  it("reports non-object input instead of throwing", () => {
    expect(validatePrefs(null).ok).toBe(false);
    expect(validatePrefs("prefs").ok).toBe(false);
  });
});

describe("shouldDeliver", () => {
  const at = "2026-03-10T12:00:00.000Z";

  it("delivers in-app for a type that is on by default", () => {
    expect(
      shouldDeliver(defaultPrefs(U1), { type: "page.mention", at, channel: "inApp" }),
    ).toBe(true);
  });

  it("fails closed on an unknown event type", () => {
    expect(
      shouldDeliver(defaultPrefs(U1), {
        type: "page.exploded" as NotificationType,
        at,
        channel: "inApp",
      }),
    ).toBe(false);
  });

  it("respects the global channel switch", () => {
    expect(
      shouldDeliver(defaultPrefs(U1), { type: "page.mention", at, channel: "push" }),
    ).toBe(false);
    expect(
      shouldDeliver(parsePrefs({ channels: { push: true } }), {
        type: "page.mention",
        at,
        channel: "push",
      }),
    ).toBe(true);
  });

  it("lets a per-type override mute a type the global switch allows", () => {
    const prefs = parsePrefs({ perType: { "page.updated": { inApp: false } } });
    expect(
      shouldDeliver(prefs, { type: "page.updated", at, channel: "inApp" }),
    ).toBe(false);
  });

  it("will not let a per-type override re-enable a globally off channel", () => {
    const prefs = parsePrefs({
      channels: { inApp: false },
      perType: { "page.mention": { inApp: true, email: true } },
    });
    expect(
      shouldDeliver(prefs, { type: "page.mention", at, channel: "inApp" }),
    ).toBe(false);
  });

  it("suppresses in-app inside a same-day quiet window", () => {
    const prefs = parsePrefs({
      quietHours: { start: "09:00", end: "17:00", tz: "UTC" },
    });
    expect(shouldDeliver(prefs, { type: "page.mention", at, channel: "inApp" })).toBe(false);
    expect(
      shouldDeliver(prefs, { type: "page.mention", at: "2026-03-10T18:00:00.000Z", channel: "inApp" }),
    ).toBe(true);
  });

  it("honours a quiet window that wraps through midnight", () => {
    const prefs = parsePrefs({
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
    });
    const quiet = (iso: string) =>
      shouldDeliver(prefs, { type: "page.mention", at: iso, channel: "inApp" });

    expect(quiet("2026-03-10T23:30:00.000Z")).toBe(false); // evening run
    expect(quiet("2026-03-10T03:00:00.000Z")).toBe(false); // morning tail
    expect(quiet("2026-03-10T12:00:00.000Z")).toBe(true); // midday
    expect(quiet("2026-03-10T22:00:00.000Z")).toBe(false); // start inclusive
    expect(quiet("2026-03-10T07:00:00.000Z")).toBe(true); // end exclusive
  });

  it("evaluates quiet hours at the supplied offset and configured zone", () => {
    const prefs = parsePrefs({
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
    });
    // 23:30Z with a UTC+2 offset is 01:30 local - inside the window.
    expect(
      shouldDeliver(prefs, {
        type: "page.mention",
        at: "2026-03-10T23:30:00.000Z",
        channel: "inApp",
        tzOffsetMinutes: 120,
      }),
    ).toBe(false);

    const ny = parsePrefs({
      quietHours: { start: "22:00", end: "07:00", tz: "America/New_York" },
    });
    // 04:00Z in January is 23:00 EST - quiet; 23:30Z is 18:30 EST - clear.
    expect(
      shouldDeliver(ny, { type: "page.mention", at: "2026-01-15T04:00:00.000Z", channel: "inApp" }),
    ).toBe(false);
    expect(
      shouldDeliver(ny, { type: "page.mention", at: "2026-01-15T23:30:00.000Z", channel: "inApp" }),
    ).toBe(true);
  });

  it("never drops email on quiet hours - digests re-time it", () => {
    const prefs = parsePrefs({
      channels: { email: true },
      perType: { "page.mention": { email: true } },
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
    });
    expect(
      shouldDeliver(prefs, { type: "page.mention", at: "2026-03-10T23:30:00.000Z", channel: "email" }),
    ).toBe(true);
  });
});

describe("nextDigestAt", () => {
  it("returns null when the digest is off", () => {
    expect(nextDigestAt(defaultPrefs(U1), "2026-03-10T06:00:00.000Z")).toBeNull();
  });

  it("schedules a daily digest at 08:00 local, today or tomorrow", () => {
    const prefs = parsePrefs({ digest: "daily" });
    expect(nextDigestAt(prefs, "2026-03-10T06:00:00.000Z")?.toISOString()).toBe(
      "2026-03-10T08:00:00.000Z",
    );
    expect(nextDigestAt(prefs, "2026-03-10T09:00:00.000Z")?.toISOString()).toBe(
      "2026-03-11T08:00:00.000Z",
    );
    // "next" is strictly after now, so an exact hit rolls forward a day.
    expect(nextDigestAt(prefs, "2026-03-10T08:00:00.000Z")?.toISOString()).toBe(
      "2026-03-11T08:00:00.000Z",
    );
  });

  it("schedules a weekly digest for the coming Monday 08:00 local", () => {
    const prefs = parsePrefs({ digest: "weekly" });
    // 2026-03-10 is a Tuesday.
    expect(nextDigestAt(prefs, "2026-03-10T09:00:00.000Z")?.toISOString()).toBe(
      "2026-03-16T08:00:00.000Z",
    );
    // 2026-03-09 is a Monday, before and after the send hour.
    expect(nextDigestAt(prefs, "2026-03-09T06:00:00.000Z")?.toISOString()).toBe(
      "2026-03-09T08:00:00.000Z",
    );
    expect(nextDigestAt(prefs, "2026-03-09T10:00:00.000Z")?.toISOString()).toBe(
      "2026-03-16T08:00:00.000Z",
    );
  });

  it("schedules in the user's quiet-hours zone", () => {
    const prefs = parsePrefs({
      digest: "daily",
      quietHours: { start: "22:00", end: "07:00", tz: "America/New_York" },
    });
    // 14:00Z in January is 09:00 EST - past the 08:00 send hour, so the
    // next digest is 08:00 EST the following day = 13:00Z.
    expect(nextDigestAt(prefs, "2026-01-15T14:00:00.000Z")?.toISOString()).toBe(
      "2026-01-16T13:00:00.000Z",
    );
  });

  it("returns null for an unparseable instant", () => {
    expect(nextDigestAt(parsePrefs({ digest: "daily" }), "not-a-date")).toBeNull();
  });
});

describe("groupDigest", () => {
  const prefs = parsePrefs({
    userId: "u1",
    digest: "daily",
    channels: { email: true },
    perType: {
      "page.mention": { email: true },
      "comment.reply": { email: true },
      "page.updated": { email: false },
    },
  });

  it("returns null when the digest is off", () => {
    expect(groupDigest<DigestEvent>([], defaultPrefs(U1))).toBeNull();
  });

  it("batches the accepted email events into one payload, sorted and counted", () => {
    const events: DigestEvent[] = [
      { id: "n2", type: "comment.reply", at: "2026-03-10T10:00:00.000Z" },
      { id: "n1", type: "page.mention", at: "2026-03-10T09:00:00.000Z" },
      { id: "n3", type: "page.updated", at: "2026-03-10T11:00:00.000Z" },
    ];
    const payload = groupDigest(events, prefs);
    expect(payload?.userId).toBe("u1");
    expect(payload?.cadence).toBe("daily");
    expect(payload?.count).toBe(2);
    expect(payload?.events.map((event) => event.id)).toEqual(["n1", "n2"]);
    expect(payload?.counts).toEqual({ "page.mention": 1, "comment.reply": 1 });
  });

  it("drops events whose per-type email channel is off", () => {
    const onlyUpdated: DigestEvent[] = [
      { id: "n3", type: "page.updated", at: "2026-03-10T11:00:00.000Z" },
    ];
    expect(groupDigest(onlyUpdated, prefs)).toBeNull();
  });

  it("returns null when there is nothing to send", () => {
    expect(groupDigest<DigestEvent>([], prefs)).toBeNull();
  });
});

describe("applyFollow", () => {
  it("turns page following on and echoes the toggled page", () => {
    const applied = applyFollow(defaultPrefs(U1), { pageId: "p1", follow: true });
    expect(applied.prefs.followDefaults?.pages).toBe(true);
    expect(applied.pageId).toBe("p1");
    expect(applied.follow).toBe(true);
  });

  it("turns it back off without mutating the input", () => {
    const base = withPrefs({ followDefaults: { pages: true, comments: true } });
    const applied = applyFollow(base, { pageId: "p1", follow: false });
    expect(applied.prefs.followDefaults?.pages).toBe(false);
    expect(base.followDefaults?.pages).toBe(true);
  });
});

describe("resolveRecipients (PageFollow dispatch)", () => {
  it("delivers page.updated to followers and watchers, minus the actor", () => {
    expect(
      resolveRecipients(
        { type: "page.updated", pageId: "p1", actorId: "u0" },
        { followers: ["f1", "u0"], watchers: ["w1", "f1"] },
      ),
    ).toEqual(["f1", "w1"]);
  });

  it("excludes a follower who muted page.updated", () => {
    const silent: NotificationPrefs = parsePrefs({
      userId: "f2",
      perType: { "page.updated": { inApp: false, email: false } },
    });
    expect(
      resolveRecipients(
        { type: "page.updated", pageId: "p1" },
        { followers: ["f1", "f2"], prefs: { f2: silent } },
      ),
    ).toEqual(["f1"]);
  });

  it("includes comment followers only when their comments default is on", () => {
    const off: NotificationPrefs = parsePrefs({
      userId: "f2",
      followDefaults: { comments: false },
    });
    expect(
      resolveRecipients(
        { type: "comment.reply", pageId: "p1" },
        { followers: ["f1", "f2"], watchers: [], prefs: { f2: off } },
      ),
    ).toEqual(["f1"]);
  });

  it("addresses directed events to watchers only", () => {
    expect(
      resolveRecipients(
        { type: "page.mention", pageId: "p1" },
        { followers: ["f1"], watchers: ["w1"] },
      ),
    ).toEqual(["w1"]);
  });

  it("fails closed for an unknown event type", () => {
    expect(
      resolveRecipients(
        { type: "page.exploded" as NotificationType },
        { followers: ["f1"], watchers: ["w1"] },
      ),
    ).toEqual([]);
  });
});

describe("describePrefs", () => {
  it("summarises a default preferences value", () => {
    expect(describePrefs(defaultPrefs(U1))).toBe(
      "channels in-app | digest off | quiet off | follow comments | muted none",
    );
  });

  it("reports channels, digest, quiet hours, follow defaults and mutes", () => {
    const prefs = parsePrefs({
      channels: { inApp: true, email: true, push: true },
      digest: "weekly",
      quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
      perType: { "page.updated": { inApp: false, email: false } },
      followDefaults: { pages: true, comments: false },
    });
    expect(describePrefs(prefs)).toBe(
      "channels in-app, email, push | digest weekly | quiet 22:00-07:00 UTC | follow pages | muted page.updated",
    );
  });
});
