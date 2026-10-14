import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

export { SECURITY_HEADERS };

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Next.js only accepts a Server Action POST when the request's `Origin` matches
 * the `Host` header (CSRF protection). Because `next start` also prints a LAN
 * address, browsing the app at `http://<lan-ip>:3200` (or `127.0.0.1`) silently
 * broke every action — saving spun forever, comments and chat did nothing.
 *
 * We therefore allow this machine's own addresses explicitly: loopback, every
 * non-internal IPv4 interface, the usual dev ports, and anything in APP_ORIGINS
 * (for a reverse proxy or tunnel). Foreign origins stay rejected.
 */
function allowedOrigins(): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) hosts.add(address.address);
    }
  }

  const ports = new Set<string>([process.env.PORT ?? "", "3200", "3000"]);
  const origins = new Set<string>();
  for (const host of hosts) {
    for (const port of ports) {
      if (port) origins.add(`${host}:${port}`);
    }
  }

  for (const entry of (process.env.APP_ORIGINS ?? "").split(",")) {
    const value = entry.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (value) origins.add(value);
  }
  return [...origins];
}

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
