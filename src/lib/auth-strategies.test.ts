import { describe, expect, it } from "vitest";
import { PASSWORD_POLICY } from "./password-policy";
import {
  STRATEGIES,
  describeStrategy,
  enabledStrategies,
  getStrategy,
  isSafeReturnTo,
  linkOrCreate,
  normalizeIdentity,
  passwordStrategyEnabled,
  startLogin,
  validateCallback,
  validatePassword,
} from "./auth-strategies";
import type { AuthKind, AuthStrategy, ExistingUser } from "./auth-strategies";

/**
 * §17 Authentication "providers limited" — provider-agnostic sign-in strategy
 * layer (red-first).
 *
 * A single pure registry describes every way a user can sign in (password,
 * OIDC, SAML, magic link, passkey). Around it sit five pure decisions:
 *
 *  - `startLogin` mints a state/nonce pair (randomness is injected, so the
 *    output is deterministic in tests) and builds the provider redirect;
 *  - `validateCallback` re-checks state/nonce, demands the credential and
 *    resolves `returnTo` against an allow-list, so a crafted `returnTo` can
 *    never turn a callback into an open redirect;
 *  - `normalizeIdentity` maps each provider's profile onto one identity shape;
 *  - `linkOrCreate` decides link/create/conflict under email-verification rules;
 *  - `validatePassword` folds the password policy, a denylist and
 *    email-similarity into one issue list.
 *
 * Nothing may throw on hostile input, and every branch is observable without a
 * clock, socket, filesystem or DB.
 */

/** Build an ad-hoc strategy for a case that needs a configured provider. */
function strategy(
  overrides: Pick<AuthStrategy, "id" | "kind"> & Partial<AuthStrategy>,
): AuthStrategy {
  return { label: overrides.id, enabled: true, config: {}, ...overrides };
}

/** A sequential `random` so state/nonce are fixed across a test. */
function fixedRandom(...values: string[]): (bytes: number) => string {
  let index = 0;
  return () => values[index++] ?? "";
}

const NOW = "2026-01-01T00:00:00.000Z";

