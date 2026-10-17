/**
 * B98 (B61 follow-up) - Content-Security-Policy builder: the SINGLE source of
 * truth for the directive list. Consumed by:
 *
 * - `next.config.ts` -> `headers()` sends the STATIC policy (no nonce) on
 *   every response class, incl. the paths `src/middleware.ts` skips
 *   (`api/`, `_next/`, favicon) and as a backstop for any response that
 *   never reaches middleware;
 * - `src/middleware.ts` -> per-response policy via `buildCsp(nonce)` for
 *   document responses (see the M9 addendum).
 *
 * CSP decisions (B61 compatibility pass, B98 nonce tightening):
 * - `script-src 'self'` (+ `'nonce-<b64>'` per response, + the pinned
 *   `'sha256-...'` for the next-themes bootstrap) - B98 DROPPED
 *   `'unsafe-inline'` here: the App Router hydration/bootstrap scripts
 *   (`self.__next_f.push(...)`) are nonced by Next.js during SSR (it parses
 *   the request's Content-Security-Policy, see
 *   `next/dist/server/app-render/get-script-nonce-from-header.js`), so the
 *   inline-script escape hatch is no longer needed. Cross-origin scripts
 *   stay blocked; `'unsafe-eval'` stays absent (dev included - verified by
 *   the B98 chromium probe).
 * - `style-src 'self' 'unsafe-inline'` - NOT eligible for a nonce: a
 *   nonce/hash source disables `'unsafe-inline'` (CSP source precedence),
 *   which would block TipTap/ProseMirror `style=""` attributes and React
 *   SSR inline styles. Out of B98 scope (documented allowance).
 * - `img/media-src` allow `data:`/`blob:` (editor previews, uploads) +
 *   `https:` (external markdown/bookmark images); `connect-src 'self'`
 *   covers same-origin fetch/SSE + dev HMR websocket.
 * - `connect-src` ALSO admits Tauri's IPC endpoint, but **only when this
 *   process is the desktop app's own server** (`insideDesktopShell`). The
 *   installed app is a webview pointed at this server, so the page reaches the
 *   shell's commands over `ipc:`/`http://ipc.localhost` — and a page that could
 *   not reach the IPC could not ask the shell for anything at all (the window
 *   theme was the first casualty). The hosted site keeps `'self'`: `.localhost`
 *   resolves to loopback in a browser, so admitting it there would let a page
 *   talk to whatever is listening on the user's 127.0.0.1.
 * - `frame-src` mirrors exactly the hosts `detectEmbed()`
 *   (`src/lib/embeds.ts`) can emit as an iframe `src` (Noema embeds OTHERS).
 *   Noema is never embedded, hence `frame-ancestors 'none'` + XFO DENY.
 */

/** Header carrying the per-response nonce into the App Router render. */
export const NONCE_HEADER = "x-nonce";

/**
 * Pinned hash of the next-themes bootstrap — the one inline script React does not
 * nonce, needed only for responses served **without** a nonce (middleware-skipped
 * or static fallback). Document requests get the nonce instead, and the provider
 * passes it through (see `components/theme-provider.tsx`).
 *
 * Refresh it from a production server, never by hand:
 *
 *     npm run check:csp -- --base <production url>
 *
 * The check prints `BLOCKED script needs sha256-…` for exactly this value. It was
 * stale once — the pin no longer matched the injected script, so browsers blocked
 * the theme bootstrap in production while `next dev` (a laxer policy) hid it.
 */
export const THEME_SCRIPT_SHA256 = "sha256-J9cZHZf5nVZbsm7Pqxc8RsURv1AIXkMgbhfrZvoOs/A=";

/** `'self'` + exactly the hosts detectEmbed() can emit an iframe src for. */
const FRAME_SRC = [
  "frame-src",
  "'self'",
  "https://www.youtube.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://open.spotify.com",
  "https://w.soundcloud.com",
  "https://www.figma.com",
  "https://codepen.io",
  "https://platform.twitter.com",
  "https://codesandbox.io",
  "https://drive.google.com",
  "https://whimsical.com",
].join(" ");

