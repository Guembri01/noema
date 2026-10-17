import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  buildCsp,
  cspNonce,
  NONCE_HEADER,
  SECURITY_HEADERS,
  THEME_SCRIPT_SHA256,
} from "./security-headers";
import { config as middlewareConfig, middleware } from "../middleware";

/**
 * B98 - CSP nonce middleware (B61 follow-up): `script-src` drops
 * `'unsafe-inline'` and becomes `self + nonce` per response, while every
 * other B61 directive/header stays byte-identical.
 *
 * Red-first: written BEFORE `src/lib/security-headers.ts` (builder) and
 * `src/middleware.ts` existed — both imports failed, then assertions failed
 * on the old `script-src 'self' 'unsafe-inline'` value.
 *
 * The nonce parse is cross-checked against Next.js's own
 * `getScriptNonceFromHeader` (the exact function `app-render` uses during
 * SSR to attach nonces to framework/hydration scripts), so "the browser will
 * allow the scripts Next emits" is proven, not assumed.
 */

const require_ = createRequire(import.meta.url);
const { getScriptNonceFromHeader } = require_(
  "next/dist/server/app-render/get-script-nonce-from-header",
) as { getScriptNonceFromHeader: (header: string) => string | undefined };

/** The exact nonce the middleware recipe generates (docs CSP guide). */
function makeNonce(): string {
  return btoa(crypto.randomUUID());
}

function scriptSrcOf(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
}

function styleSrcOf(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src")) ?? "";
}

function imgSrcOf(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src")) ?? "";
}

function mediaSrcOf(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("media-src")) ?? "";
}

/**
 * The middleware's *document* CSP adds 'unsafe-eval' in development only. Next's dev
 * runtime evaluates module boundaries, and without it a page renders but never
 * hydrates — measured in a browser (a rendered node carried no React props and the
 * browser reported the eval violation), not inferred. The static map and every
 * production build keep it out.
 */
const DEV_EVAL = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

