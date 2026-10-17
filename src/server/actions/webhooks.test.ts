import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B11 — outbound webhooks may not point at internal services.
 *
 * `createWebhookAction` used to validate the scheme only, so an admin could
 * store `http://10.0.0.5:8080/admin` and every later page edit made the
 * server POST to that internal host; the HTTP status landed in the delivery
 * log, which turned the feature into a status oracle for the internal
 * network.
 *
 * The guard is the one the calendar feed path already runs
 * (`src/lib/feed-guard.ts`); DNS is mocked so the suite stays hermetic.
 * Red-first: before the guard every PRIVATE_TARGETS entry was persisted.
 */

const db = vi.hoisted(() => ({ webhookCreate: vi.fn() }));
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { webhook: { create: db.webhookCreate } },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "OWNER" })),
  canManageMembers: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { createWebhookAction } from "./webhooks";

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeAll(() => {
  // The signing secret is sealed with the keyring (R28.17) - it needs a key.
  process.env.AUTH_SECRET = "webhook-ssrf-test-key-0123456789ab";
});

afterAll(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  db.webhookCreate.mockResolvedValue({ id: "hook-1" });
  dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  // The operator opt-in for loopback targets must never leak into the suite
  // from the developer's environment; the tests that need it set it explicitly.
  vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every one of these is an internal service the server must never contact. */
const PRIVATE_TARGETS = [
  "http://127.0.0.1:8080/admin",
  "http://10.0.0.5:8080/admin",
  "http://172.16.0.9/hook",
  "http://192.168.1.10/hook",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:9000/hook",
  "http://2130706433/hook", // decimal IPv4 - WHATWG canonicalises to 127.0.0.1
  "http://localhost:3000/hook",
  "http://metadata.google.internal/latest/meta-data/",
];

const create = (url: string) =>
  createWebhookAction({
    workspaceId: "ws-1",
    url,
    events: ["page.created"],
    secret: "s3cr3t",
  });

const failureOf = (result: Awaited<ReturnType<typeof createWebhookAction>>): string =>
  "error" in result ? result.error : "";

describe("createWebhookAction - SSRF guard (B11)", () => {
  it("refuses every private target and persists nothing", async () => {
    for (const url of PRIVATE_TARGETS) {
      const result = await create(url);
      expect(failureOf(result), url).not.toBe("");
    }
    expect(db.webhookCreate).not.toHaveBeenCalled();
  });

  it("answers every refusal with one uniform message (no status oracle)", async () => {
    const messages = new Set<string>();
    for (const url of PRIVATE_TARGETS) {
      messages.add(failureOf(await create(url)));
    }
    // A name that resolves into private space fails exactly like a literal.
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    messages.add(failureOf(await create("https://receiver.test/hook")));
    // …and so does a resolver failure (fail closed).
    dns.lookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    messages.add(failureOf(await create("https://gone.test/hook")));

    expect(messages.size).toBe(1);
    const [message] = [...messages];
    // The one message must be an actual refusal - without this the set would
    // hold the empty string of a successful create and the test would pass
    // vacuously.
    expect(message).not.toBe("");
    expect(message).not.toMatch(/\d/); // nothing about the target leaks
  });

  it("refuses a name that resolves into private space (DNS rebinding)", async () => {
    dns.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const result = await create("https://receiver.test/hook");
    expect(failureOf(result)).not.toBe("");
    expect(db.webhookCreate).not.toHaveBeenCalled();
  });

  it("still creates a hook for a public target", async () => {
    const result = await create("https://receiver.test/hook");
    expect(result).toEqual({ ok: true });
    expect(db.webhookCreate).toHaveBeenCalledTimes(1);
    expect(db.webhookCreate.mock.calls[0][0]).toMatchObject({
      data: { workspaceId: "ws-1", url: "https://receiver.test/hook" },
    });
    expect(dns.lookup).toHaveBeenCalledWith("receiver.test", expect.objectContaining({ all: true }));
  });
});

/**
 * B11 follow-up — the operator opt-in for the loopback range.
 *
 * The shipped payload runs with `NODE_ENV=production`, and the live check
 * `scripts/check-webhooks.mjs` registers a hook on the hermetic receiver on
 * `127.0.0.1:4280`. The creation gate refuses a loopback target in
 * production unless the operator opts in explicitly
 * (`NOEMA_ALLOW_LOOPBACK_TARGETS=1`); the opt-in opens the loopback range
 * only.
 */
describe("createWebhookAction - SSRF guard (B11, operator opt-in)", () => {
  it("creates a hook for a loopback target when the operator opted in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");

    const result = await create("http://127.0.0.1:4280/hook");
    expect(result).toEqual({ ok: true });
    expect(db.webhookCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses a loopback target in production without the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", undefined);

    const result = await create("http://127.0.0.1:4280/hook");
    expect(failureOf(result)).not.toBe("");
    expect(db.webhookCreate).not.toHaveBeenCalled();
  });

  it("still refuses the other private ranges with the opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOEMA_ALLOW_LOOPBACK_TARGETS", "1");

    for (const url of [
      "http://10.0.0.5:8080/admin",
      "http://172.16.0.9/hook",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/latest/meta-data/",
    ]) {
      const result = await create(url);
      expect(failureOf(result), url).not.toBe("");
    }
    expect(db.webhookCreate).not.toHaveBeenCalled();
  });
});
