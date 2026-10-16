import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Email-digest cron (`/api/cron/digest`) — the production wiring for
 * `src/lib/email-digest.ts` (`buildDigest`/`plainTextDigest`) and the
 * scheduling half of `src/lib/notification-prefs-engine.ts` (`nextDigestAt`).
 *
 * Only transport edges (`@/lib/db`, the SMTP send) are mocked; the guard, rate
 * limiter, prefs engine, digest builders and response shaping run for real, so
 * the assertions pin actual behaviour: one batched email per user per window,
 * the 08:00 boundary honoured from `nextDigestAt`, per-type email switches
 * filtering the batch, and window dedupe via a prior successful delivery.
 */

const SECRET = "cron-digest-secret";
const ORIGIN = "https://app.example.test";
const PREV_APP_URL = process.env.APP_URL;
const PREV_CRON_SECRET = process.env.CRON_SECRET;

const db = vi.hoisted(() => ({
  notificationFindMany: vi.fn(),
  userFindMany: vi.fn(),
  emailDeliveryFindFirst: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
}));

const mailer = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    notification: { findMany: db.notificationFindMany },
    user: { findMany: db.userFindMany },
    emailDelivery: { findFirst: db.emailDeliveryFindFirst },
    workspaceMember: { findFirst: db.workspaceMemberFindFirst },
  },
}));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return { ...actual, sendMail: mailer.sendMail };
});

import { POST, GET } from "./route";

const FULL_EMAIL_PER_TYPE = {
  "page.mention": { inApp: true, email: true },
  "comment.reply": { inApp: true, email: true },
  "page.shared": { inApp: true, email: true },
  "page.updated": { inApp: true, email: true },
  "member.invited": { inApp: true, email: true },
};

/** Raw `notificationPrefs` JSON (the engine parses + defaults it). */
function userPrefs(over: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    channels: { inApp: true, email: true, push: false },
    digest: "daily",
    perType: FULL_EMAIL_PER_TYPE,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    userId: "u1",
    type: "page.mention",
    payload: { workspaceId: "ws-1", pageId: "p1" },
    createdAt: new Date("2026-03-10T08:30:00.000Z"),
    ...over,
  };
}

function user(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "u1@example.test",
    notificationPrefs: userPrefs(),
    ...over,
  };
}

const call = (headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/cron/digest", {
      method: "POST",
      headers: {
        "x-cron-secret": SECRET,
        "x-forwarded-for": "10.77.0.1",
        ...headers,
      },
    }),
  );

