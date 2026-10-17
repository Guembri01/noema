import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B63 — the inbound webhook route must verify the provider's signature against
 * the *secret*, not against the value the database happens to hold.
 *
 * `createWebhookAction` seals the signing secret (AES-256-GCM, `v2:…`), so the
 * column `Webhook.secret` holds an envelope. The route read that column and
 * handed it to `verifySignature` as the shared secret: the MAC was then
 * computed over the CIPHERTEXT and could never match the MAC the provider
 * computed over the plaintext, so every signed inbound request was refused.
 *
 * The route now opens the envelope first and refuses an endpoint whose secret
 * cannot be opened — fail-closed, and never "verify with the ciphertext".
 */

const db = vi.hoisted(() => ({
  webhookFindUnique: vi.fn(),
  webhookUpdate: vi.fn(),
  deliveryFindMany: vi.fn(),
  deliveryCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhook: { findUnique: db.webhookFindUnique, update: db.webhookUpdate },
    webhookDelivery: { findMany: db.deliveryFindMany, create: db.deliveryCreate },
  },
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

import { POST } from "./route";
import { encryptWebhookSecret } from "@/lib/webhooks";

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeAll(() => {
  // The envelope key is derived from AUTH_SECRET (B55 rules) — the suite
  // needs one that the rule accepts.
  process.env.AUTH_SECRET = "inbound-webhook-test-key-0123456789abcdef";
});

afterAll(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
});

/** The shared secret of the endpoint — never what the database holds. */
const SECRET = "whsec-inbound-fixture-value";
const BODY = JSON.stringify({ kind: "custom", text: "hello" });

/** The MAC a provider computes over the raw body with the shared secret. */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function post(signature: string | null, body = BODY) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-webhook-signature"] = signature;
  return POST(
    new Request("http://localhost/api/webhooks/inbound?endpoint=hook-1", {
      method: "POST",
      headers,
      body,
    }),
  );
}

/** The endpoint as the database holds it: the secret is SEALED. */
function sealedEndpoint(secret = encryptWebhookSecret(SECRET)) {
  return {
    id: "hook-1",
    workspaceId: "ws-1",
    secret,
    events: ["custom"],
    active: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryFindMany.mockResolvedValue([]);
  db.deliveryCreate.mockResolvedValue({ id: "del-1" });
  db.webhookUpdate.mockResolvedValue({ id: "hook-1" });
});

describe("POST /api/webhooks/inbound — the signature is verified against the secret", () => {
  it("accepts a request the provider signed with the secret of a sealed endpoint", async () => {
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint());

    const res = await post(sign(SECRET, BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      endpoint: "hook-1",
      workspaceId: "ws-1",
      provider: "generic",
    });
  });

  it("never verifies with the stored value — a MAC over the ciphertext is refused", async () => {
    const stored = encryptWebhookSecret(SECRET);
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint(stored));

    // The attacker knows the DATABASE value (a dump) and signs with it.
    const res = await post(sign(stored, BODY));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid signature",
      reason: "no_match",
    });
  });

  it("refuses a request signed with the wrong secret", async () => {
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint());

    const res = await post(sign("another-secret", BODY));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid signature",
      reason: "no_match",
    });
  });

  it("refuses an endpoint whose secret cannot be opened (fail-closed, one message)", async () => {
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint("v2:1:aaaa:bbbb:cccc"));

    const res = await post(sign(SECRET, BODY));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Endpoint has no signing secret",
    });
  });
});

describe("POST /api/webhooks/inbound — the legacy plaintext row is sealed at rest", () => {
  it("still accepts a request signed with the secret of a pre-sealing row", async () => {
    // A row written before the secrets were sealed holds the plaintext.
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint(SECRET));

    const res = await post(sign(SECRET, BODY));

    expect(res.status).toBe(200);
  });

  it("seals the plaintext once the request proved that the endpoint works", async () => {
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint(SECRET));

    await post(sign(SECRET, BODY));

    expect(db.webhookUpdate).toHaveBeenCalledTimes(1);
    const write = db.webhookUpdate.mock.calls[0][0];
    expect(write.where).toEqual({ id: "hook-1" });
    expect(write.data.secret).toMatch(/^v2:/);
    expect(write.data.secret).not.toBe(SECRET);
  });

  it("does not touch a row that already holds an envelope", async () => {
    db.webhookFindUnique.mockResolvedValue(sealedEndpoint());

    await post(sign(SECRET, BODY));

    expect(db.webhookUpdate).not.toHaveBeenCalled();
  });
});
