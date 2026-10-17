/**
 * SSRF guard for server-side outbound fetches (security audit #1, H4;
 * B59 calendar feeds, B10 link preview).
 *
 * Built on `isPrivateHost` (`src/lib/embeds.ts`) and closes the gaps a
 * literal-host check leaves open (audit M1): bracketed IPv6 literals, the
 * full private/reserved IPv4 and IPv6 range sets, DNS resolution of hostnames
 * (rebind-style answers are rejected), and re-validation of every redirect
 * hop (`redirect: "manual"`).
 *
 * `safeFetchGuarded()` is the single entry point for every outbound fetch
 * that follows untrusted URLs: the calendar feed path (`safeFetchFeed()`,
 * which is a thin wrapper around it) and the link-preview route
 * (`src/app/api/link-preview/route.ts`) both go through it, so the two
 * cannot drift apart.
 *
 * Everything fails closed: an unparseable URL, a non-http(s) scheme, a DNS
 * error or an exhausted redirect budget all answer `null`/`true`/`blocked`,
 * and callers surface one uniform error so a connector cannot be used as a
 * status oracle.
 *
 * Unit-pinned by `src/lib/feed-guard.test.ts` (ranges, rebinding, redirects)
 * and `src/server/actions/calendar.test.ts` (through the real action).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateHost } from "@/lib/embeds";

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: every A/AAAA answer for the hostname. */
export const defaultHostResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/** WHATWG keeps IPv6 literals bracketed - strip brackets, dot and case. */
function normalizeHost(raw: string): string {
  return raw.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

/**
 * Literal IP range check: loopback, RFC1918, CGNAT, link-local (cloud
 * metadata), documentation/benchmarking ranges, multicast/reserved plus the
 * IPv6 equivalents (loopback, link-local, unique-local, multicast,
 * IPv4-mapped). Anything that is not a parseable IP counts as blocked
 * (fail closed) - callers only reach this with `isIP()`-confirmed input or a
 * resolver's answers.
 */
export function isBlockedIpLiteral(ip: string): boolean {
  const value = ip.toLowerCase().split("%")[0]; // drop an IPv6 zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return isBlockedIpLiteral(mapped[1]);
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet > 255)) return true;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return true; // "this", private, loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + TEST-NET-1
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (version === 6) {
    if (value === "::" || value === "::1") return true;
    if (/^f[cd]/.test(value)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(value)) return true; // fe80::/10 link-local
    if (/^ff/.test(value)) return true; // ff00::/8 multicast
    if (/^2001:0?db8/.test(value)) return true; // 2001:db8::/32 documentation
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(value)) return true; // hex-mapped: never guess
    return false;
  }
  return true;
}

/** Host-level rules: literal IPs go to the range checks, internal TLDs and `isPrivateHost` for names. */
export function isBlockedFeedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  const version = isIP(host);
  if (version === 4 || version === 6) return isBlockedIpLiteral(host);
  if (host.endsWith(".localhost")) return true;
  return isPrivateHost(host);
}

/**
 * Loopback-only host test (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`).
 * Gates the development-only feed exemption below, so allowing a local mock
 * feed never opens the wider private/metadata ranges.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const version = isIP(host);
  if (version === 4) return host.split(".")[0] === "127";
  if (version === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

/** Options for {@link isBlockedFeedTarget}. */
export type FeedTargetOptions = {
  /**
   * Allow loopback hosts while `NODE_ENV` is `development` - the end-to-end
   * check subscribes to a hermetic mock calendar served on loopback (`:4323`,
   * see docs/TEST_PLAN.md), which the shipped guard would otherwise refuse.
   *
   * Defaults to `true` so the calendar path keeps its exemption. The
   * link-preview route opts out: it has no mock feed to serve, so it stays
   * strict in every environment.
   */
  allowDevLoopback?: boolean;
};

/**
 * Full target check: scheme, hostname ranges, then DNS - every answer must be
 * public. Returns true when the target must NOT be fetched. Fail closed on
 * unparseable URLs, non-http(s) schemes and resolver errors.
 *
 * `next dev` (NODE_ENV `development`) is the one exception: the end-to-end
 * check subscribes to a hermetic mock calendar served on loopback (`:4323`,
 * see docs/TEST_PLAN.md), which the shipped guard would otherwise refuse. Only
 * loopback hosts are exempt, and only in development - vitest runs as `test`
 * and deployments as `production`, so the security suite and the shipped guard
 * still fail closed on every private range. Callers that must stay strict
 * everywhere (the link-preview route) pass `allowDevLoopback: false`.
 */