describe("STRATEGIES registry", () => {
  it("has unique ids and covers every sign-in kind", () => {
    const ids = STRATEGIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(STRATEGIES.map((entry) => entry.kind));
    for (const kind of ["password", "oidc", "saml", "magic-link", "passkey"] as AuthKind[]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it("attaches the password policy only to the password strategy", () => {
    expect(getStrategy("password")?.passwordPolicy).toEqual(PASSWORD_POLICY);
    for (const entry of STRATEGIES) {
      if (entry.kind !== "password") expect(entry.passwordPolicy).toBeUndefined();
    }
  });

  it("resolves strategies by id and misses cleanly", () => {
    expect(getStrategy("google")?.kind).toBe("oidc");
    expect(getStrategy("magic-link")?.kind).toBe("magic-link");
    expect(getStrategy("nope")).toBeUndefined();
  });
});

describe("validatePassword", () => {
  it("accepts a strong password under the default policy", () => {
    expect(validatePassword("Tr0ub4dor&3")).toEqual({ ok: true, issues: [] });
  });

  it("reports every failing requirement in a stable order", () => {
    expect(validatePassword("abc").issues).toEqual([
      "too_short",
      "missing_upper",
      "missing_digit",
    ]);
  });

  it("flags a denylisted password", () => {
    expect(validatePassword("password123").issues).toContain("common");
    expect(validatePassword("password123").ok).toBe(false);
  });

  it("flags an extra caller-supplied common-password list", () => {
    expect(validatePassword("mysecret", { commonPasswords: ["mysecret"] }).issues).toContain(
      "common",
    );
  });

  it("flags a password similar to the account email", () => {
    expect(
      validatePassword("ada.lovelace", { email: "ada.lovelace@example.com" }).issues,
    ).toContain("similar_to_email");
    expect(
      validatePassword("adalovelace", { email: "adalovelace@example.com" }).issues,
    ).toContain("similar_to_email");
  });

  it("does not flag an unrelated email", () => {
    expect(
      validatePassword("Tr0ub4dor&3", { email: "ada@example.com" }).issues,
    ).not.toContain("similar_to_email");
  });

  it("honours a custom policy", () => {
    const policy = { ...PASSWORD_POLICY, minLength: 12, requireSymbol: true };
    expect(validatePassword("Abcdefgh1", { policy }).issues).toEqual([
      "too_short",
      "missing_symbol",
    ]);
    expect(validatePassword("Abcdefghij1!", { policy }).ok).toBe(true);
  });

  it("never throws on empty or non-string input", () => {
    expect(validatePassword("")).toEqual({ ok: false, issues: ["empty"] });
    expect(validatePassword(undefined)).toEqual({ ok: false, issues: ["not_a_string"] });
    expect(validatePassword(42 as unknown)).toEqual({ ok: false, issues: ["not_a_string"] });
  });

  it("rejects passwords past the hard length cap", () => {
    expect(validatePassword(`Aa1${"x".repeat(400)}`).issues).toContain("too_long");
  });
});

describe("startLogin", () => {
  it("is deterministic with injected randomness and mints distinct state/nonce", () => {
    const google = getStrategy("google")!;
    const first = startLogin(google, {
      returnTo: "/app",
      random: fixedRandom("state-1", "nonce-1"),
    });
    const second = startLogin(google, {
      returnTo: "/app",
      random: fixedRandom("state-1", "nonce-1"),
    });
    expect(first).toEqual(second);
    expect(first.state).toBe("state-1");
    expect(first.nonce).toBe("nonce-1");
  });

  it("builds an OIDC authorize redirect from the strategy config", () => {
    const oidc = strategy({
      id: "acme",
      kind: "oidc",
      config: {
        authorizationUrl: "https://idp.example/authorize",
        clientId: "client-abc",
        scopes: ["openid", "email"],
        callbackPath: "/api/auth/callback/acme",
      },
    });
    const { redirectUrl } = startLogin(oidc, { random: fixedRandom("s", "n") });
    const url = new URL(redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://idp.example/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("redirect_uri")).toBe("/api/auth/callback/acme");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("nonce")).toBe("n");
  });

  it("builds a SAML redirect carrying the state as RelayState", () => {
    const saml = strategy({
      id: "saml",
      kind: "saml",
      config: { ssoUrl: "https://idp.example/sso" },
    });
    const { redirectUrl, state } = startLogin(saml, { random: fixedRandom("relay") });
    const url = new URL(redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://idp.example/sso");
    expect(url.searchParams.get("RelayState")).toBe(state);
  });

  it("builds a magic-link start redirect with the return path", () => {
    const magic = getStrategy("magic-link")!;
    const { redirectUrl, state } = startLogin(magic, {
      returnTo: "/welcome",
      random: fixedRandom("magic-state"),
    });
    const url = new URL(redirectUrl, "http://localhost");
    expect(url.pathname).toBe("/api/auth/magic-link/start");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("returnTo")).toBe("/welcome");
  });

  it("builds a passkey start redirect", () => {
    const passkey = getStrategy("passkey")!;
    const { redirectUrl } = startLogin(passkey, { random: fixedRandom("pk") });
    expect(new URL(redirectUrl, "http://localhost").pathname).toBe(
      "/api/auth/passkey/start",
    );
  });

  it("routes the password strategy to /login", () => {
    const { redirectUrl } = startLogin(getStrategy("password")!, {
      returnTo: "/app",
      random: fixedRandom("s", "n"),
    });
    expect(redirectUrl).toContain("/login");
    expect(redirectUrl).toContain("returnTo=%2Fapp");
  });

  it("refuses to carry an off-site returnTo (open-redirect guard)", () => {
    const { redirectUrl } = startLogin(getStrategy("password")!, {
      returnTo: "https://evil.example/steal",
      random: fixedRandom("s", "n"),
    });
    expect(redirectUrl).not.toContain("evil.example");
    expect(redirectUrl).toContain("returnTo=%2F");
  });
});

describe("validateCallback", () => {
  const oidc = strategy({ id: "oidc", kind: "oidc" });

  it("accepts a well-formed callback and resolves an allow-listed returnTo", () => {
    const result = validateCallback(oidc, {
      params: { state: "s1", nonce: "n1", code: "c1", returnTo: "/app/settings" },
      expected: { state: "s1", nonce: "n1", allowedReturnTo: ["/app"] },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.code).toBe("c1");
    expect(result.returnTo).toBe("/app/settings");
  });

  it("flags a mismatched or missing state", () => {
    expect(
      validateCallback(oidc, {
        params: { state: "bad", nonce: "n1", code: "c1" },
        expected: { state: "s1", nonce: "n1" },
      }).issues,
    ).toContain("state_mismatch");
    expect(
      validateCallback(oidc, {
        params: { nonce: "n1", code: "c1" },
        expected: { state: "s1", nonce: "n1" },
      }).issues,
    ).toContain("missing_state");
  });

  it("flags a mismatched or missing nonce", () => {
    expect(
      validateCallback(oidc, {
        params: { state: "s1", nonce: "wrong", code: "c1" },
        expected: { state: "s1", nonce: "n1" },
      }).issues,
    ).toContain("nonce_mismatch");
    expect(
      validateCallback(oidc, {
        params: { state: "s1", code: "c1" },
        expected: { state: "s1", nonce: "n1" },
      }).issues,
    ).toContain("missing_nonce");
  });

  it("flags a missing credential", () => {
    const result = validateCallback(oidc, {
      params: { state: "s1", nonce: "n1" },
      expected: { state: "s1", nonce: "n1" },
    });
    expect(result.issues).toContain("missing_code");
    expect(result.ok).toBe(false);
  });

  it("surfaces a provider error", () => {
    const result = validateCallback(oidc, {
      params: { error: "access_denied", state: "s1" },
      expected: { state: "s1" },
    });
    expect(result.issues).toContain("provider_error");
    expect(result.ok).toBe(false);
  });

  it("refuses an absolute returnTo (never an open redirect)", () => {
    const result = validateCallback(oidc, {
      params: { state: "s1", nonce: "n1", code: "c1", returnTo: "https://evil.example" },
      expected: { state: "s1", nonce: "n1" },
    });
    expect(result.issues).toContain("return_to_not_allowed");
    expect(result.returnTo).toBeUndefined();
  });

  it("refuses a protocol-relative or encoded returnTo", () => {
    for (const returnTo of ["//evil.example", "/%2F%2Fevil.example", "/\\evil.example"]) {
      const result = validateCallback(oidc, {
        params: { state: "s1", nonce: "n1", code: "c1", returnTo },
        expected: { state: "s1", nonce: "n1" },
      });
      expect(result.issues).toContain("return_to_not_allowed");
      expect(result.returnTo).toBeUndefined();
    }
  });

  it("refuses a returnTo outside the allow-list", () => {
    const result = validateCallback(oidc, {
      params: { state: "s1", nonce: "n1", code: "c1", returnTo: "/admin" },
      expected: { state: "s1", nonce: "n1", allowedReturnTo: ["/app"] },
    });
    expect(result.issues).toContain("return_to_not_allowed");
    expect(result.returnTo).toBeUndefined();
  });

  it("falls back to the server-side remember returnTo when params omit it", () => {
    const result = validateCallback(oidc, {
      params: { state: "s1", nonce: "n1", code: "c1" },
      expected: { state: "s1", nonce: "n1", returnTo: "/app/inbox" },
    });
    expect(result.ok).toBe(true);
    expect(result.returnTo).toBe("/app/inbox");
  });

  it("accepts the magic-link token as the credential", () => {
    const result = validateCallback(getStrategy("magic-link")!, {
      params: { state: "s1", token: "tok-1" },
      expected: { state: "s1" },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("tok-1");
  });

  it("does not demand a code for password or passkey", () => {
    expect(
      validateCallback(getStrategy("password")!, {
        params: { state: "s1" },
        expected: { state: "s1" },
      }).ok,
    ).toBe(true);
    expect(
      validateCallback(getStrategy("passkey")!, {
        params: { state: "s1" },
        expected: { state: "s1" },
      }).ok,
    ).toBe(true);
  });
});

describe("isSafeReturnTo", () => {
  it("accepts internal paths and rejects anything that escapes the origin", () => {
    expect(isSafeReturnTo("/app/settings")).toBe(true);
    expect(isSafeReturnTo("/")).toBe(true);
    expect(isSafeReturnTo("https://evil.example")).toBe(false);
    expect(isSafeReturnTo("//evil.example")).toBe(false);
    expect(isSafeReturnTo("/\\evil.example")).toBe(false);
    expect(isSafeReturnTo("app")).toBe(false);
    expect(isSafeReturnTo("/%2F%2Fevil.example")).toBe(false);
  });
});

describe("normalizeIdentity", () => {
  it("maps OIDC standard claims", () => {
    expect(
      normalizeIdentity(getStrategy("google")!, {
        sub: "12345",
        email: "Ada@Example.com",
        name: "Ada Lovelace",
        picture: "https://img.example/a.png",
      }),
    ).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://img.example/a.png",
      externalId: "12345",
    });
  });

  it("maps SAML attributes", () => {
    expect(
      normalizeIdentity(getStrategy("saml")!, {
        nameID: "urn:user:1",
        displayName: "Bob",
        "urn:oid:0.9.2342.19200300.100.1.3": "bob@example.com",
      }),
    ).toEqual({
      email: "bob@example.com",
      name: "Bob",
      externalId: "urn:user:1",
    });
  });

  it("uses the email as the external id for password sign-in", () => {
    expect(
      normalizeIdentity(getStrategy("password")!, {
        email: "carol@example.com",
        name: "Carol",
      }),
    ).toEqual({
      email: "carol@example.com",
      name: "Carol",
      externalId: "carol@example.com",
    });
  });

  it("derives a name from the email local part for magic links", () => {
    expect(normalizeIdentity(getStrategy("magic-link")!, { email: "dave@example.com" })).toEqual({
      email: "dave@example.com",
      name: "dave",
      externalId: "dave@example.com",
    });
  });

  it("uses the credential id as the external id for passkeys", () => {
    expect(
      normalizeIdentity(getStrategy("passkey")!, {
        credentialId: "cred-1",
        email: "eve@example.com",
        name: "Eve",
        avatarUrl: "https://img.example/e.png",
      }),
    ).toEqual({
      email: "eve@example.com",
      name: "Eve",
      avatarUrl: "https://img.example/e.png",
      externalId: "cred-1",
    });
  });

  it("tolerates a profile with no email", () => {
    const identity = normalizeIdentity(getStrategy("google")!, { sub: "x" });
    expect(identity.email).toBe("");
    expect(identity.name).toBe("");
    expect(identity.externalId).toBe("x");
    expect("avatarUrl" in identity).toBe(false);
  });
});

describe("linkOrCreate", () => {
  const google = getStrategy("google")!;
  const password = getStrategy("password")!;
  const passkey = getStrategy("passkey")!;

  it("creates when nothing matches", () => {
    const decision = linkOrCreate({
      existingUsers: [],
      identity: { email: "new@example.com", name: "New", externalId: "sub-1" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toEqual({
      action: "create",
      reason: "new_identity",
      emailVerified: true,
      at: NOW,
    });
  });

  it("marks a created account verified only when the provider vouches for the email", () => {
    const decision = linkOrCreate({
      existingUsers: [],
      identity: { email: "p@example.com", name: "P", externalId: "p@example.com" },
      strategy: password,
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "create", emailVerified: false });
  });

  it("links an existing identity by external id even if the email changed", () => {
    const users: ExistingUser[] = [
      { id: "u1", email: "old@example.com", externalIds: ["sub-1"] },
    ];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "new@example.com", name: "N", externalId: "sub-1" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toEqual({ action: "link", userId: "u1", reason: "external_id_match", at: NOW });
  });

  it("links by verified email when the provider email is trusted", () => {
    const users: ExistingUser[] = [{ id: "u2", email: "ada@example.com", emailVerified: true }];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "ada@example.com", name: "A", externalId: "sub-9" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "link", userId: "u2", reason: "email_match" });
  });

  it("links a trusted provider email onto an unverified local account", () => {
    const users: ExistingUser[] = [{ id: "u3", email: "grace@example.com", emailVerified: false }];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "grace@example.com", name: "G", externalId: "sub-2" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "link", userId: "u3", reason: "email_match" });
  });

  it("refuses to auto-link an untrusted email onto an unverified account", () => {
    const users: ExistingUser[] = [
      { id: "u4", email: "victim@example.com", emailVerified: false },
    ];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "victim@example.com", name: "V", externalId: "victim@example.com" },
      strategy: password,
      now: NOW,
    });
    expect(decision).toEqual({
      action: "conflict",
      reason: "email_taken_unverified",
      existingUserId: "u4",
      at: NOW,
    });
  });

  it("honours an explicit emailVerified override", () => {
    const users: ExistingUser[] = [{ id: "u8", email: "p@example.com", emailVerified: false }];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "p@example.com", name: "P", externalId: "p@example.com" },
      strategy: password,
      now: NOW,
      emailVerified: true,
    });
    expect(decision).toMatchObject({ action: "link", userId: "u8", reason: "email_match" });
  });

  it("flags a conflict when the external id and a trusted email disagree", () => {
    const users: ExistingUser[] = [
      { id: "u5", email: "a@example.com", externalIds: ["sub-5"] },
      { id: "u6", email: "b@example.com", emailVerified: true },
    ];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "b@example.com", name: "B", externalId: "sub-5" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toEqual({
      action: "conflict",
      reason: "external_id_conflict",
      existingUserId: "u5",
      at: NOW,
    });
  });

  it("prefers the external id match over an unrelated email", () => {
    const users: ExistingUser[] = [
      { id: "u7", email: "x@example.com", externalIds: ["sub-7"] },
    ];
    const decision = linkOrCreate({
      existingUsers: users,
      identity: { email: "y@example.com", name: "Y", externalId: "sub-7" },
      strategy: google,
      now: NOW,
    });
    expect(decision).toMatchObject({ action: "link", userId: "u7", reason: "external_id_match" });
  });

  it("refuses to create without an email", () => {
    const decision = linkOrCreate({
      existingUsers: [],
      identity: { email: "", name: "", externalId: "cred-1" },
      strategy: passkey,
      now: NOW,
    });
    expect(decision).toEqual({ action: "conflict", reason: "missing_email", at: NOW });
  });

  it("accepts a Date for the injected clock", () => {
    const decision = linkOrCreate({
      existingUsers: [],
      identity: { email: "d@example.com", name: "D", externalId: "sub" },
      strategy: google,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(decision.at).toBe(NOW);
  });
});