/**
 * True when this process is the **desktop app's own server**, rather than the
 * hosted site. The shell marks its child (`NOEMA_RUNTIME=desktop`, see
 * `src-tauri/src/sidecar.rs`) and the payload build sets `NOEMA_STANDALONE=1`
 * (`scripts/desktop/prepare.mjs`), so the baked policy and the running server
 * always agree — this is deliberately not a client-side check, because only the
 * server can tell what the page is embedded in.
 */
export function insideDesktopShell(): boolean {
  return (
    process.env.NOEMA_RUNTIME === "desktop" || process.env.NOEMA_STANDALONE === "1"
  );
}

/**
 * Build the full CSP header value.
 *
 * @param nonce Per-response base64 nonce; omit for the static policy
 *   (`script-src 'self'` only - middleware-skipped/static fallback).
 * @param options.dev  Loosen `script-src` for the dev runtime (see above).
 * @param options.shell Admit Tauri's IPC endpoint in `connect-src` — pass
 *   `insideDesktopShell()`; the site must never widen this.
 *   Same directive order as B61 so live diffs are reviewable.
 */
export function buildCsp(
  nonce?: string | null,
  options: { dev?: boolean; shell?: boolean } = {},
): string {
  // Development needs `'unsafe-eval'`: Next's dev runtime evaluates module
  // boundaries, and without it the *whole page* fails to hydrate — the markup renders
  // (SSR) so it looks fine, but nothing is interactive. Measured, not assumed: the
  // comment above used to claim "dev included — verified by the B98 chromium probe",
  // and that probe was wrong. A rendered node carried no React props key and the
  // browser reported the eval violation. Production still has no `'unsafe-eval'`,
  // which is where it matters, and `npm run check:csp` keeps asserting that.
  const allowEval = options.dev === true;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    [
      "script-src",
      "'self'",
      nonce ? `'nonce-${nonce}'` : null,
      `'${THEME_SCRIPT_SHA256}'`,
      allowEval ? "'unsafe-eval'" : null,
    ]
      .filter(Boolean)
      .join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    [
      "connect-src",
      "'self'",
      // Tauri's IPC transport (`withGlobalTauri`): both spellings, matching the
      // shell's own policy in `src-tauri/tauri.conf.json`.
      options.shell ? "ipc:" : null,
      options.shell ? "http://ipc.localhost" : null,
    ]
      .filter(Boolean)
      .join(" "),
    "media-src 'self' blob: data: https:",
    FRAME_SRC,
  ].join("; ");
}

/**
 * Extract the nonce from a CSP header value (null when there is none).
 * Mirrors Next.js's own parsing (`getScriptNonceFromHeader`) so tests can
 * assert "the value Next will attach to hydration scripts".
 */
