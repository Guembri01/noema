import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import nextConfig, { SECURITY_HEADERS, SHARE_SECURITY_HEADERS } from "../../next.config";
import { buildCsp, cspNonce, insideDesktopShell, THEME_SCRIPT_SHA256 } from "./security-headers";

/**
 * B61 - security headers on EVERY response (M9,
 * roadmap R10), incl. the public `/s/<token>` share pages.
 *
 * Red-first: this file failed to import before `next.config.ts` exported
 * `SECURITY_HEADERS` (missing export), then failed on values before the
 * `headers()` wiring existed. The last test does a live fetch against the dev
 * server so the whole path (map -> headers() -> actual HTTP response) is
 * proven, not just the config shape.
 *
 * B98 (this revision): `script-src` drops `'unsafe-inline'` - the static map
 * is now `script-src 'self'` and document responses get the per-response
 * nonce from `src/middleware.ts`. `style-src 'unsafe-inline'` stays (TipTap).
 */

const HEADER_NAMES = [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
] as const;

/** Dev server by default; overridable so the maintainers can point elsewhere. */
const BASE_URL = process.env.SEC_HEADERS_BASE_URL ?? "http://localhost:3201";

describe("security headers (next.config.ts)", () => {
  it("exports exactly the audited header map", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([...HEADER_NAMES].sort());
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toBe(
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  });

  it("keeps the share map on the site's map but with `no-referrer` (B69)", () => {
    expect(Object.keys(SHARE_SECURITY_HEADERS).sort()).toEqual([...HEADER_NAMES].sort());
    expect(SHARE_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    for (const key of HEADER_NAMES) {
      if (key === "Referrer-Policy") continue;
      expect(SHARE_SECURITY_HEADERS[key], key).toBe(SECURITY_HEADERS[key]);
    }
  });

  it("CSP enforces the lockdown directives and the compatibility allowances", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toBeTruthy();
    // Defense-in-depth directives (audit H2/H3/M9).
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob: https:",
    ]) {
      expect(csp, `missing "${directive}"`).toContain(directive);
    }
    // Enforced, not report-only.
    expect(csp).not.toMatch(/Content-Security-Policy-Report-Only/);
    // `unsafe-eval` must never reach a shipped build. The static map is the shipped
    // shape by construction (no options), and the per-document CSP the middleware
    // builds may add it in development only — because Next's dev runtime evaluates
    // module boundaries, and without it the whole page fails to hydrate: the markup
    // renders, so it looks fine, but nothing is interactive. That was measured in a
    // browser (a rendered node carried no React props, and the browser reported the
    // eval violation), not inferred.
    expect(csp).not.toContain("unsafe-eval");
    expect(buildCsp(null, { dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp(null, { dev: false })).not.toContain("unsafe-eval");
    // B98: 'unsafe-inline' dropped from script-src - Next.js App Router
    // hydration scripts are nonced per response by src/middleware.ts (this
    // static map is the fallback for middleware-skipped paths). The pinned
    // sha256 keeps the next-themes bootstrap executable (it is the one
    // inline script React does not nonce). TipTap/React inline styles still
    // need style-src 'unsafe-inline', which stays.
    expect(csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))).toBe(
      `script-src 'self' '${THEME_SCRIPT_SHA256}'`,
    );
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Noema embeds OTHERS (embeds.ts allowlist) - it is never embedded itself,
    // so framing is denied outright.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://www.youtube.com");
    expect(csp).toContain("https://w.soundcloud.com");
  });

  it("keeps Tauri's IPC endpoint out of the site's policy", () => {
    // `.localhost` resolves to loopback *in a browser*, so admitting it in the
    // hosted site would let a page (or an XSS in one) reach whatever is
    // listening on the user's 127.0.0.1. Only the desktop server widens this.
    const connectSrc = (csp: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("connect-src"));
    expect(connectSrc(buildCsp())).toBe("connect-src 'self'");
    expect(connectSrc(buildCsp(null, { dev: true }))).toBe("connect-src 'self'");
    expect(connectSrc(buildCsp("nonce-value"))).toBe("connect-src 'self'");
  });

  it("admits the IPC endpoint when this process is the desktop's own server", () => {
    // The installed app is a webview pointed at this server: without the IPC it
    // cannot reach a single shell command, so the window chrome silently
    // stopped tracking the workspace theme.
    const shellPolicy = buildCsp(null, { shell: true });
    expect(shellPolicy).toContain("connect-src 'self' ipc: http://ipc.localhost");
    // Exactly one directive differs from the site policy.
    expect(shellPolicy).toBe(
      buildCsp().replace(
        "connect-src 'self'",
        "connect-src 'self' ipc: http://ipc.localhost",
      ),
    );

    const savedRuntime = process.env.NOEMA_RUNTIME;
    const savedStandalone = process.env.NOEMA_STANDALONE;
    try {
      delete process.env.NOEMA_RUNTIME;
      delete process.env.NOEMA_STANDALONE;
      expect(insideDesktopShell()).toBe(false);
      // The shell sets this for its child process (src-tauri/src/sidecar.rs)…
      process.env.NOEMA_RUNTIME = "desktop";
      expect(insideDesktopShell()).toBe(true);
      // …and the payload build is what bakes the static map.
      delete process.env.NOEMA_RUNTIME;
      process.env.NOEMA_STANDALONE = "1";
      expect(insideDesktopShell()).toBe(true);
    } finally {
      if (savedRuntime === undefined) delete process.env.NOEMA_RUNTIME;
      else process.env.NOEMA_RUNTIME = savedRuntime;
      if (savedStandalone === undefined) delete process.env.NOEMA_STANDALONE;
      else process.env.NOEMA_STANDALONE = savedStandalone;
    }
  });

  it("wires the map through headers() for every path", async () => {
    const entries = await nextConfig.headers!();
    expect(entries.length).toBeGreaterThan(0);
    const expected = Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value }));
    // Catch-all source -> covers static, dynamic, API and /s/<token> pages.
    const catchAll = entries.find((entry) => entry.source === "/:path*");
    expect(catchAll?.headers).toEqual(expected);
  });

  it("answers the public share pages with `Referrer-Policy: no-referrer` (B69)", async () => {
    const entries = await nextConfig.headers!();
    // The share entry comes AFTER the catch-all, and Next applies the matching
    // entries in order, so it is the one that decides the `Referrer-Policy` on
    // a share page.
    const order = entries.map((entry) => entry.source);
    expect(order.indexOf("/:path*")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("/s/:path*")).toBeGreaterThan(order.indexOf("/:path*"));

    const share = entries.find((entry) => entry.source === "/s/:path*");
    const referrer = share?.headers.find((header) => header.key === "Referrer-Policy");
    expect(referrer?.value).toBe("no-referrer");
    // Every other header is the site's map, unchanged.
    const expected = Object.entries(SECURITY_HEADERS)
      .filter(([key]) => key !== "Referrer-Policy")
      .map(([key, value]) => ({ key, value }));
    expect(share?.headers.filter((header) => header.key !== "Referrer-Policy")).toEqual(expected);
    // The site's own pages keep the looser policy.
    const catchAll = entries.find((entry) => entry.source === "/:path*");
    expect(
      catchAll?.headers.find((header) => header.key === "Referrer-Policy")?.value,
    ).toBe("strict-origin-when-cross-origin");
  });

  it("serves B61's map on a real dev-server response (live fetch)", async () => {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      // Never fail concurrent suites' gates when dev :3201 is intentionally down
      // (Tier HEAVY build window). Network-level failure only; a reachable
      // server with wrong headers still fails below.
      console.warn(
        `[security-headers] ${BASE_URL} unreachable - live probe skipped (${String(error)})`,
      );
      return;
    }
    for (const name of HEADER_NAMES) {
      if (name === "Content-Security-Policy") continue;
      expect(response.headers.get(name), name).toBe(SECURITY_HEADERS[name]);
    }
    // B98: document responses carry the middleware's nonce CSP - the static
    // policy with exactly one change: script-src gains 'nonce-<b64>'.
    const served = response.headers.get("Content-Security-Policy");
    const nonce = served ? cspNonce(served) : null;
    expect(nonce, "no nonce CSP on /login (middleware not applied?)").toBeTruthy();
    expect(served).toBe(
      SECURITY_HEADERS["Content-Security-Policy"].replace(
        "script-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
      ),
    );
    const scriptSrc = served!
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(
      `script-src 'self' 'nonce-${nonce}' '${THEME_SCRIPT_SHA256}'`,
    );
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Every inline script actually served is covered: nonced with the
    // response nonce, or explicitly hashed (next-themes bootstrap). This is
    // what keeps the browser console clean - a new unnonced inline script
    // from any component fails HERE instead of silently breaking at runtime.
    const html = await response.text();
    let inlineCount = 0;
    for (const tag of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(tag[1])) continue;
      inlineCount += 1;
      const tagNonce = tag[1].match(/nonce="([^"]*)"/)?.[1] ?? null;
      if (tagNonce) {
        expect(tagNonce, "inline script nonced with a stale/foreign nonce").toBe(nonce);
      } else {
        const hash =
          "sha256-" + createHash("sha256").update(tag[2], "utf8").digest("base64");
        expect(
          scriptSrc,
          `unnonced inline script not allowed by hash: ${hash} :: ${tag[2].slice(0, 60)}`,
        ).toContain(`'${hash}'`);
      }
    }
    expect(inlineCount).toBeGreaterThan(0);

    // Middleware-skipped paths (api/) keep the static fallback untouched.
    const api = await fetch(`${BASE_URL}/api/__b98-does-not-exist`, {
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
    }).catch(() => null);
    if (api) {
      expect(api.headers.get("Content-Security-Policy")).toBe(
        SECURITY_HEADERS["Content-Security-Policy"],
      );
      expect(api.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  }, 60_000);
});
