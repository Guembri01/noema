/**
 * SSRF guard for server-side requests to user-configured URLs (security audit
 * #1, H4; B59 calendar feeds, B10 link preview, B11 outbound webhooks).
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
 * `isBlockedOutboundTarget` is the ONE network gate for every outbound
 * request to a user-supplied URL; `isBlockedFeedTarget` is the feed flavour
 * of it (identical rules plus the development-only loopback exemption) and
 * `safeFetchFeed` adds the redirect re-validation on top.
 *
 * Two exemptions open the loopback range - and nothing else. The
 * `NODE_ENV === "development"` rule (unchanged, for the hermetic local
 * receivers of a dev server) and the explicit operator opt-in
 * `NOEMA_ALLOW_LOOPBACK_TARGETS=1` (B11). The opt-in has to be asked for by
 * the caller (`allowLoopbackWithOptIn`) AND granted by the operator, so the
 * shipped production payload refuses a loopback target unless the operator
 * says so explicitly. Either way the exemption covers the loopback range
 * ONLY: RFC1918, link-local, the cloud metadata addresses and every
 * `.internal` name stay refused.
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
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateHost } from "@/lib/embeds";

/**
 * The transport present when this module loaded. Tests replace `globalThis.fetch`
 * with an offline double; production keeps the native implementation.
 */
const nativeFetch = globalThis.fetch;

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

/**
 * Host-level rules: literal IPs go to the range checks, internal TLDs and `isPrivateHost` for names.
 * Shared by every outbound guard (feeds and webhooks alike).
 */
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
 * Gates the loopback exemptions below, so allowing a local mock feed or a
 * local webhook receiver never opens the wider private/metadata ranges.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isLoopbackAddress(host);
}

/**
 * Loopback-only address test (`127.0.0.0/8`, `::1`) - the address twin of
 * `isLoopbackHost`, used for the answers a resolver returns.
 */
