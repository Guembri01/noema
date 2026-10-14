import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B56 — webhook durability: signed payload v2 (R24.13), backoff schedule
 * (R24.11) and one-row-per-logical-delivery logging (R24.12).
 *
 * Prisma (`@/lib/db`) and `globalThis.fetch` are mocked; the retry sleep is
 * injected so the full 5-attempt schedule runs instantly. The signature known
 * vector below was produced independently with `node:crypto`, not with the
 * implementation under test.
 */

const mocks = vi.hoisted(() => ({
  webhookFindMany: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhook: { findMany: mocks.webhookFindMany },
    webhookDelivery: { create: mocks.deliveryCreate, update: mocks.deliveryUpdate },
  },
}));

import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  deliverWithRetry,
  deliveryDueTimes,
  dispatchWebhooks,
  signWebhookV2,
  verifyWebhookSignature,
} from "./webhooks";

const originalFetch = globalThis.fetch;

const SECRET = "s3cr3t";
const BODY = '{"event":"page.created","workspaceId":"ws_123"}';
const T0 = 1760000000000;
/** Independent vectors (raw node crypto), NOT produced by the implementation. */
const V2_HEX = "071ccbd6a9833880ab07819e9413d3096556478b5d2c67e7d975564534ab6836";
const V1_HEX = "64fab47f92653e3551700d9061a9ef1d6d5eeab1f7ac1852f56a201adf4e4d7d";

const HOOK = { id: "hook_1", url: "https://receiver.test/hook", secret: SECRET };

const http = (status: number) => ({ ok: status >= 200 && status < 300, status });

beforeEach(() => {
  mocks.webhookFindMany.mockReset().mockResolvedValue([{ ...HOOK, events: [] }]);
  mocks.deliveryCreate.mockReset().mockImplementation(async (args: { data: { id?: string } }) => ({
    id: "del_1",
    ...args.data,
  }));
  mocks.deliveryUpdate.mockReset().mockImplementation(
    async (args: { where: { id: string } }) => ({ id: args.where.id }),
  );
  mocks.fetch.mockReset().mockResolvedValue(http(200));
  globalThis.fetch = mocks.fetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("signature v2 — canonical string (R24.13)", () => {
  it("emits t=<unixMs>,v1=<hmac of `<t>.<rawBody>`> for the known vector", () => {
    expect(signWebhookV2(SECRET, BODY, T0)).toBe(`t=${T0},v1=${V2_HEX}`);
  });

  it("binds the timestamp into the MAC (different t ⇒ different v1)", () => {
    const atT0 = signWebhookV2(SECRET, BODY, T0).split("v1=")[1];
    const atT1 = signWebhookV2(SECRET, BODY, T0 + 1).split("v1=")[1];
    expect(atT0).toBe(V2_HEX);
    expect(atT1).not.toBe(atT0);
  });

  it("verifies a fresh, untampered signature", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0,
        now: T0,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: `${BODY} `,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0,
        now: T0,
      }),
    ).toBe(false);
  });

  it("rejects a tampered timestamp (t swapped, v1 kept)", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: `t=${T0 + 1},v1=${V2_HEX}`,
        timestamp: T0 + 1,
        now: T0 + 1,
      }),
    ).toBe(false);
  });

  it("rejects an old timestamp outside the 300 s window", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0,
        now: T0 + 300_001,
      }),
    ).toBe(false);
  });

  it("accepts the exact 300 s boundary (rejection is strictly beyond)", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0,
        now: T0 + 300_000,
      }),
    ).toBe(true);
  });

  it("rejects a future timestamp outside the window", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0,
        now: T0 - 300_001,
      }),
    ).toBe(false);
  });

  it("rejects when x-noema-timestamp disagrees with the t inside the signature", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        signature: signWebhookV2(SECRET, BODY, T0),
        timestamp: T0 + 500,
        now: T0,
      }),
    ).toBe(false);
  });

  it("keeps verifying the legacy bare-HMAC (v1) form", () => {
    expect(
      verifyWebhookSignature({ secret: SECRET, body: BODY, signature: V1_HEX, now: T0 }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({ secret: SECRET, body: `${BODY}!`, signature: V1_HEX, now: T0 }),
    ).toBe(false);
  });

  it("rejects malformed or empty signatures", () => {
    for (const signature of ["", "deadbeef", "t=abc,v1=zz", `t=${T0},v1=${V2_HEX}z`]) {
      expect(
        verifyWebhookSignature({ secret: SECRET, body: BODY, signature, now: T0 }),
      ).toBe(false);
    }
  });
});

