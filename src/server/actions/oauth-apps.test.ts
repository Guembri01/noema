import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * `src/server/actions/oauth-apps.ts` — the client secret must never reach the
 * database in cleartext.
 *
 * The action mints the secret, hands it back exactly once (the UI shows it in
 * a copy box) and stores only its SHA-256 digest. The assertions are a
 * sign → store → verify round trip: the returned plaintext hashes to the
 * stored digest, and the row carries no plaintext field at all.
 */

const db = vi.hoisted(() => ({
  oAuthAppCreate: vi.fn(),
  oAuthAppDeleteMany: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthApp: { create: db.oAuthAppCreate, deleteMany: db.oAuthAppDeleteMany },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createOAuthAppAction } from "./oauth-apps";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The `data` payload of the last `oAuthApp.create` call. */
function createdData(): Record<string, unknown> {
  const calls = db.oAuthAppCreate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1", email: "dev@example.test" });
  db.oAuthAppCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "app-1",
    ...data,
  }));
});

describe("createOAuthAppAction", () => {
  it("stores only the digest of the client secret and returns the plaintext once", async () => {
    const result = await createOAuthAppAction("My app", "https://app.example.test/cb");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.clientSecret).toBeTruthy();
    expect(result.clientId).toMatch(/^noema_/);

    const data = createdData();
    expect(data.clientSecretHash).toBe(sha256(result.clientSecret));
    // The plaintext is never written to the row.
    expect(data.clientSecret).toBeUndefined();
    expect(data.clientSecretHash).not.toBe(result.clientSecret);
  });

  it("never leaks the secret into the persisted row", async () => {
    const result = await createOAuthAppAction("My app", "https://app.example.test/cb");
    if ("error" in result) throw new Error(result.error);

    const serialized = JSON.stringify(createdData());
    expect(serialized).not.toContain(result.clientSecret);
  });

  it("rejects a registration without a redirect URI before touching the database", async () => {
    const result = await createOAuthAppAction("My app", "   ");
    expect(result).toEqual({ error: "Add at least one redirect URI." });
    expect(db.oAuthAppCreate).not.toHaveBeenCalled();
  });
});
