import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for stored provider keys (AES-256-GCM).
 *
 * The key is derived from AUTH_SECRET, so a database dump alone is not enough
 * to read a stored API key. Ciphertext is versioned (`v1:iv:tag:payload`) so the
 * scheme can be rotated later. Secrets are never sent back to the client — the
 * UI only ever sees a masked form.
 */

function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret) {
    throw new Error("AUTH_SECRET is required to store provider keys.");
  }
  // Fixed, domain-separated salt: the secret is the entropy source.
  return createHash("sha256").update(`noema:ai-provider:v1:${secret}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${payload.toString("base64")}`;
}

export function decryptSecret(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  const [version, iv, tag, payload] = envelope.split(":");
  if (version !== "v1" || !iv || !tag || !payload) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Show only the shape of a stored key: `sk-ab…9f2c`. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

/** SHA-256 hex digest, used for single-use invite tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(`noema:token:${token}`).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