function isLoopbackAddress(address: string): boolean {
  const value = address.toLowerCase().split("%")[0]; // drop an IPv6 zone id
  const version = isIP(value);
  if (version === 4) return value.split(".")[0] === "127";
  if (version === 6) return value === "::1" || value === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * B11 — the operator opt-in for the loopback range.
 *
 * The shipped payload runs with `NODE_ENV=production` (the desktop sidecar
 * sets it), and the live checks need a loopback receiver:
 * `scripts/check-webhooks.mjs` registers a hook on `127.0.0.1:4280`. A
 * `NODE_ENV` rule cannot serve both — the production guard must not exempt
 * loopback on its own — so the exemption is an explicit operator opt-in.
 * It is off unless the variable is set to an explicit "on" value, and it
 * never opens more than the loopback range.
 */
export const LOOPBACK_TARGET_OPT_IN_ENV = "NOEMA_ALLOW_LOOPBACK_TARGETS";

/** The opt-in counts as given when the variable holds an explicit "on" value. */
export function isLoopbackTargetOptIn(): boolean {
  const value = process.env[LOOPBACK_TARGET_OPT_IN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export type OutboundTargetOptions = {
  /** Injected by tests; defaults to the global resolver. */
  resolve?: HostResolver;
  /**
   * Relax the loopback rule while `next dev` runs. Only the hermetic local
   * receivers need it (the mock ICS feed on `:4323`, the webhook receiver of
   * `scripts/check-webhooks.mjs` on `:4280`); production and the test suite
   * keep failing closed on every private range.
   */
  allowLoopbackInDevelopment?: boolean;
  /**
   * B11 — ask for the operator opt-in (`NOEMA_ALLOW_LOOPBACK_TARGETS=1`).
   * The request is only granted when the operator set the variable, so a
   * caller alone can never open the loopback range. Only the webhook path
   * asks for it: the calendar feed path must keep refusing a loopback feed
   * in production, and the live checks assert exactly that.
   */
  allowLoopbackWithOptIn?: boolean;
};

/**
 * The two loopback exemptions in one place. Both are limited to the loopback
 * range - the caller decides which one may apply, the guard decides whether
 * the conditions are met.
 */
function loopbackExempted(options: OutboundTargetOptions): boolean {
  if (options.allowLoopbackInDevelopment && process.env.NODE_ENV === "development") {
    return true;
  }
  return Boolean(options.allowLoopbackWithOptIn) && isLoopbackTargetOptIn();
}

/**
 * The shared network gate for every outbound request to a user-configured
 * URL: scheme, hostname ranges, then DNS - every answer must be public.
 * Returns true when the target must NOT be contacted. Fails closed on
 * unparseable URLs, non-http(s) schemes and resolver errors.
 *
 * This is the network part of the guard, extracted so that the feed path and
 * the outbound-webhook path share ONE implementation (B11) instead of
 * duplicating the range/DNS rules.
 *
 * `next dev` (NODE_ENV `development`) is the one feed exception: the end-to-end
 * check subscribes to a hermetic mock calendar served on loopback (`:4323`,
 * see docs/TEST_PLAN.md), which the shipped guard would otherwise refuse. Only
 * loopback hosts are exempt, and only when the caller asks for that exemption;
 * vitest runs as `test` and deployments as `production`, so the security suite
 * and the shipped guard still fail closed on every private range. The
 * link-preview route passes no loopback exemption at all.
 */
type OutboundResolution =
  | { blocked: true; address: null; transient: false }
  | { blocked: true; address: null; transient: true }
  | { blocked: false; address: string; transient: false };

/**
 * Resolve a target to the **one address the request must use**.
 *
 * Checking a hostname and then fetching it again is a DNS-rebinding race: the
 * second lookup can answer with an internal address after the first one
 * passed. The caller therefore fetches the address returned here, not the
 * hostname. Every DNS answer is validated; the first public answer is pinned
 * for the connection (TLS still uses the URL hostname for SNI and certificate
 * verification).
 *
 * `transient` distinguishes a resolver failure from a policy refusal. Both
 * fail closed, but a caller that retries can keep retrying a resolver outage
 * instead of treating it as a permanently blocked target.
 */
export async function resolveOutboundTarget(
  rawUrl: string,
  options: OutboundTargetOptions = {},
): Promise<OutboundResolution> {
  const resolve = options.resolve ?? defaultHostResolver;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: true, address: null, transient: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { blocked: true, address: null, transient: false };
  }
  const hostname = normalizeHost(url.hostname);
  if (isBlockedFeedHost(hostname)) {
    if (isLoopbackHost(hostname) && loopbackExempted(options)) {
      return { blocked: false, address: hostname, transient: false };
    }
    return { blocked: true, address: null, transient: false };
  }
  if (isIP(hostname)) {
    return { blocked: false, address: hostname, transient: false }; // a public literal
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { blocked: true, address: null, transient: true };
  }
  if (addresses.length === 0) {
    // An empty answer is a resolver failure, not a policy decision.
    return { blocked: true, address: null, transient: true };
  }
  // B11 — with an exemption in force, a name whose EVERY answer is a
  // loopback address is a local target and may pass. A mixed answer
  // (loopback + anything else) stays refused.
  if (
    loopbackExempted(options) &&
    addresses.every((address) => isLoopbackAddress(address))
  ) {
    return { blocked: false, address: addresses[0], transient: false };
  }
  if (addresses.some((address) => isBlockedIpLiteral(address))) {
    return { blocked: true, address: null, transient: false };
  }
  return { blocked: false, address: addresses[0], transient: false };
}

export async function isBlockedOutboundTarget(
  rawUrl: string,
  options: OutboundTargetOptions = {},
): Promise<boolean> {
  return (await resolveOutboundTarget(rawUrl, options)).blocked;
}

/**
 * Full target check for a calendar feed: the shared outbound gate plus the
 * development-only loopback exemption.
 *
 * `next dev` (NODE_ENV `development`) is the one exception: the end-to-end
 * check subscribes to a hermetic mock calendar served on loopback (`:4323`,
 * see docs/TEST_PLAN.md), which the shipped guard would otherwise refuse. Only
 * loopback hosts are exempt, and only in development - vitest runs as `test`
 * and deployments as `production`, so the security suite and the shipped guard
 * still fail closed on every private range.
 *
 * The feed path deliberately does NOT ask for the operator opt-in
 * (`allowLoopbackWithOptIn`): a loopback feed stays refused in production, and
 * `scripts/check-workspace-ui.mjs` asserts exactly that.
 */
export async function isBlockedFeedTarget(
  rawUrl: string,
  options: OutboundTargetOptions = {},
): Promise<boolean> {
  return isBlockedOutboundTarget(rawUrl, {
    ...options,
    // The feed path keeps its development-only exemption unless the caller
    // explicitly turns it off (the link-preview route does).
    allowLoopbackInDevelopment: options.allowLoopbackInDevelopment ?? true,
  });
}

export type FeedFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type FeedFetchOptions = {
  /** Injected by tests; defaults to the global `fetch` at call time. */
  fetchFn?: FeedFetchFn;
  /** Redirects followed before giving up (default 3). */
  maxRedirects?: number;
  /** Injected by tests; defaults to the system resolver at call time. */
  resolve?: HostResolver;
  /** Loopback exemption in `development` - see {@link OutboundTargetOptions}. */
  allowDevLoopback?: boolean;
};

/**
 * Serialize the request body the guard supports. Every outbound call in the
 * app sends a string (the webhook JSON) or no body (the feed and preview
 * GETs), so a stream/FormData body is refused rather than silently fetched
 * without pinning.
 */
function requestBody(body: RequestInit["body"]): string | Buffer | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Unsupported request body.");
}

/**
 * Fetch one URL with the DNS answer **pinned** to `address`.
 *
 * The normal `fetch` resolves the hostname itself, after the guard looked at
 * a different answer — the rebinding window. This request connects to the
 * address that was validated, while keeping the URL's hostname for the Host
 * header, TLS SNI and certificate verification. Redirects are never followed
 * here; `safeFetchGuarded` validates each hop.
 */
async function fetchPinnedAddress(
  rawUrl: string,
  init: RequestInit,
  address: string,
): Promise<Response> {
  const url = new URL(rawUrl);
  const headers = new Headers(init.headers);
  const body = requestBody(init.body);
  if (body !== null && !headers.has("content-length")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  const hostname = normalizeHost(url.hostname);
  const family = isIP(address) === 6 ? 6 : 4;
  const requestOptions: RequestOptions & { servername?: string } = {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    // This callback is the pin: net.connect asks for an address once and we
    // always answer with the one the guard validated. `all: true` asks for
    // the array form; both forms carry the same single answer.
    lookup: ((
      _host: string,
      lookupOptions: unknown,
      callback: (...args: never[]) => void,
    ) => {
      const wantsAll =
        typeof lookupOptions === "object" &&
        lookupOptions !== null &&
        (lookupOptions as { all?: boolean }).all === true;
      if (wantsAll) {
        (
          callback as unknown as (
            error: null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, [{ address, family }]);
        return;
      }
      (callback as unknown as (error: null, address: string, family: number) => void)(
        null,
        address,
        family,
      );
    }) as RequestOptions["lookup"],
  };
  if (url.protocol === "https:") requestOptions.servername = hostname;

  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(requestOptions, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          responseHeaders.append(name, entry);
        }
      }
      const response = new Response(
        Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage ?? "",
          headers: responseHeaders,
        },
      );
      // `Response` built from a stream has an empty `url`; the caller uses it
      // to resolve relative redirects and to re-check the final host.
      Object.defineProperty(response, "url", {
        value: url.toString(),
        configurable: true,
      });
      resolve(response);
    });
    request.on("error", reject);
    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy();
        reject(new Error("Aborted."));
        return;
      }
      init.signal.addEventListener("abort", () => request.destroy(), { once: true });
    }
    if (body !== null) request.write(body);
    request.end();
  });
}

