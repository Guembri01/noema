import { z } from "zod";
import { validatePassword } from "@/lib/password-policy";

/**
 * Message surfaced when {@link validatePassword} rejects a signup password for
 * a reason the base string checks cannot express (composition, denylist). The
 * length bounds keep their own, more specific messages.
 */
const SIGNUP_PASSWORD_POLICY_MESSAGE =
  "Choose a stronger password: use an uppercase letter, a lowercase letter and a number, and avoid common passwords";

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(200, "Password must be at most 200 characters")
    // Delegate composition/denylist rules to the shared password policy so the
    // client meter, this schema and the change-password flow agree on what is
    // acceptable. `validatePassword` is pure and never throws.
    .refine((value) => validatePassword(value).ok, SIGNUP_PASSWORD_POLICY_MESSAGE),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  code: z.string().trim().optional(),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  icon: z.string().trim().max(8).optional(),
});

export const pageSchema = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(16).optional(),
  parentId: z.string().cuid().nullable().optional(),
});

/**
 * A page's block document. The editor serialises TipTap JSON to a string
 * before it reaches a Server Action — ProseMirror shares one `attrs` object
 * across nodes, and React's action encoder turns a shared object graph into a
 * temporary reference, which the server cannot store. Sending text avoids that
 * entirely and lets us validate and cap the payload here.
 */
export const MAX_PAGE_CONTENT_BYTES = 2_000_000;

export const pageContentSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.record(z.string(), z.unknown())).max(20_000),
});

/**
 * Schemes a stored/rendered `href` may declare (audit H2: stored XSS via
 * unvalidated `href`). `src/lib/markdown.ts` keeps the same list in its own
 * `safeHref` gate; both are pinned by tests in `validation.test.ts` /
 * `markdown.test.ts`.
 */
export const ALLOWED_HREF_SCHEMES = ["http", "https", "mailto", "tel"] as const;

/**
 * Scheme allowlist for any href-shaped value (link marks, bookmark/embed urls).
 *
 * Deny-by-default, mirroring WHATWG URL parsing first: control characters
 * (tab/LF/CR are stripped from inside a scheme by every browser) are removed
 * and the ends are trimmed, then only an allowlisted scheme, a same-document
 * target or a scheme-less relative path survives. Protocol-relative (`//host`,
 * `\\host`), encoded-colon (`javascript%3A...`) and malformed-scheme
 * (`&#106;avascript:...`) tricks are rejected outright.
 */
export function sanitizeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) return null;
  // Protocol-relative (and its backslash twin) inherits a scheme from context.
  if (/^[\\/]{2}/.test(value)) return null;
  // Anything that declares a scheme - before the first path/query/fragment
  // delimiter - must be syntactically valid and on the allowlist.
  const head = value.split(/[/#?]/, 1)[0];
  if (head.includes(":") || /%3a/i.test(head)) {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
    if (!scheme) return null;
    if (!(ALLOWED_HREF_SCHEMES as readonly string[]).includes(scheme[1].toLowerCase())) {
      return null;
    }
    return value;
  }
  if (/^[/?#]/.test(value)) return value; // same-document / absolute-path target
  // A colon (or encoded colon) we could not attribute to an allowlisted
  // scheme is an attempt to smuggle one - reject.
  if (value.includes(":") || /%3a/i.test(value)) return null;
  return value;
}

/**
 * The app's own asset path. A stored FILES value may only point at an
 * uploaded workspace asset, so the write path keeps every stored file URL
 * inside this prefix (`/api/files/<workspaceId>/<name>`).
 */
export const FILE_URL_PREFIX = "/api/files/";

/**
 * Validate a FILES entry URL on the write path.
 *
 * Only the app's own `/api/files/...` asset URLs are accepted: an absolute
 * `http(s)://` URL, a `javascript:` URL, a protocol-relative URL or a
 * traversal attempt is rejected. The URL is returned unchanged, or `null`
 * when it is not an app-owned asset path.
 */
export function sanitizeFileUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value.startsWith(FILE_URL_PREFIX)) return null;
  // Control characters and a traversal segment never belong in an asset path.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.includes("..")) return null;
  return value;
}

/**
 * True when every file URL a FILES value carries points at the app's own
 * uploaded asset. A value without a `files` array is not a FILES value and
 * is accepted unchanged; a FILES value with any other URL is not.
 */
export function fileUrlsAreAppOwned(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return true;
  return files.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return sanitizeFileUrl((entry as { url?: unknown }).url) !== null;
  });
}

const HREF_ATTR_KEYS = ["href", "url"] as const;

/**
 * Recursively drop unsafe href-shaped attribute values (audit H2). Only
 * `attrs.href` (link marks) and `attrs.url` (bookmark/embed nodes) are
 * touched - image `src`/`icon` deliberately keep `data:` URIs, which are inert
 * in `<img>`.
 */
function sanitizeHrefAttributes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) sanitizeHrefAttributes(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const attrs = record.attrs;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    const target = attrs as Record<string, unknown>;
    for (const key of HREF_ATTR_KEYS) {
      const value = target[key];
      if (typeof value === "string" && sanitizeHref(value) === null) delete target[key];
    }
  }
  if (Array.isArray(record.marks)) sanitizeHrefAttributes(record.marks);
  if (Array.isArray(record.content)) sanitizeHrefAttributes(record.content);
}

/** Parse and validate a page document sent as JSON text (or a plain object). */
export function parsePageContent(
  input: unknown,
): { ok: true; doc: unknown } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, doc: undefined };
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_PAGE_CONTENT_BYTES) {
      return { ok: false, error: "That page is too large to save (2 MB limit)." };
    }
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: "The page content could not be read." };
    }
  }
  const parsed = pageContentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "The page content is not valid." };
  sanitizeHrefAttributes(parsed.data.content);
  return { ok: true, doc: parsed.data };
}

export const commentSchema = z.object({
  pageId: z.string().cuid(),
  body: z.string().trim().min(1, "Comment cannot be empty").max(4000),
  parentId: z.string().cuid().nullable().optional(),
  blockId: z.string().max(200).optional(),
  quote: z.string().max(500).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