export function cspNonce(csp: string): string | null {
  return csp.match(/'nonce-([A-Za-z0-9+/_-]+={0,2})'/)?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * B33 — Strict-Transport-Security (HSTS)
 * ------------------------------------------------------------------ */

/**
 * Name of the environment variable that sets the HSTS `max-age` in
 * **seconds**.
 *
 * The header is sent **by default** — with {@link HSTS_DEFAULT_MAX_AGE} (one
 * year) — because a deployment that is served over HTTPS must pin HTTPS, and
 * a deployment that is *not* served over HTTPS loses nothing: a browser MUST
 * ignore an STS header that arrives over plain HTTP (RFC 6797 §7.2), so the
 * desktop app on `http://127.0.0.1:<port>` and an HTTP-only self-host are
 * not affected.
 *
 * `HSTS_MAX_AGE=0` is the one documented way out: no `Strict-Transport-Security`
 * header at all, for an installation that is deliberately served over plain
 * HTTP.
 */
export const HSTS_MAX_AGE_ENV = "HSTS_MAX_AGE";

/**
 * Name of the environment variable that adds `includeSubDomains` to the HSTS
 * header. Off by default: the directive binds **every** subdomain of the host
 * to HTTPS, which breaks a sibling that is still HTTP-only. The accepted
 * values are the usual truthy ones (`1`, `true`, `on`, `yes`).
 */
export const HSTS_INCLUDE_SUBDOMAINS_ENV = "HSTS_INCLUDE_SUBDOMAINS";

/**
 * The `max-age` a deployment sends when it says nothing: one year. It is the
 * value the header carries by default, and the shortest period the spec
 * recommends (RFC 6797 §6.1.2).
 */
export const HSTS_DEFAULT_MAX_AGE = 31536000;

/**
 * The longest `max-age` a browser honours — two years. RFC 6797 §6.1.2 tells
 * implementations to ignore a longer one, so a bigger number would be a
 * promise the browser does not keep.
 */
const HSTS_MAX_MAX_AGE = 63072000;

/** The values that switch a flag on (same convention as `auth-strategies.ts`). */
const TRUTHY_ENV = new Set(["1", "true", "on", "yes"]);

/**
 * The effective HSTS `max-age` of a deployment (in seconds), or `null` when
 * no header may be sent.
 *
 * The rules, in the order they are applied:
 *
 *   - **unset or blank** → {@link HSTS_DEFAULT_MAX_AGE} (one year). The header
 *     is sent; a deployment that does not want it says `0`.
 *   - **`0`** → `null`: no header at all. That is the documented way out for
 *     an installation that is deliberately served over plain HTTP.
 *   - **a plain positive integer** up to the two-year cap → that many
 *     seconds. Surrounding whitespace is trimmed.
 *   - **anything else** (`"-1"`, `"abc"`, `"1.5"`, `"007"`, a value above the
 *     cap) → `null`: no header. A value that cannot be parsed is **refused**,
 *     not clamped — clamping would silently reinterpret a typo and declare a
 *     policy nobody wrote — and it is not silently replaced by the default
 *     either, because that would hide the typo. A refused value sends no
 *     header, never a broken one.
 *
 * @param raw The raw environment value.
 * @returns The max-age in seconds, or `null` when no header may be sent.
 */
export function parseHstsMaxAge(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return HSTS_DEFAULT_MAX_AGE;
  const text = raw.trim();
  if (text === "") return HSTS_DEFAULT_MAX_AGE;
  if (text === "0") return null;
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds > HSTS_MAX_MAX_AGE) return null;
  return seconds;
}

/**
 * The environment a header is computed from. `Record<string, string |
 * undefined>` and not `NodeJS.ProcessEnv`: Next's types make `NODE_ENV` a
 * **required** property of the latter, which would make every caller pass a
 * full process environment (the same shape `auth-strategies.ts` uses).
 */
export type HeaderEnv = Record<string, string | undefined>;

/**
 * The `Strict-Transport-Security` header of this deployment, or `null` when
 * the header must not be sent (`HSTS_MAX_AGE=0`, or a value that is refused).
 *
 * The header belongs to the **map** in `next.config.ts` (`headers()`), not to
 * the middleware: HSTS is a property of the *host*, not of a response class,
 * and the map reaches every response — static pages, dynamic RSC renders,
 * route handlers and the public `/s/<token>` share pages alike.
 *
 * @param env The environment to read; defaults to this process'.
 */
export function hstsHeader(
  env: HeaderEnv = process.env,
): { key: string; value: string } | null {
  const seconds = parseHstsMaxAge(env[HSTS_MAX_AGE_ENV]);
  if (seconds === null) return null;
  const includeSubDomains = TRUTHY_ENV.has(
    (env[HSTS_INCLUDE_SUBDOMAINS_ENV] ?? "").trim().toLowerCase(),
  );
  return {
    key: "Strict-Transport-Security",
    value: includeSubDomains ? `max-age=${seconds}; includeSubDomains` : `max-age=${seconds}`,
  };
}

/**
 * B61 - security headers on EVERY response (M9,
 * roadmap R10), applied via `headers()` in `next.config.ts` so static pages,
 * dynamic RSC renders, route handlers AND the public `/s/<token>` share pages
 * all get the same protection. Enforced, not report-only.
 *
 * `Content-Security-Policy` here is the STATIC (nonce-less) policy;
 * document responses are upgraded to the nonce variant by `src/middleware.ts`
 * (B98), which takes precedence on the paths it runs for.
 *
 * B33: this map is the part every deployment sends. The HSTS header is **not**
 * in it — its value depends on the deployment (`HSTS_MAX_AGE`, one year by
 * default), so `next.config.ts` adds it. It is sent unless the deployment
 * says `HSTS_MAX_AGE=0`.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": buildCsp(undefined, { shell: insideDesktopShell() }),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};
