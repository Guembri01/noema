import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B07 — the local signup is the other half of the fix.
 *
 * A local signup proves nothing about the address it registers: the account
 * must therefore stay unverified, so a provider sign-in may not link it
 * silently (account pre-hijacking — the address may have been registered by
 * somebody else before the real owner showed up). Only the local password
 * gets the new account in, until the address is proven.
 *
 * Only the database edge is mocked; the schema, the password policy and the
 * action itself are the real modules.
 */

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceCreate: vi.fn(),
  pageCreate: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: h.userFindUnique, create: h.userCreate },
    workspace: { findUnique: h.workspaceFindUnique, create: h.workspaceCreate },
    page: { create: h.pageCreate },
  },
}));

vi.mock("@/lib/auth", () => ({
  createSession: h.createSession,
  destroySession: vi.fn(),
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  verifyPassword: vi.fn(async () => false),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { signupAction } from "./auth";

/** A form the action can read. */
function signupForm(name: string, email: string, password: string): FormData {
  const form = new FormData();
  form.set("name", name);
  form.set("email", email);
  form.set("password", password);
  return form;
}

describe("signupAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindUnique.mockResolvedValue(null);
    h.userCreate.mockResolvedValue({ id: "user-1" });
    h.workspaceFindUnique.mockResolvedValue(null);
    h.workspaceCreate.mockResolvedValue({ id: "ws-1", slug: "attacker" });
    h.pageCreate.mockResolvedValue({ id: "page-1" });
  });

  it("creates an unverified account — a local signup proves no address", async () => {
    await expect(
      signupAction({}, signupForm("Attacker", "victim@corp.com", "Tr0ub4dor&3")),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(h.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "victim@corp.com",
          emailVerified: false,
        }),
      }),
    );
    expect(h.createSession).toHaveBeenCalledWith("user-1");
  });

  it("refuses a second account for the same address", async () => {
    h.userFindUnique.mockResolvedValue({ id: "user-1" });

    const state = await signupAction(
      {},
      signupForm("Attacker", "victim@corp.com", "Tr0ub4dor&3"),
    );

    // One neutral text for every failed sign-up (B24): a message of its own
    // would confirm that the address is registered.
    expect(state.error).toBe(
      "We could not create the account for this address. If you already have an account, sign in instead.",
    );
    expect(h.userCreate).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });
});
