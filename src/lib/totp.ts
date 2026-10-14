import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 4648 base32 (no padding) and RFC 6238 TOTP with SHA-1.
 * Pure apart from `node:crypto`, so it is fully unit-testable with fixed time.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226). */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/** TOTP (RFC 6238). */
export function totp(
  secretBase32: string,
  timeMs: number = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** Verify a code within ±window steps, using a constant-time comparison. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs: number = Date.now(),
  window = 1,
  stepSeconds = 30,
): boolean {
  const candidate = code.replace(/\s+/g, "");
  if (!/^\d{6,8}$/.test(candidate)) return false;
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(base32Decode(secretBase32), counter + offset, candidate.length);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps (rendered as text/QR by the client). */
export function otpauthUrl(
  secret: string,
  account: string,
  issuer = "Noema",
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