describe("backoff schedule (R24.11)", () => {
  it("is 0 s / 2 s / 8 s / 30 s / 2 min over 5 attempts", () => {
    expect([...WEBHOOK_BACKOFF_MS]).toEqual([0, 2_000, 8_000, 30_000, 120_000]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(WEBHOOK_BACKOFF_MS.length);
  });

  it("computes due times for all 5 attempts from a fake clock start", () => {
    const start = 1_760_000_000_000;
    expect(deliveryDueTimes(start)).toEqual([
      start,
      start + 2_000,
      start + 10_000,
      start + 40_000,
      start + 160_000,
    ]);
  });

  it("produces strictly increasing due times", () => {
    const due = deliveryDueTimes(1_000);
    for (let i = 1; i < due.length; i += 1) {
      expect(due[i]).toBeGreaterThan(due[i - 1]);
    }
    expect(due).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
  });
});

describe("one row per logical delivery (R24.10–R24.12)", () => {
  it("persists the outbox row before any network I/O and sends deliveryId + v2 signature", async () => {
    await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

    // Outbox write happens first.
    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryCreate.mock.calls[0][0]).toMatchObject({
      data: { webhookId: HOOK.id, event: "page.created", ok: false, attempts: 0 },
    });
    expect(mocks.deliveryCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetch.mock.invocationCallOrder[0],
    );

    const init = mocks.fetch.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
      redirect: string;
    };
    expect(init.redirect).toBe("manual");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      deliveryId: "del_1",
      event: "page.created",
      workspaceId: "ws_1",
      data: { pageId: "p1" },
    });
    expect(typeof payload.sentAt).toBe("string");

    expect(init.headers["x-noema-timestamp"]).toBeDefined();
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: init.body,
        signature: init.headers["x-noema-signature"],
        timestamp: init.headers["x-noema-timestamp"],
        now: Date.now(),
      }),
    ).toBe(true);
  });

  it("first-try success records exactly one row with attempts = 1", async () => {
    await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" });
    await vi.waitFor(() => expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1));

    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "del_1" },
      data: { attempts: 1, ok: true, responseStatus: 200, error: null },
    });
  });

  it("all 5 attempts failing record exactly one row (attempts = 5) and sleep 2s/8s/30s/2min", async () => {
    mocks.fetch.mockResolvedValue(http(500));
    const sleeps: number[] = [];
    await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" }, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await vi.waitFor(() => expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(5), {
      timeout: 5_000,
    });

    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([2_000, 8_000, 30_000, 120_000]);
    for (const [i, call] of mocks.deliveryUpdate.mock.calls.entries()) {
      expect(call[0]).toMatchObject({
        where: { id: "del_1" },
        data: { attempts: i + 1, ok: false, responseStatus: 500, error: "HTTP 500" },
      });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });

  it("counts a 3xx as a failed attempt without following the redirect", async () => {
    mocks.fetch.mockResolvedValue(http(302));
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    const init = mocks.fetch.mock.calls[0][1] as { redirect: string };
    expect(init.redirect).toBe("manual");
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(5);
    expect(mocks.deliveryUpdate.mock.calls[4][0]).toMatchObject({
      data: { attempts: 5, ok: false, responseStatus: 302, error: "HTTP 302" },
    });
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
  });

  it("records a network error, then success, on the same row (attempts = 2, ok = true)", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:9"))
      .mockResolvedValueOnce(http(204));
    const sleeps: number[] = [];
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([2_000]);
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      data: {
        attempts: 1,
        ok: false,
        responseStatus: null,
        error: "connect ECONNREFUSED 127.0.0.1:9",
      },
    });
    expect(mocks.deliveryUpdate.mock.calls[1][0]).toMatchObject({
      data: { attempts: 2, ok: true, responseStatus: 204, error: null },
    });
  });

  it("falls back to creating the row once when the outbox write never happened", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(http(200));
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: null,
      sleep: async () => {},
    });

    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryCreate.mock.calls[0][0]).toMatchObject({
      data: { webhookId: HOOK.id, event: "page.created", attempts: 1, ok: false },
    });
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "del_1" },
      data: { attempts: 2, ok: true, responseStatus: 200, error: null },
    });
  });
});
