/**
 * B98 (B61 follow-up) - Content-Security-Policy builder: the SINGLE source of
 * truth for the directive list. Consumed by:
 *
 * - `next.config.ts` -> `headers()` sends the STATIC policy (no nonce) on
 *   every response class, incl. the paths `src/middleware.ts` skips
 *   (`api/`, `_next/`, favicon) and as a backstop for any response that
 *   never reaches middleware;
 * - `src/middleware.ts` -> per-response policy via `buildCsp(nonce)` for
 *   document responses (see docs/audits/security-1.md M9 addendum).
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
 * - `frame-src` mirrors exactly the hosts `detectEmbed()`
 *   (`src/lib/embeds.ts`) can emit as an iframe `src` (Noema embeds OTHERS).
 *   Noema is never embedded, hence `frame-ancestors 'none'` + XFO DENY.
 */

/** Header carrying the per-response nonce into the App Router render. */
export const NONCE_HEADER = "x-nonce";

/**
 * Pinned hash of the ONE inline script React will not nonce: the
 * next-themes theme-bootstrap injected by `<ThemeProvider>`
 * (`src/components/theme-provider.tsx`, client component - off-limits in
 * this batch, and next-themes has no nonce pass-through there). Its content
 * is a fixed template built from the provider's static props (verified
 * byte-identical across responses), so a CSP hash source is the standard
 * strict-CSP allowance for fixed third-party inline scripts. If
 * next-themes/props ever change, this hash stops matching -> the live test
 * in security-headers.test.ts (hash every unnonced inline script actually
 * served) fails instead of silently blocking the script in the browser.
 */
export const THEME_SCRIPT_SHA256 = "sha256-UnthrFpGFotkvMOTp/ghVMSXoZZj9Y6epaMsaBAbUtg=";

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
].join(" ");

/**
 * Build the full CSP header value.
 *
 * @param nonce Per-response base64 nonce; omit for the static policy
 *   (`script-src 'self'` only - middleware-skipped/static fallback).
 *   Same directive order as B61 so live diffs are reviewable.
 */
export function buildCsp(nonce?: string | null): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ["script-src", "'self'", nonce ? `'nonce-${nonce}'` : null, `'${THEME_SCRIPT_SHA256}'`]
      .filter(Boolean)
      .join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
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

/**
 * B61 - security headers on EVERY response (docs/audits/security-1.md M9,
 * roadmap R10), applied via `headers()` in `next.config.ts` so static pages,
 * dynamic RSC renders, route handlers AND the public `/s/<token>` share pages
 * all get the same protection. Enforced, not report-only.
 *
 * `Content-Security-Policy` here is the STATIC (nonce-less) policy;
 * document responses are upgraded to the nonce variant by `src/middleware.ts`
 * (B98), which takes precedence on the paths it runs for.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": buildCsp(),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};
