import { describe, expect, it } from "vitest";
import {
  buildDigest,
  digestSubject,
  plainTextDigest,
  previewText,
} from "./email-digest";
import type { DigestNotification } from "./email-digest";

/**
 * docs/specs/notifications.md §R82.27 "Email digests" (the formatting half; the
 * delivery decision lives in `notification-prefs.ts`, the inbox sectioning in
 * `notification-inbox.ts`).
 *
 * Red-first: `src/lib/email-digest.ts` does not exist until this lands - the
 * first run fails to resolve the import, then the suite goes green. Pure
 * formatting only: no DB, no SMTP, no React and no ambient clock - `buildDigest`
 * is handed a fixed `now` so every recency boundary is deterministic. Timestamps
 * are ISO strings, never `new Date()`.
 */

/** A fixed instant for bucket math: 2026-03-10T12:00:00Z (a Tuesday). */
const NOW = "2026-03-10T12:00:00.000Z";

/** Build a notification with sane defaults, overriding only what a test needs. */
function make(
  over: Partial<DigestNotification> & { id: string },
): DigestNotification {
  return {
    type: "page.mention",
    createdAt: "2026-03-10T09:00:00.000Z",
    ...over,
  };
}

// Fixed sample set spanning every bucket, with a same-page pair (a, b) and an
// un-paged notification (d).
const a = make({ id: "a", createdAt: "2026-03-10T11:00:00.000Z", pageId: "p1" });
const b = make({
  id: "b",
  type: "comment.reply",
  createdAt: "2026-03-10T08:00:00.000Z",
  pageId: "p1",
});
const c = make({
  id: "c",
  type: "page.shared",
  createdAt: "2026-03-09T23:30:00.000Z",
  pageId: "p2",
});
const d = make({
  id: "d",
  type: "page.updated",
  createdAt: "2026-02-01T00:00:00.000Z",
});

/** The flattened body of the four-notification digest, pinned literally. */
const FLAT_BODY =
  "Today - page.mention (p1) - comment.reply (p1) Yesterday - page.shared (p2) Earlier - page.updated";

