/**
 * The cookie rules of the app (B31).
 *
 * Every cookie the app sets is `httpOnly`, `SameSite=Lax` and `Path=/`. Two
 * attributes depend on the deployment, and both are decided here:
 *
 *  - **`Secure`** keeps a cookie out of a plain-HTTP request. The rule is
 *    `NODE_ENV === "production"` — the same one the session cookie
 *    (`src/lib/auth.ts`) and the share unlock cookie
 *    (`src/app/s/[token]/unlock/route.ts`) already follow. A development
 *    server runs on plain HTTP, and a browser drops a `Secure` cookie there,
 *    which would break every sign-in locally. A production deployment is
 *    expected to be served over HTTPS (`SECURITY.md`: "Serve over HTTPS, and
 *    keep `secure` cookies on").
 *
 *  - **the `__Host-` prefix** binds a cookie to the exact host that set it: a
 *    browser only accepts a `__Host-` cookie that carries `Secure`, has
 *    `Path=/` and no `Domain` attribute, and it refuses a cookie of that name
 *    that a sibling subdomain planted for the whole domain (cookie tossing).
 *    The prefix therefore belongs exactly where `Secure` is set — a
 *    `__Host-` cookie without `Secure` is dropped by the browser, so a
 *    plain-HTTP deployment would lose the cookie altogether.
 *
 * The stored name therefore depends on the deployment, and every reader has to
 * ask this module for the name instead of writing it out: the writer and the
 * reader of a cookie must never disagree about it.
 */

/** The prefix a browser only accepts together with `Secure`. */
const HOST_PREFIX = "__Host-";

/**
 * Whether cookies may carry the `Secure` attribute in this deployment.
 *
 * Read at call time and not at import time: the rule follows the mode the app
 * runs in, and a test has to be able to switch it.
 */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The name a cookie is stored under: `__Host-`-prefixed where the cookie is
 * secure, the plain name everywhere else.
 */
export function cookieName(name: string): string {
  return secureCookies() ? `${HOST_PREFIX}${name}` : name;
}

/** The cookie the OIDC start route carries the `state` in. */
export const SSO_STATE_COOKIE = "sso_state";

/** The cookie the OIDC start route carries the `nonce` in. */
export const SSO_NONCE_COOKIE = "sso_nonce";
