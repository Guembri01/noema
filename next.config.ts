import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hstsHeader, SECURITY_HEADERS, SHARE_SECURITY_HEADERS } from "./src/lib/security-headers";
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

export { SECURITY_HEADERS, SHARE_SECURITY_HEADERS };

const root = dirname(fileURLToPath(import.meta.url));

/** The app version, from the one file that owns it. */
const packageVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/**
 * B61 - security headers on EVERY response (M9,
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
  // The About box shows the app version. The *site* build has no desktop bridge
  // to read it from, and `npm_package_version` only exists while npm is the
  // parent process (a container does not have it), so the number is inlined at
  // build time from the one place that owns it — `package.json`, which is also
  // what `tauri.conf.json` and `/api/health` report.
  env: { NEXT_PUBLIC_APP_VERSION: packageVersion },
  // Default builds do not enable collaboration. Alias the real Yjs loader to a
  // no-op module so its dynamic imports never create a chunk in the first place;
  // a deploy that sets NEXT_PUBLIC_COLLAB_URL builds the real loader instead.
  webpack(config) {
    if (!process.env.NEXT_PUBLIC_COLLAB_URL) {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@/components/editor/collaboration-session": join(
          root,
          "src/components/editor/collaboration-session-disabled.ts",
        ),
        "./collaboration-session": join(
          root,
          "src/components/editor/collaboration-session-disabled.ts",
        ),
        [join(root, "src/components/editor/collaboration-session.ts")]: join(
          root,
          "src/components/editor/collaboration-session-disabled.ts",
        ),
      };
    }
    return config;
  },
  // B78: the response must not name the framework. Next.js sends
  // `X-Powered-By: Next.js` on every HTML response unless this switch is off,
  // and the default is on (`poweredByHeader: true` in Next's own default
  // config, next/dist/server/config-shared.js). The header map below cannot
  // cover it: `headers()` only *adds* headers, while the framework sets this
  // one itself when it sends the HTML (next/dist/server/send-payload.js) — so
  // the switch has to live here.
  poweredByHeader: false,
  // Pin the tracing root so an unrelated lockfile above this project does not
  // change how the standalone output is assembled.
  outputFileTracingRoot: root,
  experimental: {
    serverActions: {
      allowedOrigins: allowedOrigins(),
      // B22 — the body budget for *server actions*.
      //
      // Next.js only offers a body limit for server actions (`bodySizeLimit`);
      // it applies to the RSC action requests, not to the App Router route
      // handlers, and the app router has no equivalent switch in this Next
      // version (15.5). The route handlers therefore carry their own
      // per-route budgets (`src/lib/body-limit.ts`), and this value only
      // bounds the action endpoints — the imports that take a file
      // (`.docx`, `.zip`) among them.
      //
      // It stays at Next's 1 MB default on purpose: raising it would widen the
      // input of every action that parses an uploaded file, and the archive
      // import's own budget (entry count + unpacked size) is what keeps a zip
      // bomb harmless.
      bodySizeLimit: "1mb",
    },
  },
  // B61: catch-all source so no response class (incl. public share pages)
  // misses the map above. B98: on document paths src/middleware.ts
  // supersedes the CSP with the per-response nonce variant; api/, _next/
  // and favicon keep serving exactly this static policy.
  // B69: the public share pages (`/s/<token>`) carry the share token in their
  // URL, so they answer with `Referrer-Policy: no-referrer` instead of the
  // site-wide `strict-origin-when-cross-origin`. The entry comes AFTER the
  // catch-all, and Next applies the matching entries in order, so it is the
  // one that decides the `Referrer-Policy` on a share page.
  //
  // B33: `Strict-Transport-Security` is the one header that is **not** in the
  // map above, because its value depends on the deployment (`HSTS_MAX_AGE`,
  // plus the optional `HSTS_INCLUDE_SUBDOMAINS`). It is sent by default —
  // with one year — so a deployment that is served over HTTPS pins HTTPS; a
  // deployment that is not loses nothing, because a browser ignores an STS
  // header that arrives over plain HTTP (RFC 6797 §7.2). `HSTS_MAX_AGE=0` is
  // the documented way out (no header at all), and `hstsHeader()` refuses a
  // malformed value (fail closed): no header, never a broken policy.
  //
  // The value is read when `headers()` runs, and Next writes the result into
  // `routes-manifest.json` at BUILD time — so in production the variable has
  // to be present for the build (`npm run build`, `docker build`), not only
  // for the start. That is the same freeze the Edge middleware has (see
  // docs/OPERATIONS.md §1.1).
  async headers() {
    const hsts = hstsHeader();
    return [
      {
        source: "/:path*",
        headers: [
          ...Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
          ...(hsts ? [hsts] : []),
        ],
      },
      {
        source: "/s/:path*",
        headers: Object.entries(SHARE_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
