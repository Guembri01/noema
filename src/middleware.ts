import { NextRequest, NextResponse } from "next/server";
import { buildCsp, insideDesktopShell, NONCE_HEADER } from "./lib/security-headers";
import {
  decideIpAllowlist,
  headerClientIp,
  isPrivateSurface,
  parseIpAllowlist,
} from "./lib/tenant-guard";

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
 *
 * Security gates (this batch, additive):
 *  - IP allowlist: private/admin surfaces (`/w/<slug>/settings`,
 *    `/w/<slug>/audit`, `/admin/*`) are gated by the CIDR engine in
 *    `src/lib/ip-allowlist.ts`, read through `src/lib/tenant-guard.ts`.
 *    The allowlist comes from `ADMIN_IP_ALLOWLIST` (fallback
 *    `PRIVATE_IP_ALLOWLIST`), a comma/space separated list of CIDRs. When it
 *    is unset the gate is OPEN (no behaviour change for existing deploys);
 *    once configured it fails CLOSED - a missing, malformed or non-matching
 *    client IP gets a 403, and a configured-but-entirely-invalid allowlist
 *    denies everything rather than silently opening. The client IP is the
 *    first `X-Forwarded-For` hop, falling back to `X-Real-IP` (same
 *    convention as `rate-limit.ts`).
 *  - Access resolution (`access-inheritance.ts`) is exposed to route handlers
 *    through the same guard; middleware stays DB-free so it does not resolve
 *    grants itself.
 */

/** Env vars checked, in order, for the private-surface IP allowlist. */
const IP_ALLOWLIST_ENV = ["ADMIN_IP_ALLOWLIST", "PRIVATE_IP_ALLOWLIST"] as const;

/** The first allowlist env var that is set, with its parsed valid entries. */
function configuredIpAllowlist(): { configured: boolean; entries: string[] } {
  for (const name of IP_ALLOWLIST_ENV) {
    const raw = process.env[name];
    if (raw !== undefined && raw.trim() !== "") {
      return { configured: true, entries: parseIpAllowlist(raw) };
    }
  }
  return { configured: false, entries: [] };
}

/** A minimal 403 body for a blocked private/admin surface. */
function forbidden(): NextResponse {
  return new NextResponse("Forbidden", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Fail-closed IP gate for private/admin surfaces. Returns a 403 response when
 * the surface is private and an allowlist is configured but does not admit the
 * client; otherwise `null` to continue. A configured allowlist with no valid
 * entries also denies.
 */
function ipGate(request: NextRequest): NextResponse | null {
  if (!isPrivateSurface(request.nextUrl.pathname)) return null;
  const allowlist = configuredIpAllowlist();
  if (!allowlist.configured) return null;
  if (allowlist.entries.length === 0) return forbidden();

  const decision = decideIpAllowlist(
    headerClientIp((name) => request.headers.get(name)),
    allowlist.entries,
  );
  return decision.allowed ? null : forbidden();
}

export function middleware(request: NextRequest): NextResponse {
  const blocked = ipGate(request);
  if (blocked) return blocked;

  const nonce = btoa(crypto.randomUUID());
  // Next's dev runtime evaluates module boundaries, so a document CSP without
  // `'unsafe-eval'` leaves every page rendered but *inert* — no hydration, no
  // interactivity. Only development loosens it; a production build (and the static
  // map, which passes no options) keeps `'unsafe-eval'` out.
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV !== "production",
    // Under the desktop shell the page must be able to reach the shell's
    // commands (the window theme is one); the hosted site must not.
    shell: insideDesktopShell(),
  });

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