describe("describeStrategy", () => {
  it("describes a password strategy", () => {
    const description = describeStrategy(getStrategy("password")!);
    expect(description).toMatchObject({ id: "password", kind: "password", redirects: false });
    expect(description.description).toContain("password");
    expect(description.passwordPolicy).toEqual(PASSWORD_POLICY);
  });

  it("describes a redirecting provider without a password policy", () => {
    const description = describeStrategy(getStrategy("google")!);
    expect(description.redirects).toBe(true);
    expect(description.description).toContain("OpenID Connect");
    expect(description.passwordPolicy).toBeNull();
  });

  it("flags magic-link as redirecting and passkey as in-page", () => {
    expect(describeStrategy(getStrategy("magic-link")!).redirects).toBe(true);
    expect(describeStrategy(getStrategy("passkey")!).redirects).toBe(false);
    expect(describeStrategy(getStrategy("saml")!).description).toContain("SAML");
  });
});

describe("enabledStrategies", () => {
  it("exposes only password on an empty environment", () => {
    expect(enabledStrategies({}).map((entry) => entry.id)).toEqual(["password"]);
  });

  it("adds a provider once its client id is configured", () => {
    expect(enabledStrategies({ AUTH_GOOGLE_CLIENT_ID: "gid" }).map((entry) => entry.id)).toEqual([
      "password",
      "google",
    ]);
    expect(enabledStrategies({ AUTH_MICROSOFT_CLIENT_ID: "mid" }).map((e) => e.id)).toEqual([
      "password",
      "microsoft",
    ]);
    expect(enabledStrategies({ AUTH_SAML_SSO_URL: "https://idp" }).map((e) => e.id)).toEqual([
      "password",
      "saml",
    ]);
  });

  it("gates the flag-based strategies on a truthy env value", () => {
    expect(
      enabledStrategies({ AUTH_MAGIC_LINK: "true", AUTH_PASSKEY: "on" }).map((e) => e.id),
    ).toEqual(["password", "magic-link", "passkey"]);
  });

  it("can disable password and keep another strategy", () => {
    expect(
      enabledStrategies({ AUTH_PASSWORD: "disabled", AUTH_PASSKEY: "1" }).map((e) => e.id),
    ).toEqual(["passkey"]);
  });

  it("honours an explicit AUTH_STRATEGIES allow-list", () => {
    expect(
      enabledStrategies({
        AUTH_STRATEGIES: "google,saml",
        AUTH_GOOGLE_CLIENT_ID: "gid",
        AUTH_SAML_SSO_URL: "https://idp",
      }).map((e) => e.id),
    ).toEqual(["google", "saml"]);
  });

  it("treats a blank allow-list as no allow-list", () => {
    expect(enabledStrategies({ AUTH_STRATEGIES: "  " }).map((e) => e.id)).toEqual(["password"]);
  });
});

