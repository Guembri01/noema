/**
 * H1 — pure link classification.
 *
 * The editor, the renderer and the share/notification layers all receive
 * `href`-shaped strings from mixed sources (typed text, pasted HTML, imported
 * documents) and each needs the same three answers: *is this safe to render*,
 * *does it leave the app*, and *where does it point*. Those questions are
 * currently spread across ad-hoc regexes; this module is the single pure
 * kernel for them.
 *
 * It does five things, all pure and deterministic (no DB, no DOM, inputs are
 * never mutated):
 *  - {@link classifyLink} — one {@link LinkKind} per href.
 *  - {@link isExternalLink} — leaves the current origin (or a known workspace).
 *  - {@link isSafeScheme} — scheme allowlist, deny-by-default.
 *  - {@link normalizeLink} — canonical key, or `null` when unusable.
 *  - {@link isSameOrigin} — origin comparison that never throws.
 *
 * Classification is deliberately fail-closed: an unknown scheme, a
 * protocol-relative (`//host`, `\\host`) target, an encoded-colon
 * (`%3A`) scheme-smuggling attempt and any control-character-obscured scheme
 * are all reported as `"unsafe"` rather than guessed at, mirroring
 * `sanitizeHref` in `src/lib/validation.ts`.
 */

/** The classification of a link target. */
export type LinkKind =
  | "page"
  | "anchor"
  | "external"
  | "mailto"
  | "tel"
  | "unsafe"
  | "invalid";

/** Every {@link LinkKind}, in a stable order for tests and pickers. */
export const LINK_KINDS = [
  "page",
  "anchor",
  "external",
  "mailto",
  "tel",
  "unsafe",
  "invalid",
] as const;

/**
 * Schemes a link may declare. Mirrors `ALLOWED_HREF_SCHEMES` in
 * `src/lib/validation.ts`; anything else is `"unsafe"`.
 */
export const SAFE_LINK_SCHEMES = ["http", "https", "mailto", "tel"] as const;

/** Context that refines `"page"` vs `"external"`; both fields are optional. */
export type LinkContext = {
  /** The app's own origin, e.g. `https://app.noema.example`. */
  origin?: string;
  /** The current workspace slug; a `/w/<slug>/…` path stays internal on any host. */
  workspaceSlug?: string;
};

/** Scheme at the head of a value, or `null` when it is scheme-less. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Trim and strip control characters (tab/LF/CR and friends), which browsers
 * silently drop from inside a scheme. Returns `null` for non-strings and
 * empty/whitespace-only values.
 */
function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return value === "" ? null : value;
}

/**
 * True when a cleaned value cannot be handed to a renderer: protocol-relative
 * (`//host`, `\\host`) targets, an encoded colon hiding a scheme, or an
 * explicit scheme outside {@link SAFE_LINK_SCHEMES}.
 */
function isUnsafeValue(value: string): boolean {
  if (/^[\\/]{2}/.test(value)) return true;
  const head = value.split(/[/#?]/, 1)[0];
  if (/%3a/i.test(head)) return true;
  const scheme = SCHEME.exec(value);
  return (
    scheme !== null &&
    !(SAFE_LINK_SCHEMES as readonly string[]).includes(scheme[1].toLowerCase())
  );
}

/** True when a cleaned value is a parseable absolute `http(s)` URL. */
function isHttpUrl(value: string): boolean {
  if (!SCHEME.test(value)) return false;
  const scheme = SCHEME.exec(value)![1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** True when a cleaned value's path targets `/w/<workspaceSlug>`. */
function matchesWorkspace(value: string, workspaceSlug: string | undefined): boolean {
  if (!workspaceSlug) return false;
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value;
  }
  const segments = pathname.split("/").filter((part) => part !== "");
  return segments[0] === "w" && segments[1]?.toLowerCase() === workspaceSlug.toLowerCase();
}

/**
 * Whether two values share an origin. Scheme-less, protocol-relative and
 * unparseable inputs are never same-origin, and nothing here throws.
 */
export function isSameOrigin(url: unknown, origin: unknown): boolean {
  const target = clean(url);
  const base = clean(origin);
  if (target === null || base === null) return false;
  if (!ANY_SCHEME.test(target)) return false;
  try {
    const parsed = new URL(target).origin;
    return parsed !== "null" && parsed === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Whether a value declares an allowed scheme (or no scheme at all). Relative
 * paths, same-document anchors and `http`/`https`/`mailto`/`tel` are safe;
 * `javascript:`, `data:`, `vbscript:`, unknown schemes and protocol-relative
 * targets are not. Non-strings and blanks are unsafe by default.
 */
export function isSafeScheme(raw: unknown): boolean {
  const value = clean(raw);
  if (value === null) return false;
  return !isUnsafeValue(value);
}

/**
 * Classify a link target into a single {@link LinkKind}:
 *
 * - `"invalid"` — non-string, blank, or an unparseable `http(s)` URL.
 * - `"unsafe"`  — dangerous/unknown scheme, protocol-relative, or `%3A` smuggle.
 * - `"anchor"`  — a same-document `#fragment`.
 * - `"mailto"` / `"tel"` — the corresponding scheme.
 * - `"page"`    — same-origin absolute, a `/w/<workspaceSlug>` path on any
 *   host, or any scheme-less relative path.
 * - `"external"`— an `http(s)` link that is neither same-origin nor the given
 *   workspace.
 */
export function classifyLink(raw: unknown, context: LinkContext = {}): LinkKind {
  const value = clean(raw);
  if (value === null) return "invalid";
  if (isUnsafeValue(value)) return "unsafe";
  if (value.startsWith("#")) return "anchor";

  const scheme = SCHEME.exec(value);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === "mailto") return "mailto";
    if (name === "tel") return "tel";
    if (!isHttpUrl(value)) return "invalid";
    return isSameOrigin(value, context.origin) ||
      matchesWorkspace(value, context.workspaceSlug)
      ? "page"
      : "external";
  }

  // No scheme: an absolute path or a bare relative reference — both internal.
  return "page";
}

/** True when a link leaves the current origin (or the given workspace). */
export function isExternalLink(raw: unknown, context: LinkContext = {}): boolean {
  return classifyLink(raw, context) === "external";
}

/**
 * Canonical key for a link, or `null` when it is `"invalid"` or `"unsafe"`.
 *
 * - `mailto:`/`tel:` are lower-cased and trimmed.
 * - External `http(s)` links are canonicalised through the URL parser.
 * - Same-origin page links drop the origin, leaving `/path?query#hash` so
 *   links to the same page dedupe regardless of host.
 * - Anchors and relative paths are returned trimmed and otherwise untouched.
 */
export function normalizeLink(
  raw: unknown,
  context: LinkContext = {},
): string | null {
  const value = clean(raw);
  if (value === null) return null;
  const kind = classifyLink(value, context);
  if (kind === "invalid" || kind === "unsafe") return null;
  if (kind === "anchor") return value;
  if (kind === "mailto") return `mailto:${value.slice("mailto:".length).trim()}`;
  if (kind === "tel") return `tel:${value.slice("tel:".length).trim()}`;

  try {
    const parsed = new URL(value);
    return kind === "external"
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // Relative (scheme-less) page link: the cleaned value is already canonical.
    return value;
  }
}
