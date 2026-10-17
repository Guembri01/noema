/**
 * Isomorphic randomness.
 *
 * These helpers exist because `node:crypto` **cannot** be bundled into a client
 * component: webpack rejects the `node:` scheme outright, which is what broke
 * `next build` (Turbopack tolerated it in dev, the production build did not).
 * Everything here goes through the Web Crypto API instead, which is available in
 * every browser *and* in Node 18+ — so a module can be shared by a server action
 * and a client component without dragging a Node built-in along.
 *
 * Security: `crypto.getRandomValues` is a CSPRNG, and `randomInt` rejects
 * out-of-range draws (modulo bias would make short codes slightly guessable).
 */

/** The platform CSPRNG. Throws a clear error rather than silently weakening. */
function cryptoApi(): Crypto {
  const api = globalThis.crypto;
  if (!api || typeof api.getRandomValues !== "function") {
    throw new Error(
      "No CSPRNG available: this runtime lacks globalThis.crypto (Node 18+ or any browser required).",
    );
  }
  return api;
}

/** `length` cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`randomBytes: length must be a non-negative integer, got ${length}`);
  }
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

/**
 * A uniformly random integer in `[0, maxExclusive)`.
 *
 * Uses rejection sampling: taking `random % max` would favour the low values
 * whenever `max` does not divide 2^32, and for short codes that bias is a
 * (small) enumeration advantage.
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`randomInt: max must be a positive integer, got ${maxExclusive}`);
  }
  if (maxExclusive === 1) return 0;
  const ceiling = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  let draw = 0;
  do {
    cryptoApi().getRandomValues(buffer);
    draw = buffer[0];
  } while (draw >= ceiling);
  return draw % maxExclusive;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 base64url (no padding) — the encoding `Buffer.toString("base64url")` gives. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const a = bytes[index];
    const b = remaining > 1 ? bytes[index + 1] : 0;
    const c = remaining > 2 ? bytes[index + 2] : 0;
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 0x03) << 4) | (b >> 4)];
    if (remaining > 1) out += BASE64URL[((b & 0x0f) << 2) | (c >> 6)];
    if (remaining > 2) out += BASE64URL[c & 0x3f];
  }
  return out;
}

/** A URL-safe secret token (`bytes` bytes of entropy, base64url encoded). */
export function randomToken(bytes = 24): string {
  return toBase64Url(randomBytes(bytes));
}
