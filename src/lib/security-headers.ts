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
  "Content-Security-Policy": buildCsp(undefined, { shell: insideDesktopShell() }),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};