/**
 * Guarded outbound fetch with DNS pinning. The target is resolved once, every
 * answer is validated by {@link resolveOutboundTarget}, and the connection is
 * made to that validated address. Throws on a blocked or unresolvable target;
 * callers that want the uniform "blocked / failed" result use
 * {@link safeFetchGuarded}.
 */
export async function fetchPinned(
  rawUrl: string,
  init: RequestInit = {},
  options: OutboundTargetOptions = {},
): Promise<Response> {
  const target = await resolveOutboundTarget(rawUrl, options);
  if (target.blocked) throw new Error("Blocked target.");
  return fetchPinnedTarget(rawUrl, init, target.address);
}

/**
 * Fetch a URL whose target address the caller has already validated.
 *
 * This is the second half of {@link fetchPinned}, exported so a caller that
 * must check every redirect hop or every delivery attempt does not repeat the
 * DNS lookup (which would reopen the rebinding window between the two
 * answers).
 */
export async function fetchPinnedTarget(
  rawUrl: string,
  init: RequestInit,
  address: string,
): Promise<Response> {
  // A replaced global transport is an offline test double (or an operator's
  // instrumentation). Honour it, but only after the caller let the target
  // through the guard; the shipped process keeps the native fetch and uses the
  // pinned connection below.
  if (globalThis.fetch !== nativeFetch) {
    return globalThis.fetch(rawUrl, init);
  }
  return fetchPinnedAddress(rawUrl, init, address);
}

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
  const maxRedirects = options.maxRedirects ?? 3;
  const resolve = options.resolve ?? defaultHostResolver;
  const targetOptions: OutboundTargetOptions = {
    resolve,
    allowLoopbackInDevelopment: options.allowDevLoopback ?? true,
  };
  const fetchFn: FeedFetchFn =
    options.fetchFn ??
    ((url, requestInit) => fetchPinned(url, requestInit, targetOptions));
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (await isBlockedFeedTarget(current, targetOptions)) {
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
        if (await isBlockedFeedTarget(finalUrl, targetOptions)) {
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
