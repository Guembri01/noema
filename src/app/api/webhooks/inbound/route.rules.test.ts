import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B18 — the rule list of an inbound endpoint belongs to the endpoint.
 *
 * The route read the rules from the request — the `?rules=` query parameter or
 * the `x-noema-rules` header — and planned the actions of THAT list, so the
 * caller decided which actions the endpoint would run. The list is read from
 * the `Webhook` row now, the row the request was authenticated against, and a
 * rule list in the request is ignored.
 *
 * Only the transport edges (the database, the rate limiter) are mocked; the
 * signature verification, the payload normalisation and the planner run for
 * real.
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

const SECRET = "whsec-inbound-rules-fixture";
const BODY = JSON.stringify({ kind: "custom", text: "hello" });

/** The endpoint as the database holds it — its own rule list included. */
function endpoint(rules: unknown) {
  return {
    id: "hook-1",
    workspaceId: "ws-1",
    secret: SECRET,
    events: ["custom"],
    rules,
    active: true,
  };
}

/**
 * A signed request. `injected` is the rule list a caller tries to smuggle in
 * — as the query parameter and as the header, so both paths are covered.
 */
function post(injected: unknown = null) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-webhook-signature": createHmac("sha256", SECRET).update(BODY).digest("hex"),
  };
  const url = new URL("http://localhost/api/webhooks/inbound?endpoint=hook-1");
  if (injected !== null) {
    const encoded = JSON.stringify(injected);
    url.searchParams.set("rules", encoded);
    headers["x-noema-rules"] = encoded;
  }
  return POST(new Request(url, { method: "POST", headers, body: BODY }));
}

/** The rule the endpoint stores. */
const STORED_RULE = [{ id: "r1", actions: [{ type: "comment", body: "stored" }] }];

/** The rule a caller would like the endpoint to run. */
const INJECTED_RULE = [{ id: "evil", actions: [{ type: "comment", body: "injected" }] }];

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryFindMany.mockResolvedValue([]);
  db.deliveryCreate.mockResolvedValue({ id: "del-1" });
  db.webhookUpdate.mockResolvedValue({ id: "hook-1" });
});

describe("POST /api/webhooks/inbound — the rules come from the endpoint", () => {
  it("plans the actions of the rule list the endpoint stores", async () => {
    db.webhookFindUnique.mockResolvedValue(endpoint(STORED_RULE));

    const res = await post();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      endpoint: "hook-1",
      workspaceId: "ws-1",
      actions: [{ type: "comment", ruleId: "r1", body: "stored" }],
    });
  });

  it("ignores a rule list the caller smuggles into the request", async () => {
    db.webhookFindUnique.mockResolvedValue(endpoint(STORED_RULE));

    const res = await post(INJECTED_RULE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toEqual([{ type: "comment", ruleId: "r1", body: "stored" }]);
    expect(JSON.stringify(body)).not.toContain("injected");
  });

  it("plans nothing when the caller sends a rule list and the endpoint has none", async () => {
    db.webhookFindUnique.mockResolvedValue(endpoint([]));

    const res = await post(INJECTED_RULE);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, actions: [] });
  });

  it("plans nothing when the stored rule list is malformed", async () => {
    db.webhookFindUnique.mockResolvedValue(endpoint({ not: "a list" }));

    const res = await post();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, actions: [] });
  });
});
