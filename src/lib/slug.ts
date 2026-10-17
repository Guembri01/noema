import { randomToken as createToken } from "@/lib/random";

/** URL-safe slug derived from arbitrary text. */
export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

/**
 * Cryptographically random URL-safe token, used for share links and invites.
 *
 * Delegates to `@/lib/random` (Web Crypto) rather than `node:crypto`: this module
 * is imported by client components (`csv-mapping`, `slug-uniqueness`), and a
 * `node:` import there fails the production build.
 */
export function randomToken(bytes = 24): string {
  return createToken(bytes);
}

/** FNV-1a hash producing a short deterministic key (for formulas/cache keys). */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function formatDate(value: Date | string, locale = "en-US"): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
