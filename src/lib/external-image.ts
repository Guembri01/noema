/**
 * B69 - the external-image gate: which hosts a document may point its pictures
 * at, and how a picture that lives on another host is fetched.
 *
 * The read-only renderer used to emit the stored `src` verbatim, so a picture
 * on ANY host was fetched BY THE VISITOR'S BROWSER when they opened a shared
 * page. That request handed the host the visitor's IP address - and the
 * `Referer` of the share page, which tells the host which Noema instance the
 * visitor came from (and, for a same-origin picture, the whole URL with the
 * share token in it).
 *
 * Every external picture now points at this app's own proxy route
 * ({@link externalImageProxyPath}), so the third party never sees the visitor:
 * the server fetches the bytes and the browser asks the server.
 *
 * The proxy is NOT an open relay:
 *
 * - only the hosts on the allowlist may be fetched at all
 *   ({@link externalImageHosts}); everything else is refused by name;
 * - the fetch itself runs through the shared SSRF guard
 *   (`src/lib/feed-guard.ts`), which refuses loopback, private and cloud
 *   metadata addresses and pins the DNS answer it validated;
 * - redirects are never followed, so a permitted host cannot bounce the
 *   request to an internal one.
 *
 * The default list is the image host the app already trusts for cover photos
 * (`ALLOWED_UNSPLASH_HOSTS`); an operator adds hosts with
 * {@link EXTERNAL_IMAGE_ALLOWLIST_ENV}.
 *
 * Pure module: no DOM, no network, no clock. The route that serves the bytes
 * is `src/app/api/external-image/route.ts`.
 */
import { ALLOWED_UNSPLASH_HOSTS } from "@/lib/page-cover";

/** Operator opt-in: extra hosts the proxy may fetch (comma/space separated). */
export const EXTERNAL_IMAGE_ALLOWLIST_ENV = "EXTERNAL_IMAGE_ALLOWLIST";

/** The route that serves a proxied external picture. */
export const EXTERNAL_IMAGE_ROUTE = "/api/external-image";

/**
 * The hosts the proxy fetches without any configuration: the image CDN the
 * app already trusts for cover photos. Small and explicit on purpose - every
 * host on this list sees the SERVER's address, never a visitor's.
 */
export const DEFAULT_EXTERNAL_IMAGE_HOSTS: readonly string[] = ALLOWED_UNSPLASH_HOSTS;

/**
 * Parse the operator's allowlist. Entries are hostnames, optionally written as
 * a full URL; anything that cannot be read as a host is dropped. Case and a
 * trailing root dot are irrelevant for the comparison.
 */
export function parseExternalImageHosts(raw: string | undefined | null): string[] {
  if (typeof raw !== "string") return [];
  const hosts: string[] = [];
  for (const entry of raw.split(/[\s,]+/)) {
    const value = entry.trim().toLowerCase();
    if (!value) continue;
    let host = value;
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
      try {
        host = new URL(value).hostname.toLowerCase();
      } catch {
        continue;
      }
    }
    if (!host) continue;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** The hosts the proxy may fetch: the defaults plus the operator's list. */
export function externalImageHosts(): string[] {
  const hosts = [...DEFAULT_EXTERNAL_IMAGE_HOSTS];
  for (const host of parseExternalImageHosts(process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV])) {
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** Normalise a hostname for the allowlist comparison. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Whether a host may be fetched by the proxy. The match is EXACT: a listed
 * host does not lend its name to its subdomains, and no wildcard exists - the
 * list stays small and explicit.
 */
export function isAllowedExternalImageHost(
  host: string,
  hosts: readonly string[] = externalImageHosts(),
): boolean {
  const value = normalizeHost(host);
  if (!value) return false;
  return hosts.some((entry) => normalizeHost(entry) === value);
}

/** The same-origin path the renderer points an external picture at. */
export function externalImageProxyPath(url: string): string {
  return `${EXTERNAL_IMAGE_ROUTE}?url=${encodeURIComponent(url)}`;
}

/** Schemes that never leave the page: they carry no third party. */
const LOCAL_SCHEMES = new Set(["data", "blob"]);

/**
 * The renderer-facing rewrite of a stored picture reference:
 *
 * - an absolute `http(s)` URL becomes the proxy path - the picture is fetched
 *   by the server, so the visitor's browser never contacts the host;
 * - a protocol-relative URL (`//host/x`, the browser resolves it against the
 *   page's scheme) is external too and is rewritten the same way;
 * - a relative path (an upload: `/api/files/<workspace>/<name>`), a `data:` or
 *   a `blob:` URL is left alone - it never leaves the page;
 * - anything else (a `javascript:` URL, a `file:` URL, an unknown scheme) is
 *   dropped, so no picture reference survives the rewrite.
 */
export function externalImageSrc(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  // Protocol-relative (and its backslash twin): the browser inherits a scheme
  // from the page, so it points at another host.
  if (/^[\\/]{2}/.test(raw)) {
    const absolute = `https:${raw.replace(/^\\{2}/, "//").replace(/\\/g, "/")}`;
    try {
      return externalImageProxyPath(new URL(absolute).href);
    } catch {
      return "";
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!scheme) return raw; // a relative path: same origin, nothing to proxy
  const protocol = scheme[1].toLowerCase();
  if (LOCAL_SCHEMES.has(protocol)) return raw;
  if (protocol !== "http" && protocol !== "https") return "";
  try {
    return externalImageProxyPath(new URL(raw).href);
  } catch {
    return "";
  }
}