describe("passwordStrategyEnabled", () => {
  it("is enabled on an empty environment", () => {
    expect(passwordStrategyEnabled({})).toBe(true);
  });

  it("is disabled by a falsy AUTH_PASSWORD value", () => {
    for (const value of ["disabled", "off", "no", "0", "false", "DISABLED"]) {
      expect(passwordStrategyEnabled({ AUTH_PASSWORD: value })).toBe(false);
    }
  });

  it("stays enabled for a truthy AUTH_PASSWORD value", () => {
    expect(passwordStrategyEnabled({ AUTH_PASSWORD: "enabled" })).toBe(true);
    expect(passwordStrategyEnabled({ AUTH_PASSWORD: "true" })).toBe(true);
  });

  it("is disabled by an allow-list without password", () => {
    expect(
      passwordStrategyEnabled({ AUTH_STRATEGIES: "google,saml", AUTH_GOOGLE_CLIENT_ID: "gid" }),
    ).toBe(false);
  });

  it("stays enabled for an allow-list that contains password", () => {
    expect(passwordStrategyEnabled({ AUTH_STRATEGIES: "password,google" })).toBe(true);
  });

  it("is disabled when the allow-list excludes password and AUTH_PASSWORD is set", () => {
    expect(
      passwordStrategyEnabled({ AUTH_PASSWORD: "enabled", AUTH_STRATEGIES: "google" }),
    ).toBe(false);
  });
});
