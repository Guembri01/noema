import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SECURITY_HEADERS } from "./src/lib/security-headers";
// Next.js only accepts a Server Action POST when the request's `Origin` matches
// the `Host` header (CSRF protection), so this machine's own addresses have to be
// listed explicitly — otherwise browsing at `http://<lan-ip>:3200` (or `127.0.0.1`
// through a proxy) silently breaks every action: saving spins forever, comments
// and chat do nothing, and foreign origins must stay rejected.
//
// The policy lives in that module, not here, because a *packaged* app needs it at
// a different moment: Next serializes this config into the build, so the desktop
// boot wrapper recomputes the same list at launch instead of shipping whatever
// interfaces the build machine happened to have (see docs/DESKTOP.md).
import { allowedOrigins } from "./scripts/desktop/allowed-origins.cjs";

export { SECURITY_HEADERS };

const root = dirname(fileURLToPath(import.meta.url));

/**
 * B61 - security headers on EVERY response (docs/audits/security-1.md M9,
 * roadmap R10). The map itself now lives in `src/lib/security-headers.ts`
 * (B98): it is the single source of truth shared with `src/middleware.ts`,
 * so the static policy here and the per-response nonce policy in middleware
 * cannot drift.
 *
 * CSP shape (see the module doc for every decision):
 * - static `script-src 'self'` - B98 dropped `'unsafe-inline'`; document
 *   responses get `script-src 'self' 'nonce-<b64>'` from the middleware
 *   (hydration scripts are nonced during SSR), which takes precedence on the
 *   paths the middleware matcher covers. Middleware-skipped paths (api/,
 *   _next/, favicon) serve exactly this static policy.
 * - `style-src 'self' 'unsafe-inline'` stays (TipTap/ProseMirror `style=""`
 *   attributes + React SSR inline styles; a nonce would disable it).
 * - `img/media-src` allow `data:`/`blob:` + `https:`; `connect-src 'self'`
 *   covers same-origin fetch/SSE and the dev HMR websocket;
 *   `frame-src` mirrors `detectEmbed()` hosts; Noema is never embedded ->
 *   `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 *
 * Applied via `headers()` below: static pages, dynamic RSC renders, route
 * handlers AND the public `/s/<token>` share pages all get the map
 * (src/lib/security-headers.test.ts asserts the live response too).
 */

const nextConfig: NextConfig = {
  // Two build outputs from one codebase (see docs/DESKTOP.md):
  //  · site  — default. `next start` / the existing Docker image are unchanged.
  //  · app   — the desktop bundle. `NOEMA_STANDALONE=1` switches on Next's
  //            standalone output, which `scripts/desktop/sidecar.mjs` packs into
  //            the Tauri sidecar. Left off by default because `next start` does
  //            not serve a standalone build.
  ...(process.env.NOEMA_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Pin the tracing root so an unrelated lockfile above this project does not
  // change how the standalone output is assembled.
  outputFileTracingRoot: root,
  experimental: {
    serverActions: {
      allowedOrigins: allowedOrigins(),
    },
  },
  // B61: catch-all source so no response class (incl. public share pages)
  // misses the map above. B98: on document paths src/middleware.ts
  // supersedes the CSP with the per-response nonce variant; api/, _next/
  // and favicon keep serving exactly this static policy.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