export async function isBlockedFeedTarget(
  rawUrl: string,
  resolve: HostResolver = defaultHostResolver,
  options: FeedTargetOptions = {},
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const hostname = normalizeHost(url.hostname);
  if (isBlockedFeedHost(hostname)) {
    const allowDevLoopback = options.allowDevLoopback ?? true;
    if (allowDevLoopback && process.env.NODE_ENV === "development" && isLoopbackHost(hostname)) {
      return false;
    }
    return true;
  }
  if (isIP(hostname)) return false; // a public literal - nothing to resolve
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return true; // a DNS failure must not open the gate
  }
  if (addresses.length === 0) return true;
  return addresses.some((address) => isBlockedIpLiteral(address));
}

export type FeedFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type FeedFetchOptions = {
  /** Injected by tests; defaults to the global `fetch` at call time. */
  fetchFn?: FeedFetchFn;
  /** Redirects followed before giving up (default 3). */
  maxRedirects?: number;
  /** Injected by tests; defaults to the system resolver at call time. */
  resolve?: HostResolver;
  /** Loopback exemption in `development` - see {@link FeedTargetOptions}. */
  allowDevLoopback?: boolean;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Why a guarded fetch produced no response. */
export type GuardedFetchFailure = "blocked" | "failed";

/**
 * Outcome of a guarded fetch: the response plus the URL it was finally
 * requested from, or the reason there is none. `blocked` means the target
 * (or a redirect hop) was refused by the SSRF guard; `failed` means the
 * request itself went wrong (network error, timeout, redirect budget
 * exhausted) - the two are never conflated, so a caller can answer a refused
 * target with a block and a broken one with a neutral fallback.
 */
export type GuardedFetchResult =
  | { ok: true; response: Response; finalUrl: string }
  | { ok: false; reason: GuardedFetchFailure };

/** Do two URLs point at the same host? (`response.url` may differ only in path.) */
function sameHost(a: string, b: string): boolean {
  try {
    return normalizeHost(new URL(a).hostname) === normalizeHost(new URL(b).hostname);
  } catch {
    return false;
  }
}

/**
 * Fetch a URL only when the initial target AND every redirect hop pass
 * the guard. Redirects are requested with `redirect: "manual"` and each
 * `Location` is re-validated before it is followed. Returns `blocked` when
 * the guard refuses a target, `failed` on a network error, an unusable
 * `Location` or an exhausted redirect budget.
 *
 * The URL the response was finally read from is returned as `finalUrl` so
 * callers can resolve relative references against the page that answered -
 * never against the URL the caller asked for.
 */
export async function safeFetchGuarded(
  rawUrl: string,
  init?: RequestInit,
  options: FeedFetchOptions = {},
): Promise<GuardedFetchResult> {
  const fetchFn: FeedFetchFn =
    options.fetchFn ?? ((url, requestInit) => globalThis.fetch(url, requestInit));
  const maxRedirects = options.maxRedirects ?? 3;
  const resolve = options.resolve ?? defaultHostResolver;
  const targetOptions: FeedTargetOptions = { allowDevLoopback: options.allowDevLoopback };
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (await isBlockedFeedTarget(current, resolve, targetOptions)) {
      return { ok: false, reason: "blocked" };
    }
    let response: Response;
    try {
      response = await fetchFn(current, { ...init, redirect: "manual" });
    } catch {
      return { ok: false, reason: "failed" };
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      // Defence in depth: a `fetch` that followed a redirect on its own would
      // report the final target here. Re-check it instead of trusting it -
      // but only when the host changed, the host of `current` is validated
      // already.
      const finalUrl = response.url !== "" ? response.url : current;
      if (finalUrl !== current && !sameHost(current, finalUrl)) {
        if (await isBlockedFeedTarget(finalUrl, resolve, targetOptions)) {
          return { ok: false, reason: "blocked" };
        }
      }
      return { ok: true, response, finalUrl };
    }
    const location = response.headers.get("location");
    if (!location) return { ok: false, reason: "failed" };
    try {
      current = new URL(location, current).toString();
    } catch {
      return { ok: false, reason: "failed" };
    }
  }
  return { ok: false, reason: "failed" };
}

/**
 * Fetch a feed URL only when the initial target AND every redirect hop pass
 * the guard. Returns `null` on block, redirect-budget exhaustion or network
 * failure - callers report one uniform error either way.
 */
export async function safeFetchFeed(
  rawUrl: string,
  init?: RequestInit,
  options: FeedFetchOptions = {},
): Promise<Response | null> {
  const result = await safeFetchGuarded(rawUrl, init, options);
  return result.ok ? result.response : null;
}
