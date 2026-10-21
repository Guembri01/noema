import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  webhookUpdate: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  fetch: vi.fn(),
}));

// B11 — the delivery path resolves the target host before every attempt, so
// DNS is mocked here exactly like in the calendar suite (hermetic, no network).
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhook: { findMany: mocks.webhookFindMany, update: mocks.webhookUpdate },
    webhookDelivery: { create: mocks.deliveryCreate, update: mocks.deliveryUpdate },
  },
}));

vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

// Spy on the shared signer while keeping its real behaviour, so a delivery test
// can prove the dispatcher actually goes through `signPayload` (one signing
// implementation) rather than a private re-implementation that merely happens
// to agree today.
const sigMocks = vi.hoisted(() => ({ signPayload: vi.fn() }));

vi.mock("@/lib/webhook-signature", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhook-signature")>();
  sigMocks.signPayload.mockImplementation(actual.signPayload);
  return { ...actual, signPayload: sigMocks.signPayload };
});

import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  deliverWithRetry,
  deliveryDueTimes,
  dispatchWebhooks,
  encryptWebhookSecret,
  signWebhookV2,
  verifyWebhookSignature,
} from "./webhooks";
import { signPayload, verifySignature } from "@/lib/webhook-signature";

const originalFetch = globalThis.fetch;

const SECRET = "s3cr3t";
const BODY = '{"event":"page.created","workspaceId":"ws_123"}';
const T0 = 1760000000000;
/** Independent vectors (raw node crypto), NOT produced by the implementation. */
const V2_HEX = "071ccbd6a9833880ab07819e9413d3096556478b5d2c67e7d975564534ab6836";
const V1_HEX = "64fab47f92653e3551700d9061a9ef1d6d5eeab1f7ac1852f56a201adf4e4d7d";

const HOOK = { id: "hook_1", url: "https://receiver.test/hook", secret: SECRET };

const http = (status: number) => ({ ok: status >= 200 && status < 300, status });

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeAll(() => {
  // B63 — sealing a secret derives the envelope key from AUTH_SECRET.
  process.env.AUTH_SECRET = "webhook-delivery-test-key-0123456789ab";
});

afterAll(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
});

