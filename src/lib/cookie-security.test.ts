import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieName,
  secureCookies,
  SSO_NONCE_COOKIE,
  SSO_STATE_COOKIE,
} from "./cookie-security";

/**
 * B31 — the cookie rules of the app.
 *
 * The `Secure` flag and the `__Host-` prefix are two halves of one decision:
 * a browser only accepts a `__Host-` cookie together with `Secure`, and it
 * drops a `Secure` cookie on a plain-HTTP connection. So the prefix may
 * appear exactly where the flag is set — and the flag is set exactly where
 * the deployment is served over HTTPS (production).
 *
 * The names are therefore environment-dependent, and the writer and the reader
 * of a cookie have to ask this module for the name. These tests pin both
 * halves: the rule, and the names the hand-off cookies are stored under.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the cookie rules (B31)", () => {
  it("marks the cookies secure in production only", () => {
    // A development server runs on plain HTTP: a browser drops a `Secure`
    // cookie there, which would break every sign-in locally.
    vi.stubEnv("NODE_ENV", "development");
    expect(secureCookies()).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    expect(secureCookies()).toBe(true);
  });

  it("prefixes the name exactly where the cookie is secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieName(SSO_STATE_COOKIE)).toBe("__Host-sso_state");
    expect(cookieName(SSO_NONCE_COOKIE)).toBe("__Host-sso_nonce");

    // Without `Secure` a browser rejects a `__Host-` cookie outright, so the
    // plain name is the only one that works on a plain-HTTP deployment.
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieName(SSO_STATE_COOKIE)).toBe("sso_state");
    expect(cookieName(SSO_NONCE_COOKIE)).toBe("sso_nonce");
  });

  it("keeps the two hand-off cookies apart", () => {
    expect(SSO_STATE_COOKIE).toBe("sso_state");
    expect(SSO_NONCE_COOKIE).toBe("sso_nonce");
    expect(SSO_STATE_COOKIE).not.toBe(SSO_NONCE_COOKIE);
  });
});