/** Pin the clock so the 08:00 schedule is deterministic. */
function freeze(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  process.env.CRON_SECRET = SECRET;
  process.env.APP_URL = ORIGIN;
  db.notificationFindMany.mockResolvedValue([row()]);
  db.userFindMany.mockResolvedValue([user()]);
  db.emailDeliveryFindFirst.mockResolvedValue(null);
  db.workspaceMemberFindFirst.mockResolvedValue({ workspaceId: "ws-1" });
  mailer.sendMail.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (PREV_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = PREV_CRON_SECRET;
  if (PREV_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = PREV_APP_URL;
});

describe("guards (fail closed, like the other cron routes)", () => {
  it("503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("CRON_SECRET"),
    });
  });

  it("401 on a wrong x-cron-secret", async () => {
    const res = await call({ "x-cron-secret": "nope" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("GET is accepted for a scheduler that prefers it", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    const res = await GET(
      new Request("http://localhost/api/cron/digest", {
        headers: { "x-cron-secret": SECRET, "x-forwarded-for": "10.77.0.2" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("digest batching + scheduling (nextDigestAt)", () => {
  it("batches three notifications into one email per user", async () => {
    freeze("2026-03-10T09:00:00.000Z"); // after the 08:00 boundary
    db.notificationFindMany.mockResolvedValue([
      row({ id: "n1", type: "page.mention", createdAt: new Date("2026-03-10T08:05:00.000Z") }),
      row({ id: "n2", type: "comment.reply", createdAt: new Date("2026-03-10T08:10:00.000Z") }),
      row({ id: "n3", type: "page.shared", createdAt: new Date("2026-03-10T08:20:00.000Z") }),
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      users: 1,
      sent: 1,
      skipped: 0,
      failed: [],
    });

    expect(mailer.sendMail).toHaveBeenCalledTimes(1); // ONE email, not three
    const [workspaceId, message] = mailer.sendMail.mock.calls[0] as [
      string,
      { to: string; subject: string; kind: string; text: string; html: string },
    ];
    expect(workspaceId).toBe("ws-1");
    expect(message).toMatchObject({
      to: "u1@example.test",
      subject: "Daily digest: 3 new notifications",
      kind: "notification-digest",
    });
    expect(message.text).toContain("Daily digest: 3 new notifications");
    expect(message.text).toContain("- page.mention (p1)");
    expect(message.text).toContain("- comment.reply (p1)");
    expect(message.text).toContain("- page.shared (p1)");
    expect(message.html).toContain("Daily digest: 3 new notifications");
  });

  it("does not send before the 08:00 boundary", async () => {
    freeze("2026-03-10T07:00:00.000Z");
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("is due inside the catch-up window (19:00) and not after it (20:00)", async () => {
    freeze("2026-03-10T19:00:00.000Z");
    const inside = await call();
    await expect(inside.json()).resolves.toMatchObject({ sent: 1 });

    resetRateLimits();
    mailer.sendMail.mockClear();
    db.emailDeliveryFindFirst.mockResolvedValue(null);
    freeze("2026-03-10T20:00:00.000Z");
    const after = await call();
    await expect(after.json()).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("skips a user whose digest is off", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.userFindMany.mockResolvedValue([
      user({ notificationPrefs: userPrefs({ digest: "off" }) }),
    ]);
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("excludes rows the per-type email switch turns off", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.userFindMany.mockResolvedValue([
      user({
        notificationPrefs: userPrefs({
          perType: {
            ...FULL_EMAIL_PER_TYPE,
            "page.mention": { inApp: true, email: false },
          },
        }),
      }),
    ]);
    db.notificationFindMany.mockResolvedValue([row({ type: "page.mention" })]);
    const res = await call();
    // Nothing accepted ⇒ empty digest ⇒ nothing sent.
    await expect(res.json()).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("sends once per window: a prior successful delivery suppresses a second", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.emailDeliveryFindFirst.mockResolvedValue({ id: "delivered" });
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    // The dedupe query is scoped to this window's boundary + the digest kind.
    const where = db.emailDeliveryFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      to: "u1@example.test",
      kind: "notification-digest",
      status: "sent",
    });
    expect(where.createdAt.gte).toEqual(new Date("2026-03-10T08:00:00.000Z"));
  });

  it("isolates one user's send failure: the next user still gets a digest", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.notificationFindMany.mockResolvedValue([
      row({ id: "n1", userId: "u1" }),
      row({ id: "n2", userId: "u2", payload: { workspaceId: "ws-1", pageId: "p2" } }),
    ]);
    db.userFindMany.mockResolvedValue([
      user({ id: "u1" }),
      user({ id: "u2", email: "u2@example.test" }),
    ]);
    mailer.sendMail
      .mockResolvedValueOnce({ error: "smtp exploded" })
      .mockResolvedValueOnce({ ok: true });

    const res = await call();
    const body = await res.json();
    expect(body).toMatchObject({ users: 2, sent: 1 });
    expect(body.failed).toEqual([{ userId: "u1", error: "smtp exploded" }]);
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  it("no pending notifications ⇒ no work", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.notificationFindMany.mockResolvedValue([]);
    const res = await call();
    await expect(res.json()).resolves.toEqual({
      users: 0,
      sent: 0,
      skipped: 0,
      failed: [],
    });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("falls back to the user's first membership when the payload has no workspaceId", async () => {
    freeze("2026-03-10T09:00:00.000Z");
    db.notificationFindMany.mockResolvedValue([
      row({ payload: { pageId: "p1" } }),
    ]);
    db.workspaceMemberFindFirst.mockResolvedValue({ workspaceId: "ws-fallback" });
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({ sent: 1 });
    expect(mailer.sendMail.mock.calls[0][0]).toBe("ws-fallback");
  });
});