describe("previewText", () => {
  it("collapses runs of whitespace to single spaces and trims", () => {
    expect(previewText("  a\n\n\tb   c  ")).toBe("a b c");
  });

  it("leaves text at or under the limit untouched", () => {
    expect(previewText("abcde", { max: 5 })).toBe("abcde");
    expect(previewText("", { max: 5 })).toBe("");
  });

  it("truncates long text at the limit with an ellipsis", () => {
    const out = previewText("abcdefghij", { max: 5 });
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("defaults the limit to 140 characters", () => {
    const out = previewText("x".repeat(400));
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(previewText("anything", { max: 0 })).toBe("");
    expect(previewText("anything", { max: -3 })).toBe("");
  });
});

describe("digestSubject", () => {
  it("uses the singular for a single notification", () => {
    expect(digestSubject(1, { cadence: "DAILY" })).toBe(
      "Daily digest: 1 new notification",
    );
  });

  it("pluralizes counts above one", () => {
    expect(digestSubject(3, { cadence: "DAILY" })).toBe(
      "Daily digest: 3 new notifications",
    );
  });

  it("names the weekly window when the cadence is weekly", () => {
    expect(digestSubject(5, { cadence: "WEEKLY" })).toBe(
      "Weekly digest: 5 new notifications",
    );
  });

  it("omits the cadence prefix for instant delivery", () => {
    expect(digestSubject(2, { cadence: "INSTANT" })).toBe("2 new notifications");
    expect(digestSubject(2)).toBe("2 new notifications");
  });

  it("announces an empty digest without a count", () => {
    expect(digestSubject(0, { cadence: "DAILY" })).toBe("No new notifications");
    expect(digestSubject(0, { cadence: "WEEKLY" })).toBe("No new notifications");
  });

  it("clamps a nonsensical negative count to the empty digest", () => {
    expect(digestSubject(-4, { cadence: "DAILY" })).toBe("No new notifications");
  });
});

describe("buildDigest", () => {
  it("derives the subject from the count and cadence", () => {
    const digest = buildDigest([d, c, a, b], { now: NOW, cadence: "DAILY" });
    expect(digest.subject).toBe("Daily digest: 4 new notifications");
    expect(digest.count).toBe(4);
  });

  it("sections by recency, newest bucket first, omitting empty ones", () => {
    const digest = buildDigest([d, c, a, b], { now: NOW, cadence: "DAILY" });
    expect(digest.sections.map((s) => s.label)).toEqual([
      "Today",
      "Yesterday",
      "Earlier",
    ]);
    expect(digest.sections.map((s) => s.bucket)).toEqual([
      "today",
      "yesterday",
      "earlier",
    ]);
  });

  it("places each notification in the right section", () => {
    const digest = buildDigest([d, c, a, b], { now: NOW, cadence: "DAILY" });
    expect(digest.sections[0]?.items.map((n) => n.id)).toEqual(["a", "b"]);
    expect(digest.sections[1]?.items.map((n) => n.id)).toEqual(["c"]);
    expect(digest.sections[2]?.items.map((n) => n.id)).toEqual(["d"]);
    expect(digest.sections[0]?.count).toBe(2);
    expect(digest.sections[1]?.count).toBe(1);
  });

  it("sorts items within a section newest-first", () => {
    const digest = buildDigest([b, a], { now: NOW, cadence: "DAILY" });
    expect(digest.sections).toHaveLength(1);
    expect(digest.sections[0]?.items.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("breaks createdAt ties by id descending, deterministically", () => {
    const t1 = make({ id: "alpha", createdAt: "2026-03-10T10:00:00.000Z" });
    const t2 = make({ id: "bravo", createdAt: "2026-03-10T10:00:00.000Z" });
    const digest = buildDigest([t1, t2], { now: NOW, cadence: "DAILY" });
    expect(digest.sections[0]?.items.map((n) => n.id)).toEqual([
      "bravo",
      "alpha",
    ]);
  });

  it("treats midnight-to-now as a single day at the boundary", () => {
    const justBefore = make({ id: "x", createdAt: "2026-03-09T23:59:59.999Z" });
    const justAfter = make({ id: "y", createdAt: "2026-03-10T00:00:00.000Z" });
    const digest = buildDigest([justBefore, justAfter], {
      now: NOW,
      cadence: "DAILY",
    });
    expect(digest.sections[0]?.items.map((n) => n.id)).toEqual(["y"]);
    expect(digest.sections[1]?.items.map((n) => n.id)).toEqual(["x"]);
  });

  it("builds a single-line preview from the flattened body", () => {
    const digest = buildDigest([d, c, a, b], { now: NOW, cadence: "DAILY" });
    expect(digest.preview).toBe(FLAT_BODY);
    expect(digest.preview).not.toContain("\n");
  });

  it("honours a custom preview limit", () => {
    const digest = buildDigest([d, c, a, b], {
      now: NOW,
      cadence: "DAILY",
      previewMax: 20,
    });
    expect(digest.preview.length).toBe(20);
    expect(digest.preview.endsWith("…")).toBe(true);
  });

  it("defaults the cadence to instant (no prefix)", () => {
    const digest = buildDigest([a], { now: NOW });
    expect(digest.subject).toBe("1 new notification");
  });

  it("returns a subject-only digest for an empty input", () => {
    const digest = buildDigest([], { now: NOW, cadence: "DAILY" });
    expect(digest.subject).toBe("No new notifications");
    expect(digest.preview).toBe("No new notifications");
    expect(digest.sections).toEqual([]);
    expect(digest.count).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = [d, c, a, b];
    const before = input.slice();
    buildDigest(input, { now: NOW, cadence: "DAILY" });
    expect(input).toEqual(before);
    expect(input[0]).toBe(d);
  });
});

describe("plainTextDigest", () => {
  it("renders the subject, then each section with its items", () => {
    const digest = buildDigest([d, c, a, b], { now: NOW, cadence: "DAILY" });
    expect(plainTextDigest(digest)).toBe(
      [
        "Daily digest: 4 new notifications",
        "",
        "Today",
        "- page.mention (p1)",
        "- comment.reply (p1)",
        "",
        "Yesterday",
        "- page.shared (p2)",
        "",
        "Earlier",
        "- page.updated",
      ].join("\n"),
    );
  });

  it("renders a subject-only digest when there is nothing to report", () => {
    const digest = buildDigest([], { now: NOW, cadence: "DAILY" });
    expect(plainTextDigest(digest)).toBe("No new notifications");
  });

  it("omits the page suffix for un-paged notifications", () => {
    const digest = buildDigest([d], { now: NOW, cadence: "DAILY" });
    expect(plainTextDigest(digest)).toBe(
      "Daily digest: 1 new notification\n\nEarlier\n- page.updated",
    );
  });
});