beforeEach(() => {
  mocks.webhookFindMany.mockReset().mockResolvedValue([{ ...HOOK, events: [] }]);
  mocks.webhookUpdate.mockReset().mockResolvedValue({ id: HOOK.id });
  mocks.deliveryCreate.mockReset().mockImplementation(async (args: { data: { id?: string } }) => ({
    id: "del_1",
    ...args.data,
  }));
  mocks.deliveryUpdate.mockReset().mockImplementation(
    async (args: { where: { id: string } }) => ({ id: args.where.id }),
  );
  mocks.fetch.mockReset().mockResolvedValue(http(200));
  // A public answer for every hook host unless a test says otherwise.
  dns.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  globalThis.fetch = mocks.fetch as unknown as typeof fetch;
  // Keep the real implementation installed by the module mock; only reset calls.
  sigMocks.signPayload.mockClear();
  // The operator opt-in for loopback targets must never leak into the suite
  // from the developer's environment; the tests that need it set it explicitly.
  vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

/**
 * B63 — a hook that was created before the signing secrets were sealed (R28.17)
 * still holds its secret in cleartext. The secret is the shared key of the
 * webhook, so a database dump of such a row yields it. The delivery path seals
 * the row as it reads it, so the plaintext leaves the database without an
 * operator step.
 */
describe("the legacy plaintext row is sealed at rest (B63)", () => {
  it("seals the secret of a hook that still holds it in cleartext", async () => {
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    expect(mocks.webhookUpdate).toHaveBeenCalledTimes(1);
    const write = mocks.webhookUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { secret: string };
    };
    expect(write.where).toEqual({ id: HOOK.id });
    expect(write.data.secret).toMatch(/^v2:/);
    expect(write.data.secret).not.toContain(SECRET);
  });

  it("never touches a row that already holds an envelope", async () => {
    await deliverWithRetry(
      { ...HOOK, secret: encryptWebhookSecret(SECRET) },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.webhookUpdate).not.toHaveBeenCalled();
  });

  it("still signs the delivery with the same secret after sealing it", async () => {
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    const init = mocks.fetch.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
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
});

describe("delivery-time subscription matching (B91)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const hookWith = (events: string[]) => [{ ...HOOK, events }];

  it("delivers when the hook subscribes via the `*` wildcard", async () => {
    mocks.webhookFindMany.mockResolvedValue(hookWith(["*"]));
    await dispatchWebhooks("ws_1", "comment.created", { commentId: "c1" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
  });

  it("delivers when the hook subscribes via a `page.*` prefix", async () => {
    mocks.webhookFindMany.mockResolvedValue(hookWith(["page.*"]));
    await dispatchWebhooks("ws_1", "page.updated", { pageId: "p1" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
  });

  it("still delivers an exact-id subscription", async () => {
    mocks.webhookFindMany.mockResolvedValue(hookWith(["page.created"]));
    await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  });

  it("skips a hook whose subscriptions select nothing for the event", async () => {
    mocks.webhookFindMany.mockResolvedValue(hookWith(["comment.created"]));
    await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" });
    await flush();
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("skips a `page.*` hook for a non-page event", async () => {
    mocks.webhookFindMany.mockResolvedValue(hookWith(["page.*"]));
    await dispatchWebhooks("ws_1", "comment.created", { commentId: "c1" });
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("shared signing scheme — dispatcher ⇄ verifier (D24)", () => {
  // A fixed clock is injected via `Date.now`, so the timestamp bound into the
  // MAC is deterministic and nothing here depends on the wall clock.
  const NOW = T0;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Dispatch one delivery with `Date.now` pinned and return the fetch init. */
  const captureDelivery = async (): Promise<{
    body: string;
    headers: Record<string, string>;
  }> => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await dispatchWebhooks("ws_1", "page.created", { pageId: "p1" });
      for (let i = 0; i < 10 && mocks.fetch.mock.calls.length === 0; i += 1) {
        await flush();
      }
    } finally {
      nowSpy.mockRestore();
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    return mocks.fetch.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
  };

  it("delivers through the shared signPayload (one signing implementation)", async () => {
    const init = await captureDelivery();

    expect(sigMocks.signPayload).toHaveBeenCalledTimes(1);
    const [payload, secret, options] = sigMocks.signPayload.mock.calls[0] as [
      string,
      string,
      { timestamp?: number },
    ];
    expect(payload).toBe(init.body);
    expect(secret).toBe(SECRET);
    expect(options.timestamp).toBe(NOW);

    // The emitted header is the shared, timestamp-bound canonical form.
    expect(init.headers["x-noema-signature"]).toMatch(
      new RegExp(`^t=${NOW},v1=[0-9a-f]{64}$`),
    );
  });

  it("round-trips the sender-built payload through the shared verifier", async () => {
    const init = await captureDelivery();
    const signature = init.headers["x-noema-signature"];
    const timestamp = init.headers["x-noema-timestamp"];

    // The sender-built JSON body verifies as-is with the shared verifier.
    expect(verifySignature(init.body, signature, SECRET, { now: NOW })).toEqual({ ok: true });
    expect(timestamp).toBe(String(NOW));
    // …and through the server-side wrapper, companion header included.
    expect(
      verifyWebhookSignature({ secret: SECRET, body: init.body, signature, timestamp, now: NOW }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const init = await captureDelivery();
    const signature = init.headers["x-noema-signature"];

    expect(verifySignature(`${init.body} `, signature, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "no_match",
    });
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: `${init.body} `,
        signature,
        timestamp: init.headers["x-noema-timestamp"],
        now: NOW,
      }),
    ).toBe(false);
  });

  it("is canonical-key-order stable for the delivery payload", () => {
    const payload = { event: "page.created", workspaceId: "ws_1", data: { pageId: "p1" } };
    const reordered = { workspaceId: "ws_1", data: { pageId: "p1" }, event: "page.created" };
    const signature = signPayload(payload, SECRET, { timestamp: NOW });

    // Same payload, different insertion order ⇒ identical signature, and the
    // reordered object verifies against it.
    expect(signPayload(reordered, SECRET, { timestamp: NOW })).toBe(signature);
    expect(verifySignature(reordered, signature, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("delegates v2 verification to the shared parser (multiple v1 values)", () => {
    const good = signWebhookV2(SECRET, BODY, T0).split("v1=")[1];
    const header = `t=${T0},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature: header, now: T0 })).toBe(
      true,
    );
  });

  it("delegates v2 verification to the shared parser (whitespace tolerated)", () => {
    const header = ` t=${T0} , v1=${V2_HEX} `;
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature: header, now: T0 })).toBe(
      true,
    );
  });
});

/**
 * B11 — an outbound webhook may not point at an internal service: the delivery
 * would make the server POST to that host and the HTTP status would land in
 * the delivery log (a status oracle for the internal network).
 *
 * The guard (`src/lib/feed-guard.ts`) runs before EVERY attempt - a check at
 * creation time alone does not cover DNS rebinding or a target that changed
 * after the hook was stored.
 */
describe("B11 - SSRF guard on the delivery path", () => {
  it("never contacts a private target and records one uniform refusal", async () => {
    await deliverWithRetry(
      { ...HOOK, url: "http://10.0.0.5:8080/admin" },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    const recorded = mocks.deliveryUpdate.mock.calls[0][0] as {
      data: { attempts: number; ok: boolean; responseStatus: number | null; error: string };
    };
    expect(recorded.data).toMatchObject({ attempts: 1, ok: false, responseStatus: null });
    expect(recorded.data.error).toBeTruthy();
    expect(recorded.data.error).not.toMatch(/\d/); // no status code leaks
  });

  it("refuses a name that resolves into private space (rebinding)", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
  });

  it("re-checks the target before every attempt", async () => {
    // Attempt 1 resolves to a public address, attempt 2 to a private one.
    dns.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    mocks.fetch.mockResolvedValue(http(500));

    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1); // the second attempt never went out
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      data: { attempts: 1, ok: false, responseStatus: 500 },
    });
    expect(mocks.deliveryUpdate.mock.calls[1][0]).toMatchObject({
      data: { attempts: 2, ok: false, responseStatus: null },
    });
  });

  it("still delivers to a public target (the guard resolves it first)", async () => {
    await deliverWithRetry(HOOK, "page.created", BODY, {
      deliveryId: "del_1",
      sleep: async () => {},
    });

    expect(dns.lookup).toHaveBeenCalledWith("receiver.test", expect.objectContaining({ all: true }));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * B11 follow-up — the operator opt-in for the loopback range.
 *
 * The shipped payload runs with `NODE_ENV=production` and the live check
 * `scripts/check-webhooks.mjs` registers a hook on the hermetic receiver on
 * `127.0.0.1:4280`. The delivery guard refuses a loopback target in
 * production unless the operator opts in explicitly
 * (`NOEMA_ALLOW_LOOPBACK_TARGETS=1`); the opt-in opens the loopback range
 * only.
 */
describe("B11 - SSRF guard on the delivery path (operator opt-in)", () => {
  it("delivers to a loopback target when the operator opted in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");

    await deliverWithRetry(
      { ...HOOK, url: "http://127.0.0.1:4280/hook" },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:4280/hook");
    expect(mocks.deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ok: true }) }),
    );
  });

  it("refuses a loopback target in production without the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", undefined);

    await deliverWithRetry(
      { ...HOOK, url: "http://127.0.0.1:4280/hook" },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      data: { attempts: 1, ok: false, responseStatus: null },
    });
  });

  it("still refuses the other private ranges with the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");

    for (const url of [
      "http://10.0.0.5:8080/admin",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      await deliverWithRetry(
        { ...HOOK, url },
        "page.created",
        BODY,
        { deliveryId: "del_1", sleep: async () => {} },
      );
    }

    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

/**
 * B21 — a delivery that cannot be signed is never sent.
 *
 * The signing secret is sealed at rest (R28.17). When the envelope cannot be
 * opened — the `AUTH_SECRET` was rotated, or the ciphertext is corrupt —
 * `decryptWebhookSecret` answers `null`, and `signatureHeaders` then wrote
 * NO `x-noema-signature` header at all: the payload went out unsigned and was
 * booked as a success on a 2xx. A receiver that only asks whether the header
 * is present accepted a manipulated payload that way.
 *
 * The delivery is refused instead: nothing is sent, and the delivery row
 * records the failure.
 */
describe("B21 - an unsigned delivery is never sent", () => {
  const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

  beforeAll(() => {
    // The envelope key is derived from AUTH_SECRET, so the test needs one.
    process.env.AUTH_SECRET = "webhook-b21-secret-key-0123456789ab";
  });

  afterAll(() => {
    if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  });

  it("refuses the delivery and books it as failed when the secret cannot be decrypted", async () => {
    // Seal a secret under the current AUTH_SECRET …
    const sealed = encryptWebhookSecret("whsec_b21_rotated");
    // … then rotate the key: the envelope can no longer be opened.
    process.env.AUTH_SECRET = "webhook-b21-secret-key-0123456789cd";

    await deliverWithRetry(
      { ...HOOK, secret: sealed },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    // Nothing went out: an unsigned payload is never sent.
    expect(mocks.fetch).not.toHaveBeenCalled();

    // The delivery is booked as failed, with the reason.
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    const recorded = mocks.deliveryUpdate.mock.calls[0][0] as {
      data: { attempts: number; ok: boolean; responseStatus: number | null; error: string };
    };
    expect(recorded.data).toMatchObject({ attempts: 1, ok: false, responseStatus: null });
    expect(recorded.data.error).toBeTruthy();
    expect(recorded.data.error).not.toMatch(/whsec/); // no secret material in the log
  });

  it("still signs and delivers when the secret opens", async () => {
    process.env.AUTH_SECRET = "webhook-b21-secret-key-0123456789ab";
    const sealed = encryptWebhookSecret("whsec_b21_ok");

    await deliverWithRetry(
      { ...HOOK, secret: sealed },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(init.headers["x-noema-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: "whsec_b21_ok",
        body: init.body,
        signature: init.headers["x-noema-signature"],
        timestamp: init.headers["x-noema-timestamp"],
        now: Date.now(),
      }),
    ).toBe(true);
    expect(mocks.deliveryUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      data: { attempts: 1, ok: true, responseStatus: 200 },
    });
  });

  // The two neighbours of the fixed case keep their documented behaviour: the
  // legacy plaintext secret (the M28.3 transition window) is still SIGNED, and
  // a hook with no secret at all keeps the unsigned wire format.
  it("still signs the delivery with a legacy plaintext secret", async () => {
    process.env.AUTH_SECRET = "webhook-b21-secret-key-0123456789ab";

    await deliverWithRetry(
      { ...HOOK, secret: "legacy-plaintext-secret" },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(init.headers["x-noema-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: "legacy-plaintext-secret",
        body: init.body,
        signature: init.headers["x-noema-signature"],
        timestamp: init.headers["x-noema-timestamp"],
        now: Date.now(),
      }),
    ).toBe(true);
  });

  it("still delivers a hook that never had a secret, unsigned", async () => {
    process.env.AUTH_SECRET = "webhook-b21-secret-key-0123456789ab";

    await deliverWithRetry(
      { ...HOOK, secret: null },
      "page.created",
      BODY,
      { deliveryId: "del_1", sleep: async () => {} },
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["x-noema-signature"]).toBeUndefined();
    expect(mocks.deliveryUpdate.mock.calls[0][0]).toMatchObject({
      data: { attempts: 1, ok: true, responseStatus: 200 },
    });
  });
});