describe("CSP builder (src/lib/security-headers.ts)", () => {
  it("static CSP: script-src is 'self' + pinned theme hash, no unsafe-inline", () => {
    const csp = buildCsp();
    expect(scriptSrcOf(csp)).toBe(`script-src 'self' '${THEME_SCRIPT_SHA256}'`);
    expect(scriptSrcOf(csp)).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("nonce CSP: nonce injected into script-src, still no unsafe-inline", () => {
    const nonce = makeNonce();
    const csp = buildCsp(nonce);
    expect(scriptSrcOf(csp)).toBe(
      `script-src 'self' 'nonce-${nonce}' '${THEME_SCRIPT_SHA256}'`,
    );
    expect(scriptSrcOf(csp)).not.toContain("'unsafe-inline'");
    // Nonce is an exact injection into the static policy - everything else
    // (B61 values minus unsafe-inline) is byte-identical.
    expect(csp).toBe(
      buildCsp().replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
    );
  });

  it("pins the next-themes bootstrap hash in BOTH variants", () => {
    // The one inline script React does not nonce (ThemeProvider injects it)
    // stays executable by hash - without it the theme bootstrap is blocked.
    expect(THEME_SCRIPT_SHA256).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    for (const csp of [buildCsp(), buildCsp(makeNonce())]) {
      expect(scriptSrcOf(csp)).toContain(`'${THEME_SCRIPT_SHA256}'`);
      expect(scriptSrcOf(csp)).not.toContain("'unsafe-inline'");
    }
  });

  it("preserves every other B61 directive verbatim (nonce AND static)", () => {
    for (const csp of [buildCsp(), buildCsp(makeNonce())]) {
      for (const directive of [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob: data: https:",
        // frame-src mirrors detectEmbed() host allowlist (B61).
        "frame-src 'self' https://www.youtube.com https://player.vimeo.com",
        "https://www.loom.com https://open.spotify.com https://w.soundcloud.com",
        "https://www.figma.com https://codepen.io",
      ]) {
        expect(csp, `missing "${directive}"`).toContain(directive);
      }
    }
  });

  it("style-src keeps 'unsafe-inline' and gets NO nonce (TipTap style attrs)", () => {
    // CSP source precedence: a nonce/hash in style-src disables
    // 'unsafe-inline' -> TipTap/ProseMirror style="" attributes would be
    // blocked. So style-src must stay nonce-free with unsafe-inline kept.
    for (const csp of [buildCsp(), buildCsp(makeNonce())]) {
      expect(styleSrcOf(csp)).toBe("style-src 'self' 'unsafe-inline'");
      expect(styleSrcOf(csp)).not.toContain("'nonce-");
    }
  });

  it("nonce is valid base64 and round-trips through cspNonce + Next's parser", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const csp = buildCsp(nonce);
    expect(cspNonce(csp)).toBe(nonce);
    // Next's own extraction (used by app-render SSR) yields the same value.
    expect(getScriptNonceFromHeader(csp)).toBe(nonce);
    expect(getScriptNonceFromHeader(buildCsp())).toBeUndefined();
    expect(cspNonce(buildCsp())).toBeNull();
  });

  it("SECURITY_HEADERS: 5 keys, non-CSP values unchanged, CSP = builder output", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(
      [
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
      ].sort(),
    );
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toBe(
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
    // Single source of truth: the static map cannot drift from the builder.
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe(buildCsp());
  });
});

describe("CSP nonce middleware (src/middleware.ts)", () => {
  it("sets a per-response nonce CSP on the response", () => {
    const response = middleware(new NextRequest("http://localhost:3201/login"));
    const served = response.headers.get("Content-Security-Policy");
    expect(served).toBeTruthy();
    const nonce = getScriptNonceFromHeader(served!);
    expect(nonce, "response CSP carries no nonce Next can extract").toBeTruthy();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(scriptSrcOf(served!)).toBe(
      `script-src 'self' 'nonce-${nonce}' '${THEME_SCRIPT_SHA256}'${DEV_EVAL}`,
    );
    expect(scriptSrcOf(served!)).not.toContain("'unsafe-inline'");
    expect(styleSrcOf(served!)).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("forwards x-nonce + the same CSP to the render via request headers", () => {
    // NextResponse.next({ request: { headers } }) surfaces forwarded headers
    // as `x-middleware-request-*`; app-render reads the forwarded
    // Content-Security-Policy and attaches the nonce to hydration scripts.
    const response = middleware(new NextRequest("http://localhost:3201/login"));
    const served = response.headers.get("Content-Security-Policy")!;
    const nonce = getScriptNonceFromHeader(served)!;
    expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(served);
  });

  it("generates a FRESH nonce per request (two calls differ)", () => {
    const a = middleware(new NextRequest("http://localhost:3201/login"));
    const b = middleware(new NextRequest("http://localhost:3201/login"));
    const nonceA = getScriptNonceFromHeader(a.headers.get("Content-Security-Policy")!)!;
    const nonceB = getScriptNonceFromHeader(b.headers.get("Content-Security-Policy")!)!;
    expect(nonceA).not.toBe(nonceB);
  });

  it("matcher skips _next/, api/ and favicon (middleware runs on documents only)", () => {
    const sources = JSON.stringify(middlewareConfig.matcher);
    expect(middlewareConfig.matcher?.length).toBeGreaterThan(0);
    for (const excluded of ["_next/", "api/", "favicon.ico"]) {
      expect(sources, `matcher must exclude ${excluded}`).toContain(excluded);
    }
    // Excluded paths still get B61's static CSP from next.config headers().
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("nonce");
  });
});

/**
 * B69 - the public share pages (`/s/<token>`) get their own policy:
 *
 *  - no third-party host in `img-src`/`media-src` - every picture on that
 *    page is fetched by the server's proxy, so the browser never talks to the
 *    host that hosts it;
 *  - `Referrer-Policy: no-referrer` - the share token lives in the URL, and
 *    a `Referer` would carry it to every other host.
 */
describe("the share route policy (B69)", () => {
  it("builds a policy without third-party media", () => {
    const csp = buildCsp(makeNonce(), { allowExternalMedia: false });
    expect(imgSrcOf(csp)).toBe("img-src 'self' data: blob:");
    expect(mediaSrcOf(csp)).toBe("media-src 'self' blob: data:");
    // The site's own policy keeps the third-party allowance.
    expect(imgSrcOf(buildCsp())).toBe("img-src 'self' data: blob: https:");
    expect(mediaSrcOf(buildCsp())).toBe("media-src 'self' blob: data: https:");
  });

  it("serves a share page without third-party media and with no Referer", () => {
    const response = middleware(new NextRequest("http://localhost:3201/s/abc123"));
    const served = response.headers.get("Content-Security-Policy")!;
    expect(imgSrcOf(served)).toBe("img-src 'self' data: blob:");
    expect(mediaSrcOf(served)).toBe("media-src 'self' blob: data:");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("leaves the rest of the site alone", () => {
    const response = middleware(new NextRequest("http://localhost:3201/login"));
    const served = response.headers.get("Content-Security-Policy")!;
    expect(imgSrcOf(served)).toBe("img-src 'self' data: blob: https:");
    // The site-wide policy comes from the header map in next.config.ts.
    expect(response.headers.get("Referrer-Policy")).toBeNull();
  });
});
