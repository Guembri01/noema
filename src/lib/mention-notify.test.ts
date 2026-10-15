import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  shouldNotify,
} from "./notification-prefs";
import type { NotificationPrefs } from "./notification-prefs";
import {
  MENTION_RECIPIENT_CAP,
  reasonFor,
  resolveRecipients,
  shouldNotifyMention,
} from "./mention-notify";
import type { MentionKind, ResolveRecipientsInput } from "./mention-notify";

/**
 * docs/specs/notifications.md — the pure recipient side of the mention
 * dispatch (R82.3 visibility, R82.4 actor exclusion, R82.6 fan-out cap) plus
 * the delivery decision wrapper around `notification-prefs`.
 *
 * Red-first: `src/lib/mention-notify.ts` does not exist until this lands.
 * Pure decisions only: no prisma, no clock, no routes - a caller hands ids in
 * and gets the notify/suppress split back.
 */

/** A resolve input with sensible defaults; override only what a test needs. */
function input(overrides: Partial<ResolveRecipientsInput> = {}): ResolveRecipientsInput {
  return {
    mentionedIds: [],
    authorId: "author",
    pageFollowerIds: [],
    workspaceMemberIds: [],
    ...overrides,
  };
}

/** Defaults with per-test level/cadence overrides. */
function prefsWith(
  digest: NotificationPrefs["digest"],
  events: Partial<NotificationPrefs["events"]> = {},
): NotificationPrefs {
  return {
    events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...events },
    digest,
  };
}

describe("resolveRecipients", () => {
  it("notifies mentioned members in mention order", () => {
    const { notify, suppressed } = resolveRecipients(
      input({
        mentionedIds: ["bob", "carol"],
        workspaceMemberIds: ["alice", "bob", "carol", "author"],
      }),
    );
    expect(notify).toEqual(["bob", "carol"]);
    expect(suppressed).toEqual([]);
  });

  it("excludes the author and records the self-mention", () => {
    const { notify, suppressed } = resolveRecipients(
      input({
        mentionedIds: ["author", "bob"],
        workspaceMemberIds: ["author", "bob"],
      }),
    );
    expect(notify).toEqual(["bob"]);
    expect(suppressed).toEqual([{ id: "author", reason: "self" }]);
  });

  it("appends page followers after the mentions", () => {
    const { notify } = resolveRecipients(
      input({
        mentionedIds: ["bob"],
        pageFollowerIds: ["carol"],
        workspaceMemberIds: ["author", "bob", "carol"],
      }),
    );
    expect(notify).toEqual(["bob", "carol"]);
  });

  it("gates recipients to workspace members", () => {
    const { notify, suppressed } = resolveRecipients(
      input({
        mentionedIds: ["bob", "mallory"],
        pageFollowerIds: ["stranger"],
        workspaceMemberIds: ["author", "bob"],
      }),
    );
    expect(notify).toEqual(["bob"]);
    expect(suppressed).toEqual([
      { id: "mallory", reason: "not-a-member" },
      { id: "stranger", reason: "not-a-member" },
    ]);
  });

  it("dedupes a mentioned user who also follows the page", () => {
    const { notify, suppressed } = resolveRecipients(
      input({
        mentionedIds: ["bob", "carol"],
        pageFollowerIds: ["carol", "bob", "dave"],
        workspaceMemberIds: ["author", "bob", "carol", "dave"],
      }),
    );
    expect(notify).toEqual(["bob", "carol", "dave"]);
    expect(suppressed).toEqual([]);
  });

  it("caps the fan-out and reports each overflow recipient", () => {
    const many = Array.from({ length: MENTION_RECIPIENT_CAP + 2 }, (_, i) => `u${i}`);
    const { notify, suppressed } = resolveRecipients(
      input({ mentionedIds: many, workspaceMemberIds: many }),
    );
    expect(notify).toHaveLength(MENTION_RECIPIENT_CAP);
    expect(notify[0]).toBe("u0");
    expect(suppressed).toEqual([
      { id: `u${MENTION_RECIPIENT_CAP}`, reason: "over-cap" },
      { id: `u${MENTION_RECIPIENT_CAP + 1}`, reason: "over-cap" },
    ]);
  });

  it("honors an explicit cap, including zero", () => {
    const { notify, suppressed } = resolveRecipients(
      input({
        mentionedIds: ["bob", "carol", "dave"],
        workspaceMemberIds: ["bob", "carol", "dave"],
        cap: 2,
      }),
    );
    expect(notify).toEqual(["bob", "carol"]);
    expect(suppressed).toEqual([{ id: "dave", reason: "over-cap" }]);

    const zero = resolveRecipients(
      input({ mentionedIds: ["bob"], workspaceMemberIds: ["bob"], cap: 0 }),
    );
    expect(zero.notify).toEqual([]);
  });

  it("skips blank ids and returns empty lists for empty input", () => {
    expect(MENTION_RECIPIENT_CAP).toBe(200);
    const { notify, suppressed } = resolveRecipients(
      input({ mentionedIds: ["", "bob"], workspaceMemberIds: ["bob"] }),
    );
    expect(notify).toEqual(["bob"]);
    expect(suppressed).toEqual([]);

    const empty = resolveRecipients(input());
    expect(empty.notify).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const mentioned = ["bob", "carol"];
    resolveRecipients(
      input({ mentionedIds: mentioned, workspaceMemberIds: ["bob", "carol"] }),
    );
    expect(mentioned).toEqual(["bob", "carol"]);
  });
});

describe("reasonFor", () => {
  it("reports the stored reason for a suppressed id", () => {
    const { suppressed } = resolveRecipients(
      input({
        mentionedIds: ["author", "mallory"],
        workspaceMemberIds: ["author"],
      }),
    );
    expect(reasonFor("author", suppressed)).toBe("self");
    expect(reasonFor("mallory", suppressed)).toBe("not-a-member");
  });

  it("returns undefined for delivered and unknown ids", () => {
    const { suppressed } = resolveRecipients(
      input({
        mentionedIds: ["bob", "mallory"],
        authorId: null,
        workspaceMemberIds: ["bob"],
      }),
    );
    expect(reasonFor("bob", suppressed)).toBeUndefined();
  });
});

describe("shouldNotifyMention", () => {
  it("alerts for every directed mention kind under the defaults", () => {
    expect(shouldNotifyMention(DEFAULT_NOTIFICATION_PREFS, "comment")).toBe("ALERT");
    expect(shouldNotifyMention(DEFAULT_NOTIFICATION_PREFS, "reply")).toBe("ALERT");
  });

  it("respects the stored level, cadence and kill switch", () => {
    const none = prefsWith("INSTANT", { "page.mention": "NONE" });
    expect(shouldNotifyMention(none, "comment")).toBe("SUPPRESSED");
    const off = prefsWith("OFF");
    expect(shouldNotifyMention(off, "comment")).toBe("SUPPRESSED");
    const daily = prefsWith("DAILY");
    expect(shouldNotifyMention(daily, "reply")).toBe("DIGEST");
  });

  it("reuses shouldNotify with mentionsCurrentUser forced true", () => {
    expect(shouldNotifyMention(DEFAULT_NOTIFICATION_PREFS, "reply")).toBe(
      shouldNotify(DEFAULT_NOTIFICATION_PREFS, {
        type: "comment.reply",
        mentionsCurrentUser: true,
      }),
    );
  });

  it("fails closed on an unknown kind", () => {
    const bogus = "bogus" as unknown as MentionKind;
    expect(shouldNotifyMention(DEFAULT_NOTIFICATION_PREFS, bogus)).toBe("SUPPRESSED");
  });
});
