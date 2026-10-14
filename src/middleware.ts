import { NextRequest, NextResponse } from "next/server";
import { buildCsp, NONCE_HEADER } from "./lib/security-headers";

/**
 * B98 - per-response CSP nonce (B61 follow-up): drops `'unsafe-inline'` from
 * `script-src` in favour of `script-src 'self' 'nonce-<b64>'`.
 *
 * Mechanism (Next 15 App Router, `middleware.ts` file convention - Next 16
 * renames the same concept to `proxy.ts`), per the official CSP guide:
 *
 * 1. A fresh base64 nonce is generated for EVERY request.
 * 2. The nonce travels to the render on the REQUEST headers: both `x-nonce`
 *    and `Content-Security-Policy` are set on the headers handed to
 *    `NextResponse.next({ request: { headers } })` (surfaced internally as
 *    `x-middleware-request-*`). During SSR, Next.js parses that forwarded
 *    CSP (`getScriptNonceFromHeader` in `next/dist/server/app-render/`) and
 *    AUTOMATICALLY attaches the nonce to React/Next runtime scripts, page
 *    bundles and the inline hydration scripts (`self.__next_f.push(...)`) -
 *    no root-layout or component change is needed (this is why no
 *    `x-nonce-set` cookie exists here: the header is same-request, so a
 *    cross-request cookie signal would add nothing).
 * 3. The identical CSP is set on the RESPONSE headers so the browser
 *    enforces exactly what SSR was told to sign.
 *
 * `next start`: the same middleware + SSR path runs in production, so the
 * mechanism is identical - with one documented requirement from the Next
 * docs: nonce pages must be DYNAMICALLY rendered (static-prerendered HTML is
 * generated at build time with no request context and would ship script tags
 * without the nonce). Flagged in docs/audits/security-1.md M9 for the next
 * Tier MAX build to re-verify against :3200 (no build in this batch).
 *
 * Skipped: `api/` (JSON responses execute no scripts; they keep B61's static
 * CSP from `next.config.ts`), `_next/` (immutable assets + HMR/devtools
 * streams), `favicon.ico`, and `next-router-prefetch`/`purpose: prefetch`
 * RSC prefetches (payload responses, no scripts - saves middleware work).
 * All of those still receive the static `script-src 'self'` policy via
 * `headers()`.
 *
 * `style-src 'self' 'unsafe-inline'` is deliberately untouched (TipTap
 * inline style attributes - a nonce there would disable 'unsafe-inline').
 */

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Documents + RSC navigations only. Everything under `api/`, `_next/`
     * and favicon is excluded; prefetch RSC payloads are excluded via the
     * `missing` conditions below.
     */
    {
      source: "/((?!api/|_next/|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
