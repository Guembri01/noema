import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The password strategy gate (B27).
 *
 * `loginAction` and `signupAction` must consult the strategy registry
 * (`src/lib/auth-strategies.ts`): with `AUTH_PASSWORD=disabled` — or an
 * `AUTH_STRATEGIES` allow-list that does not contain `password` — the
 * deployment is single-sign-on only and no local password may be accepted or
 * created.
 *
 * The registry itself is the real module; only the database, the session
 * issuer and the router are mocked, so the gate is exercised exactly as the
 * server runs it.
 */

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
  workspaceFindFirst: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceCreate: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: h.userFindUnique,
      update: h.userUpdate,
      create: h.userCreate,
    },
    workspace: {
      findFirst: h.workspaceFindFirst,
      findUnique: h.workspaceFindUnique,
      create: h.workspaceCreate,
    },
    workspaceMember: { findFirst: h.workspaceMemberFindFirst },
    page: { create: h.pageCreate },
  },
}));

vi.mock("@/lib/auth", () => ({
  hashPassword: h.hashPassword,
  verifyPassword: h.verifyPassword,
  createSession: h.createSession,
  destroySession: h.destroySession,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { redirect } from "next/navigation";
import { loginAction, signupAction } from "./auth";

const ENV_KEYS = ["AUTH_PASSWORD", "AUTH_STRATEGIES"] as const;
const savedEnv = new Map<string, string | undefined>();

const VALID_PASSWORD = "Str0ngPassphrase";

/** A login form with a syntactically valid payload. */
function loginForm(email = "local@corp.com"): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("password", VALID_PASSWORD);
  return form;
}

/** A signup form with a policy-compliant payload. */
function signupForm(email = "new@corp.com"): FormData {
  const form = new FormData();
  form.set("name", "New Person");
  form.set("email", email);
  form.set("password", VALID_PASSWORD);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  h.userFindUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
    where.email === "local@corp.com"
      ? {
          id: "user-1",
          email: "local@corp.com",
          // #127 validates the stored value's bcrypt shape before comparing;
          // a placeholder like "hash" now (correctly) fails closed.
          passwordHash: "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi",
          twoFactorEnabled: false,
        }
      : null,
  );
  h.userCreate.mockResolvedValue({ id: "user-2" });
  h.workspaceCreate.mockResolvedValue({ id: "ws-1" });
  h.workspaceFindFirst.mockResolvedValue(null);
  h.workspaceFindUnique.mockResolvedValue(null);
  h.workspaceMemberFindFirst.mockResolvedValue({ workspace: { slug: "demo" } });
  h.pageCreate.mockResolvedValue({ id: "page-1" });
  h.hashPassword.mockResolvedValue("hashed");
  h.userUpdate.mockResolvedValue({ failedLoginCount: 0 });
  h.verifyPassword.mockResolvedValue(true);
  h.createSession.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loginAction — password strategy gate", () => {
  it("refuses the sign-in when AUTH_PASSWORD is disabled", async () => {
    process.env.AUTH_PASSWORD = "disabled";

    const state = await loginAction({}, loginForm());

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("disabled");
    // The gate is the first statement: no account is looked up, no password is
    // compared and no session is issued.
    expect(h.userFindUnique).not.toHaveBeenCalled();
    expect(h.verifyPassword).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses the sign-in for every falsy AUTH_PASSWORD value", async () => {
    for (const value of ["disabled", "off", "no", "0", "false"]) {
      process.env.AUTH_PASSWORD = value;
      const state = await loginAction({}, loginForm());
      expect(state.error).toContain("disabled");
    }
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses the sign-in when the AUTH_STRATEGIES allow-list excludes password", async () => {
    process.env.AUTH_STRATEGIES = "google,saml";

    const state = await loginAction({}, loginForm());

    expect(state.error).toBeTruthy();
    expect(h.userFindUnique).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("accepts the sign-in when the password strategy is enabled", async () => {
    // The success path redirects, so the action rejects with the mock's error.
    await expect(loginAction({}, loginForm())).rejects.toThrow("NEXT_REDIRECT");
    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/w/demo");
    expect(h.verifyPassword).toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledWith("user-1");
  });

  it("accepts the sign-in when AUTH_STRATEGIES lists password", async () => {
    process.env.AUTH_STRATEGIES = "password,google";

    await expect(loginAction({}, loginForm())).rejects.toThrow("NEXT_REDIRECT");
    expect(h.createSession).toHaveBeenCalledWith("user-1");
  });
});

describe("signupAction — password strategy gate", () => {
  it("refuses the sign-up when AUTH_PASSWORD is disabled", async () => {
    process.env.AUTH_PASSWORD = "disabled";

    const state = await signupAction({}, signupForm());

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("disabled");
    // No account, no workspace, no session.
    expect(h.userCreate).not.toHaveBeenCalled();
    expect(h.workspaceCreate).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses the sign-up when the AUTH_STRATEGIES allow-list excludes password", async () => {
    process.env.AUTH_STRATEGIES = "google";

    const state = await signupAction({}, signupForm());

    expect(state.error).toBeTruthy();
    expect(h.userCreate).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("creates the account when the password strategy is enabled", async () => {
    await expect(signupAction({}, signupForm())).rejects.toThrow("NEXT_REDIRECT");
    expect(h.userCreate).toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledWith("user-2");
  });
});
