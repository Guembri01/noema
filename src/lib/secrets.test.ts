import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_KEY_AGE_SECONDS,
  MIN_SECRET_LENGTH,
  SECRET_REGISTRY,
  SecretDecryptError,
  constantTimeEqual,
  createKeyring,
  createShareUnlockToken,
  decrypt,
  decryptSecret,
  deriveLegacyKey,
  describeSecretStatus,
  encrypt,
  encryptSecret,
  encryptTwoFactorSecret,
  generateSecret,
  hashToken,
  maskConnString,
  maskSecret,
  missingSecrets,
  needsRotation,
  openTwoFactorSecret,
  parseEnvSecret,
  randomToken,
  redact,
  redactObject,
  reencrypt,
  rotateKeyring,
  shareUnlockCookieName,
  verifyShareUnlockToken,
} from "@/lib/secrets";
import type { Keyring, SecretDecryptErrorCode } from "@/lib/secrets";

/**
 * B85 — envelope tests for `src/lib/secrets.ts` (READ-ONLY module).
 *
 * The module derives its AES-256-GCM key from `AUTH_SECRET`, so every test
 * pins the env var itself and restores the outer value in `afterEach` — the
 * ambient process env (loaded `.env`, CI) must not influence assertions.
 */

const SECRET_A = "b85-test-secret-a-0123456789abcdef";
const SECRET_B = "b85-test-secret-b-0123456789abcdef";
const PLAINTEXT = "sk-ant-api03-DEADBEEFcafe:with+colons/slash=equals🚀";
const MARKER = "DEADBEEFcafe";

const hadAuthSecret = Object.prototype.hasOwnProperty.call(
  process.env,
  "AUTH_SECRET",
);
const originalAuthSecret = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET_A;
});

afterEach(() => {
  if (hadAuthSecret && originalAuthSecret !== undefined) {
    process.env.AUTH_SECRET = originalAuthSecret;
  } else {
    delete process.env.AUTH_SECRET;
  }
});

/** Flip the low bit of segment 1=iv, 2=tag, 3=payload (v1) / 2=iv, 3=tag, 4=payload (v2). */
function tamper(envelope: string, segment: 1 | 2 | 3 | 4): string {
  const parts = envelope.split(":");
  const buf = Buffer.from(parts[segment], "base64");
  expect(buf.length).toBeGreaterThan(0);
  buf[0] ^= 0x01;
  parts[segment] = buf.toString("base64");
  return parts.join(":");
}

describe("secrets envelope — AES-256-GCM round-trip", () => {
  it("round-trips a realistic provider key", () => {
    const envelope = encryptSecret(PLAINTEXT);
    expect(decryptSecret(envelope)).toBe(PLAINTEXT);
  });

  it("round-trips plaintext containing ':' and base64-hostile characters", () => {
    // The envelope is colon-delimited, so ':' in the plaintext must not
    // break parsing (base64 segments can never contain ':').
    const tricky = "a:b:c+d/e=f==\n\t ünïcødé 🚀";
    expect(decryptSecret(encryptSecret(tricky))).toBe(tricky);
  });

  it("emits `v1:<iv>:<tag>:<payload>` with a 12-byte IV and 16-byte tag", () => {
    const envelope = encryptSecret(PLAINTEXT);
    const parts = envelope.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12); // GCM nonce
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16); // auth tag
    const ciphertext = Buffer.from(parts[3], "base64");
    expect(ciphertext).toHaveLength(Buffer.byteLength(PLAINTEXT, "utf8"));
    expect(ciphertext.toString("utf8")).not.toBe(PLAINTEXT);
  });

  it("uses a fresh random IV per call (ciphertexts differ, both decrypt)", () => {
    const one = encryptSecret(PLAINTEXT);
    const two = encryptSecret(PLAINTEXT);
    expect(one).not.toBe(two);
    expect(decryptSecret(one)).toBe(PLAINTEXT);
    expect(decryptSecret(two)).toBe(PLAINTEXT);
  });

  it("does not leak the plaintext into the envelope", () => {
    const envelope = encryptSecret(PLAINTEXT);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(envelope).not.toContain(MARKER);
  });
});

describe("secrets envelope — wrong AUTH_SECRET fails", () => {
  it("returns null when the envelope was sealed with another secret", () => {
    const envelope = encryptSecret(PLAINTEXT);
    process.env.AUTH_SECRET = SECRET_B;
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("still decrypts after restoring the original secret (null = key mismatch)", () => {
    const envelope = encryptSecret(PLAINTEXT);
    process.env.AUTH_SECRET = SECRET_B;
    expect(decryptSecret(envelope)).toBeNull();
    process.env.AUTH_SECRET = SECRET_A;
    expect(decryptSecret(envelope)).toBe(PLAINTEXT);
  });
});

describe("secrets envelope — tampering is detected", () => {
  it("rejects a flipped bit in the payload (ciphertext)", () => {
    const envelope = encryptSecret(PLAINTEXT);
    expect(decryptSecret(tamper(envelope, 3))).toBeNull();
  });

  it("rejects a flipped bit in the auth tag", () => {
    const envelope = encryptSecret(PLAINTEXT);
    expect(decryptSecret(tamper(envelope, 2))).toBeNull();
  });

  it("rejects a flipped bit in the IV", () => {
    const envelope = encryptSecret(PLAINTEXT);
    expect(decryptSecret(tamper(envelope, 1))).toBeNull();
  });

  it("rejects a payload spliced in from another envelope", () => {
    const first = encryptSecret(PLAINTEXT).split(":");
    const second = encryptSecret("totally different secret value").split(":");
    const spliced = [first[0], first[1], first[2], second[3]].join(":");
    expect(decryptSecret(spliced)).toBeNull();
  });
});

describe("secrets envelope — version prefix handling", () => {
  const valid = () => encryptSecret(PLAINTEXT);

  it("accepts the exact `v1:` prefix (positive control)", () => {
    expect(decryptSecret(valid())).toBe(PLAINTEXT);
  });

  it("rejects a `v2:` envelope (unknown future version)", () => {
    const parts = valid().split(":");
    expect(decryptSecret(["v2", ...parts.slice(1)].join(":"))).toBeNull();
  });

  it("rejects an envelope with missing or empty segments", () => {
    expect(decryptSecret("v1")).toBeNull();
    expect(decryptSecret("v1:only-two")).toBeNull();
    expect(decryptSecret("v1:::")).toBeNull();
    const parts = valid().split(":");
    expect(decryptSecret([parts[0], parts[1], parts[2]].join(":"))).toBeNull(); // no payload
    expect(decryptSecret([parts[0], "", parts[2], parts[3]].join(":"))).toBeNull(); // no iv
  });

  it("rejects an envelope without the version prefix", () => {
    const parts = valid().split(":");
    expect(decryptSecret(parts.slice(1).join(":"))).toBeNull();
    expect(decryptSecret("not-an-envelope")).toBeNull();
  });
});

describe("secrets envelope — errors never leak plaintext", () => {
  it("throws the documented AUTH_SECRET error without the plaintext", () => {
    delete process.env.AUTH_SECRET;
    let caught: unknown;
    try {
      encryptSecret(PLAINTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).not.toContain(MARKER);
    expect(message).not.toContain(PLAINTEXT);
  });

  it("decryptSecret never throws on malformed input, it returns null", () => {
    const inputs: Array<string | null | undefined> = [
      null,
      undefined,
      "",
      "v1",
      "v1:::",
      "v1:a:b",
      "garbage",
      "::::",
      "\u0000\u0001\u0002",
      `v1:${"!".repeat(16)}:${"!".repeat(16)}:${"!".repeat(16)}`,
    ];
    for (const input of inputs) {
      expect(() => decryptSecret(input)).not.toThrow();
      expect(decryptSecret(input)).toBeNull();
    }
  });
});

describe("secrets envelope — empty / missing AUTH_SECRET", () => {
  it("throws when AUTH_SECRET is not set", () => {
    delete process.env.AUTH_SECRET;
    expect(() => encryptSecret(PLAINTEXT)).toThrow(/AUTH_SECRET is required/);
  });

  it("throws when AUTH_SECRET is an empty string", () => {
    process.env.AUTH_SECRET = "";
    expect(() => encryptSecret(PLAINTEXT)).toThrow(/AUTH_SECRET is required/);
  });

  it("decrypts to null (no throw) when AUTH_SECRET disappeared after sealing", () => {
    const envelope = encryptSecret(PLAINTEXT);
    delete process.env.AUTH_SECRET;
    expect(() => decryptSecret(envelope)).not.toThrow();
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("decrypts to null when AUTH_SECRET is empty but the envelope is well-formed", () => {
    const envelope = encryptSecret(PLAINTEXT);
    process.env.AUTH_SECRET = "";
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("CHARACTERIZATION: encrypting an empty string yields an envelope that decodes to null", () => {
    // Known asymmetry (reported in B85, not fixed — secrets.ts is read-only):
    // encryptSecret("") succeeds, but the empty payload is rejected by
    // decryptSecret's `!payload` guard, so the round-trip returns null.
    const envelope = encryptSecret("");
    expect(envelope).toMatch(/^v1:[^:]+:[^:]+:$/);
    expect(decryptSecret(envelope)).toBeNull();
  });
});

/**
 * B05 — the 2FA seed is sealed at rest (`encryptTwoFactorSecret` /
 * `openTwoFactorSecret`).
 *
 * The seed is a bearer credential: whoever holds it can mint valid codes. The
 * stored value must therefore be an envelope, never the raw base32 seed, while
 * rows written before the fix (a raw seed) keep working.
 */
describe("two-factor secret — sealed at rest", () => {
  const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

  it("seals a seed into an envelope that never contains the raw seed", () => {
    const sealed = encryptTwoFactorSecret(SEED);
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(sealed).not.toContain(SEED);
  });

  it("opens a sealed seed back to the raw seed", () => {
    expect(openTwoFactorSecret(encryptTwoFactorSecret(SEED))).toEqual({
      kind: "sealed",
      secret: SEED,
    });
  });

  it("uses a fresh IV per seal (the same seed seals to different envelopes)", () => {
    const first = encryptTwoFactorSecret(SEED);
    const second = encryptTwoFactorSecret(SEED);
    expect(first).not.toBe(second);
    expect(openTwoFactorSecret(first).secret).toBe(SEED);
    expect(openTwoFactorSecret(second).secret).toBe(SEED);
  });

  it("treats a pre-B05 cleartext seed as legacy instead of locking the user out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(openTwoFactorSecret(SEED)).toEqual({
      kind: "legacy",
      secret: SEED,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails closed on a corrupt envelope (no seed, no code can match)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sealed = encryptTwoFactorSecret(SEED);
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(openTwoFactorSecret(parts.join(":"))).toEqual({
      kind: "unreadable",
      secret: null,
    });
    warn.mockRestore();
  });

  it("fails closed on an envelope sealed with another AUTH_SECRET", () => {
    const sealed = encryptTwoFactorSecret(SEED);
    process.env.AUTH_SECRET = SECRET_B;
    expect(openTwoFactorSecret(sealed)).toEqual({
      kind: "unreadable",
      secret: null,
    });
  });

  it("fails closed on a missing value", () => {
    expect(openTwoFactorSecret(null)).toEqual({
      kind: "unreadable",
      secret: null,
    });
    expect(openTwoFactorSecret(undefined)).toEqual({
      kind: "unreadable",
      secret: null,
    });
    expect(openTwoFactorSecret("")).toEqual({
      kind: "unreadable",
      secret: null,
    });
  });

  it("fails closed (and never throws) when AUTH_SECRET is missing", () => {
    const sealed = encryptTwoFactorSecret(SEED);
    delete process.env.AUTH_SECRET;
    // The key cannot be derived, so the envelope cannot be opened — the seed
    // stays unreachable instead of leaking through an exception.
    expect(() => openTwoFactorSecret(sealed)).not.toThrow();
    expect(openTwoFactorSecret(sealed)).toEqual({
      kind: "unreadable",
      secret: null,
    });
  });
});

describe("maskSecret", () => {
  it("returns null for null, undefined and empty input", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("")).toBeNull();
  });

  it("fully masks short values", () => {
    expect(maskSecret("12345678")).toBe("••••");
    expect(maskSecret("short")).toBe("••••");
  });

  it("shows only first 5 and last 4 characters of long values", () => {
    expect(maskSecret("sk-ant-api03-DEADBEEFcafe")).toBe("sk-an…cafe");
    const masked = maskSecret("abcdefghijklmnopqrstuvwxyz");
    expect(masked).toBe("abcde…wxyz");
    expect(masked).not.toContain("fghijklmnopqrstu");
  });
});

describe("hashToken", () => {
  it("is a deterministic 64-char hex digest", () => {
    expect(hashToken("invite-42")).toBe(hashToken("invite-42"));
    expect(hashToken("invite-42")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is domain-separated: not the plain SHA-256 of the token", () => {
    const plain = createHash("sha256").update("invite-42").digest("hex");
    expect(hashToken("invite-42")).not.toBe(plain);
  });

  it("separates distinct tokens and never embeds the token", () => {
    expect(hashToken("invite-42")).not.toBe(hashToken("invite-43"));
    expect(hashToken("invite-42")).not.toContain("invite-42");
  });
});

describe("randomToken", () => {
  it("defaults to 24 random bytes as unpadded base64url", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("honors a custom byte count", () => {
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken(48)).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it("produces unique tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
  });
});

/**
 * S17 — versioned keyring & key rotation (docs/MISSING_FEATURES.md §17).
 *
 * The keyring API is additive to the legacy `v1:` envelope: ciphertexts are
 * pinned to a key version (`v2:<version>:<iv>:<tag>:<payload>`) so payloads
 * sealed under older keys keep decrypting after `rotateKeyring`. All key
 * material below is generated ephemerally with node:crypto — no `.env` value
 * is ever hardcoded in a test.
 */

function ephemeralKey(): Buffer {
  return randomBytes(32);
}

/** Assert `decrypt` fails closed with the typed error `code` (and leaks nothing). */
function expectDecryptFailure(
  payload: string,
  keyring: Keyring,
  code: SecretDecryptErrorCode,
): void {
  let caught: unknown;
  try {
    decrypt(payload, keyring);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SecretDecryptError);
  const typed = caught as SecretDecryptError;
  expect(typed.code).toBe(code);
  expect(typed.message).not.toContain(PLAINTEXT);
  expect(typed.message).not.toContain(MARKER);
}

describe("keyring envelope — round-trip under the active version", () => {
  it("round-trips a realistic provider key under the active version", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    expect(decrypt(encrypt(PLAINTEXT, keyring), keyring)).toBe(PLAINTEXT);
  });

  it("emits `v2:<version>:<iv>:<tag>:<payload>` pinned to the active version", () => {
    const keyring = createKeyring(
      { "1": ephemeralKey(), "2": ephemeralKey() },
      "2",
    );
    const parts = encrypt(PLAINTEXT, keyring).split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe("2"); // embedded key version = active version
    expect(Buffer.from(parts[2], "base64")).toHaveLength(12); // GCM nonce
    expect(Buffer.from(parts[3], "base64")).toHaveLength(16); // auth tag
    const ciphertext = Buffer.from(parts[4], "base64");
    expect(ciphertext).toHaveLength(Buffer.byteLength(PLAINTEXT, "utf8"));
    expect(ciphertext.toString("utf8")).not.toBe(PLAINTEXT);
  });

  it("uses a fresh random IV per call (ciphertexts differ, both decrypt)", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    const one = encrypt(PLAINTEXT, keyring);
    const two = encrypt(PLAINTEXT, keyring);
    expect(one).not.toBe(two);
    expect(decrypt(one, keyring)).toBe(PLAINTEXT);
    expect(decrypt(two, keyring)).toBe(PLAINTEXT);
  });

  it("round-trips tricky plaintext, including the empty string", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    const tricky = "a:b:c+d/e=f==\n\t ünïcødé 🚀";
    expect(decrypt(encrypt(tricky, keyring), keyring)).toBe(tricky);
    expect(decrypt(encrypt("", keyring), keyring)).toBe("");
  });

  it("does not leak the plaintext into the envelope", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    const envelope = encrypt(PLAINTEXT, keyring);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(envelope).not.toContain(MARKER);
  });
});

describe("keyring rotation — old ciphertexts stay decryptable", () => {
  it("rotateKeyring retains prior keys, promotes the new key, copies the keyring", () => {
    const k1 = ephemeralKey();
    const k2 = ephemeralKey();
    const original = createKeyring({ "1": k1 }, "1", 1_700_000_000);
    const rotated = rotateKeyring(original, k2, { now: 1_700_000_500 });
    expect(rotated.activeVersion).toBe("2");
    expect(rotated.activeSince).toBe(1_700_000_500);
    expect(rotated.keys.size).toBe(2);
    expect(rotated.keys.get("1")).toEqual(k1);
    expect(rotated.keys.get("2")).toEqual(k2);
    // The original keyring is untouched.
    expect(original.activeVersion).toBe("1");
    expect(original.keys.size).toBe(1);
  });

  it("decrypts payloads pinned to OLDER versions after further rotations", () => {
    const v1ring = createKeyring({ "1": ephemeralKey() }, "1");
    const oldPayload = encrypt(PLAINTEXT, v1ring);
    const v2ring = rotateKeyring(v1ring, ephemeralKey());
    const v2Payload = encrypt(PLAINTEXT, v2ring);
    const v3ring = rotateKeyring(v2ring, ephemeralKey());
    expect(oldPayload.startsWith("v2:1:")).toBe(true);
    expect(v2Payload.startsWith("v2:2:")).toBe(true);
    expect(v3ring.activeVersion).toBe("3");
    expect(decrypt(oldPayload, v3ring)).toBe(PLAINTEXT);
    expect(decrypt(v2Payload, v3ring)).toBe(PLAINTEXT);
  });

  it("increments numeric versions by default and honors an explicit version", () => {
    const keyring = createKeyring(
      { "1": ephemeralKey(), "10": ephemeralKey() },
      "10",
    );
    expect(rotateKeyring(keyring, ephemeralKey()).activeVersion).toBe("11");
    const canary = rotateKeyring(keyring, ephemeralKey(), {
      version: "canary",
    });
    expect(canary.activeVersion).toBe("canary");
    expect(canary.keys.size).toBe(3);
  });

  it("refuses to overwrite an existing version or infer past non-numeric versions", () => {
    const numeric = createKeyring({ "1": ephemeralKey() }, "1");
    expect(() =>
      rotateKeyring(numeric, ephemeralKey(), { version: "1" }),
    ).toThrow(/already exists/);
    const mixed = createKeyring(
      { "1": ephemeralKey(), canary: ephemeralKey() },
      "canary",
    );
    expect(() => rotateKeyring(mixed, ephemeralKey())).toThrow(
      /Cannot infer/,
    );
  });

  it("needsRotation is false within the max age and true past it", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1", 1_000_000);
    expect(needsRotation(keyring, 3_600, 1_000_000)).toBe(false);
    expect(needsRotation(keyring, 3_600, 1_003_599)).toBe(false);
    expect(needsRotation(keyring, 3_600, 1_003_601)).toBe(true);
  });

  it("needsRotation defaults to the 90-day policy and resets after rotation", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1", 1_000_000);
    expect(
      needsRotation(keyring, undefined, 1_000_000 + DEFAULT_MAX_KEY_AGE_SECONDS),
    ).toBe(false);
    expect(
      needsRotation(keyring, undefined, 1_000_001 + DEFAULT_MAX_KEY_AGE_SECONDS),
    ).toBe(true);
    const rotated = rotateKeyring(keyring, ephemeralKey(), { now: 2_000_000 });
    expect(needsRotation(rotated, undefined, 2_000_001)).toBe(false);
    expect(
      needsRotation(rotated, undefined, 2_000_001 + DEFAULT_MAX_KEY_AGE_SECONDS),
    ).toBe(true);
  });
});

describe("keyring envelope — tampering and unknown versions fail closed", () => {
  const ring = () =>
    createKeyring({ "1": ephemeralKey(), "2": ephemeralKey() }, "2");

  it("rejects a flipped bit in the payload, tag, or IV with a typed auth error", () => {
    const keyring = ring();
    const envelope = encrypt(PLAINTEXT, keyring);
    expectDecryptFailure(tamper(envelope, 4), keyring, "auth-failed"); // payload
    expectDecryptFailure(tamper(envelope, 3), keyring, "auth-failed"); // tag
    expectDecryptFailure(tamper(envelope, 2), keyring, "auth-failed"); // iv
  });

  it("rejects a payload spliced in from another envelope", () => {
    const keyring = ring();
    const first = encrypt(PLAINTEXT, keyring).split(":");
    const second = encrypt("totally different secret value", keyring).split(":");
    expectDecryptFailure(
      [first[0], first[1], first[2], first[3], second[4]].join(":"),
      keyring,
      "auth-failed",
    );
  });

  it("fails closed when the embedded version is absent from the keyring", () => {
    const sealed = encrypt(PLAINTEXT, createKeyring({ "7": ephemeralKey() }, "7"));
    const otherRing = createKeyring({ "1": ephemeralKey() }, "1");
    expectDecryptFailure(sealed, otherRing, "unknown-version");
  });

  it("fails closed when the embedded version segment is missing or empty", () => {
    expectDecryptFailure("v2::::", ring(), "unknown-version");
    expectDecryptFailure("v2:2:only-two", ring(), "malformed");
  });

  it("fails closed on malformed envelopes (wrong scheme, truncated shape, short IV)", () => {
    const keyring = ring();
    expectDecryptFailure("not-an-envelope", keyring, "malformed");
    expectDecryptFailure("v3:2:a:b:c", keyring, "malformed");
    const parts = encrypt(PLAINTEXT, keyring).split(":");
    // "abcd" decodes to 3 bytes — not a 12-byte GCM nonce.
    expectDecryptFailure(
      [parts[0], parts[1], "abcd", parts[3], parts[4]].join(":"),
      keyring,
      "malformed",
    );
  });

  it("fails closed when the same version is sealed under a different key", () => {
    const sealed = encrypt(PLAINTEXT, createKeyring({ "2": ephemeralKey() }, "2"));
    const impostor = createKeyring({ "2": ephemeralKey() }, "2");
    expectDecryptFailure(sealed, impostor, "auth-failed");
  });
});

describe("createKeyring — key material and version validation", () => {
  it("rejects a key that is not exactly 32 bytes", () => {
    expect(() => createKeyring({ "1": randomBytes(16) }, "1")).toThrow(
      /32 bytes/,
    );
    expect(() => createKeyring({ "1": randomBytes(31) }, "1")).toThrow(
      /32 bytes/,
    );
    expect(() => createKeyring({ "1": randomBytes(33) }, "1")).toThrow(
      /32 bytes/,
    );
  });

  it("rejects an empty keyring and an unknown activeVersion", () => {
    expect(() => createKeyring({}, "1")).toThrow(/at least one key/);
    expect(() =>
      createKeyring({ "1": ephemeralKey() }, "2"),
    ).toThrow(/no key/);
  });

  it("rejects versions that would break the colon-delimited envelope", () => {
    expect(() =>
      createKeyring({ "2:3": ephemeralKey() }, "2:3"),
    ).toThrow(/Invalid key version/);
    expect(() => createKeyring({ "": ephemeralKey() }, "")).toThrow(
      /Invalid key version/,
    );
  });

  it("copies key material so mutating the source buffer cannot alter the keyring", () => {
    const material = ephemeralKey();
    const keyring = createKeyring({ "1": material }, "1");
    const sealed = encrypt(PLAINTEXT, keyring);
    material.fill(0);
    expect(decrypt(sealed, keyring)).toBe(PLAINTEXT);
  });
});

describe("keyring — legacy `v1:` envelopes stay decryptable", () => {
  it("decrypts a legacy envelope when the env-derived key is registered as version `1`", () => {
    const legacy = encryptSecret(PLAINTEXT);
    const keyring = createKeyring({ "1": deriveLegacyKey() }, "1");
    expect(decrypt(legacy, keyring)).toBe(PLAINTEXT);
  });

  it("fails closed on a legacy envelope when version `1` is absent", () => {
    const legacy = encryptSecret(PLAINTEXT);
    const keyring = createKeyring({ "2": ephemeralKey() }, "2");
    expectDecryptFailure(legacy, keyring, "unknown-version");
  });

  it("fails closed on a legacy envelope when version `1` holds the wrong key", () => {
    const legacy = encryptSecret(PLAINTEXT);
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    expectDecryptFailure(legacy, keyring, "auth-failed");
  });

  it("does not disturb the legacy `decryptSecret` path", () => {
    const legacy = encryptSecret(PLAINTEXT);
    expect(decryptSecret(legacy)).toBe(PLAINTEXT);
    process.env.AUTH_SECRET = SECRET_B;
    expect(decryptSecret(legacy)).toBeNull();
  });
});

describe("reencrypt — migration pass", () => {
  it("migrates a legacy v1 envelope under the new active version", () => {
    const legacy = encryptSecret(PLAINTEXT);
    const oldKeyring = createKeyring({ "1": deriveLegacyKey() }, "1");
    const newKeyring = rotateKeyring(oldKeyring, ephemeralKey());
    const migrated = reencrypt(legacy, oldKeyring, newKeyring);
    expect(migrated.startsWith("v2:2:")).toBe(true);
    expect(decrypt(migrated, newKeyring)).toBe(PLAINTEXT);
    expectDecryptFailure(migrated, oldKeyring, "unknown-version");
  });

  it("re-seals a v2 payload under a newer version that a pruned keyring can read", () => {
    const oldKeyring = createKeyring({ "1": ephemeralKey() }, "1");
    const oldPayload = encrypt(PLAINTEXT, oldKeyring);
    const k2 = ephemeralKey();
    const newKeyring = rotateKeyring(oldKeyring, k2);
    const migrated = reencrypt(oldPayload, oldKeyring, newKeyring);
    expect(migrated.split(":")[1]).toBe("2");
    expect(decrypt(migrated, newKeyring)).toBe(PLAINTEXT);
    // A keyring that has dropped the old key still reads the migrated payload.
    const pruned = createKeyring({ "2": k2 }, "2");
    expect(decrypt(migrated, pruned)).toBe(PLAINTEXT);
  });

  it("propagates the typed failure instead of migrating a tampered payload", () => {
    const keyring = createKeyring({ "1": ephemeralKey() }, "1");
    const tampered = tamper(encrypt(PLAINTEXT, keyring), 4);
    expect(() =>
      reencrypt(tampered, keyring, rotateKeyring(keyring, ephemeralKey())),
    ).toThrow(SecretDecryptError);
  });
});

/**
 * §17 secret-handling engine — additive to the envelope tests above.
 *
 * Covers validation/classification, redaction (value, object, connection
 * string), constant-time comparison and the env-secret registry diagnostics.
 * Every diagnostic assertion also checks that a raw *value* never escapes.
 */

const SECRET_VALUE = "sk-live-9f2c7a4b8e1d6205cafebabe";
const SHORT_VALUE = "sk-weak";

describe("parseEnvSecret — validation & classification", () => {
  it("classifies a strong required secret as ok/valid and reports its length", () => {
    const parsed = parseEnvSecret("AUTH_SECRET", SECRET_VALUE, {
      required: true,
    });
    expect(parsed).toEqual({
      name: "AUTH_SECRET",
      required: true,
      present: true,
      length: SECRET_VALUE.length,
      minLength: MIN_SECRET_LENGTH,
      status: "ok",
      valid: true,
    });
  });

  it("reports a missing required secret as missing/invalid", () => {
    const parsed = parseEnvSecret("AUTH_SECRET", undefined, {
      required: true,
    });
    expect(parsed.status).toBe("missing");
    expect(parsed.present).toBe(false);
    expect(parsed.valid).toBe(false);
    expect(parsed.length).toBe(0);
  });

  it("treats a missing optional secret as missing but valid", () => {
    const parsed = parseEnvSecret("AI_API_KEY", "");
    expect(parsed.required).toBe(false);
    expect(parsed.status).toBe("missing");
    expect(parsed.valid).toBe(true);
  });

  it("flags a present-but-short value as weak regardless of required", () => {
    const required = parseEnvSecret("AUTH_SECRET", SHORT_VALUE, {
      required: true,
    });
    const optional = parseEnvSecret("CRON_SECRET", SHORT_VALUE);
    expect(required.status).toBe("weak");
    expect(optional.status).toBe("weak");
    expect(required.valid).toBe(false);
    expect(optional.valid).toBe(false);
  });

  it("honours a custom minLength boundary (exactly minLength is ok)", () => {
    expect(parseEnvSecret("X", "12345", { minLength: 5 }).status).toBe("ok");
    expect(parseEnvSecret("X", "1234", { minLength: 5 }).status).toBe("weak");
  });

  it("treats non-string values as missing without throwing", () => {
    const parsed = parseEnvSecret("X", null, { required: true });
    expect(parsed.status).toBe("missing");
    expect(parsed.present).toBe(false);
  });

  it("never includes the secret value in the result", () => {
    const parsed = parseEnvSecret("AUTH_SECRET", SECRET_VALUE, {
      required: true,
    });
    expect(JSON.stringify(parsed)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(parsed)).not.toContain("sk-live");
    expect(Object.keys(parsed)).not.toContain("value");
  });
});

describe("redact — value masking", () => {
  it("returns an empty string for null, undefined and empty input", () => {
    expect(redact(null)).toBe("");
    expect(redact(undefined)).toBe("");
    expect(redact("")).toBe("");
  });

  it("fully masks values too short to keep both ends", () => {
    expect(redact("sk-1234")).toBe("…");
    expect(redact("abc")).toBe("…");
  });

  it("keeps a three-character head and the last `keep` characters", () => {
    expect(redact("sk-abcdef1234", { keep: 4 })).toBe("sk-…1234");
    expect(redact(SECRET_VALUE)).toBe("sk-…babe");
  });

  it("honours a custom keep and never leaks the middle", () => {
    const masked = redact("abcdefghijklmnop", { keep: 6 });
    expect(masked).toBe("abc…klmnop");
    expect(masked).not.toContain("defghij");
  });

  it("supports keep: 0 (head + ellipsis only)", () => {
    expect(redact("supersecret", { keep: 0 })).toBe("sup…");
  });

  it("does not leak a long secret's middle segment", () => {
    const masked = redact(SECRET_VALUE, { keep: 4 });
    expect(masked).not.toContain("9f2c7a4b8e1d6205");
    expect(masked.startsWith("sk-…")).toBe(true);
  });
});

describe("redactObject — deep, non-mutating redaction", () => {
  it("redacts secret-looking keys case- and separator-insensitively", () => {
    const input = {
      password: SECRET_VALUE,
      Client_Secret: SECRET_VALUE,
      "api-key": SECRET_VALUE,
      APIKEY: SECRET_VALUE,
      token: SECRET_VALUE,
    };
    const redacted = redactObject(input);
    for (const value of Object.values(redacted)) {
      expect(value).not.toContain(SECRET_VALUE);
      expect(value).toBe(redact(SECRET_VALUE));
    }
  });

  it("redacts caller-supplied extra keys", () => {
    const input = { internalRef: SECRET_VALUE, keep: "not-a-secret" };
    const redacted = redactObject(input, ["internal_ref"]);
    expect(redacted.internalRef).toBe(redact(SECRET_VALUE));
    expect(redacted.internalRef).not.toBe(SECRET_VALUE);
    expect(redacted.keep).toBe("not-a-secret");
  });

  it("recurses through nested objects and arrays", () => {
    const input = {
      public: { name: "Noema", settings: { theme: "dark" } },
      rows: [{ password: SECRET_VALUE }, { nested: { token: SECRET_VALUE } }],
    };
    const redacted = redactObject(input);
    expect(redacted).toEqual({
      public: { name: "Noema", settings: { theme: "dark" } },
      rows: [
        { password: redact(SECRET_VALUE) },
        { nested: { token: redact(SECRET_VALUE) } },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET_VALUE);
  });

  it("never mutates the input", () => {
    const input = { password: SECRET_VALUE, nested: { token: SECRET_VALUE } };
    redactObject(input);
    expect(input.password).toBe(SECRET_VALUE);
    expect(input.nested.token).toBe(SECRET_VALUE);
  });

  it("replaces non-string secret values and preserves null", () => {
    const input = { password: 12345, token: { raw: SECRET_VALUE }, missing: null };
    const redacted = redactObject(input);
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.token).toBe("[redacted]");
    expect(redacted.missing).toBeNull();
  });

  it("breaks cycles without throwing", () => {
    const input: { name: string; password: string; self?: unknown } = {
      name: "x",
      password: SECRET_VALUE,
    };
    input.self = input;
    const redacted = redactObject(input) as { self: unknown };
    expect(redacted.self).toBe("[Circular]");
  });

  it("masks connection-string values with maskConnString", () => {
    const dsn =
      "postgresql://noema:supersecretpw@localhost:5433/noema?schema=public";
    const redacted = redactObject({ databaseUrl: dsn });
    expect(redacted.databaseUrl).toBe(maskConnString(dsn));
    expect(redacted.databaseUrl).not.toContain("supersecretpw");
  });

  it("leaves benign keys and non-string leaves intact", () => {
    const input = { host: "localhost", port: 5432, secure: true, tags: ["a", "b"] };
    expect(redactObject(input)).toEqual(input);
  });
});

describe("generateSecret — entropy from crypto, never Math.random", () => {
  it("generates 32 base64url bytes by default with no prefix", () => {
    const generated = generateSecret();
    expect(generated.bytes).toBe(32);
    expect(generated.prefix).toBe("");
    expect(generated.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated.createdAt).toBeGreaterThan(0);
  });

  it("applies an optional prefix", () => {
    const generated = generateSecret({ prefix: "sk-", bytes: 24 });
    expect(generated.value.startsWith("sk-")).toBe(true);
    expect(generated.prefix).toBe("sk-");
    expect(generated.value.slice(3)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("is deterministic when `random` and `now` are injected", () => {
    const generated = generateSecret({
      bytes: 16,
      now: 1_700_000_000_000,
      random: (size) => new Uint8Array(size),
    });
    expect(generated.value).toBe("A".repeat(22));
    expect(generated.createdAt).toBe(1_700_000_000_000);
  });

  it("accepts a clock function", () => {
    const generated = generateSecret({
      now: () => 42,
      random: (size) => new Uint8Array(size),
    });
    expect(generated.createdAt).toBe(42);
  });

  it("produces unique secrets by default", () => {
    const values = new Set(
      Array.from({ length: 50 }, () => generateSecret().value),
    );
    expect(values.size).toBe(50);
  });

  it("rejects a non-positive or non-integer byte count", () => {
    expect(() => generateSecret({ bytes: 0 })).toThrow(/positive integer/);
    expect(() => generateSecret({ bytes: -8 })).toThrow(/positive integer/);
    expect(() => generateSecret({ bytes: 1.5 })).toThrow(/positive integer/);
  });

  it("does not touch Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    try {
      generateSecret();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("constantTimeEqual — content comparison", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual(SECRET_VALUE, SECRET_VALUE)).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different content of equal length", () => {
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("secret-token-a", "secret-token-b")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("compares multibyte unicode by encoded bytes", () => {
    expect(constantTimeEqual("sécret", "sécret")).toBe(true);
    expect(constantTimeEqual("sécret", "secret")).toBe(false);
  });

  it("does not short-circuit on the first differing byte", () => {
    expect(constantTimeEqual("aaaaaaaaaa", "baaaaaaaaa")).toBe(false);
    expect(constantTimeEqual("aaaaaaaaaa", "aaaaaaabaa")).toBe(false);
  });
});

describe("SECRET_REGISTRY", () => {
  it("lists DATABASE_URL and AUTH_SECRET as required", () => {
    const required = SECRET_REGISTRY.filter((entry) => entry.required).map(
      (entry) => entry.name,
    );
    expect(required).toContain("DATABASE_URL");
    expect(required).toContain("AUTH_SECRET");
  });

  it("describes every secret with name/required/scope/rotationDays", () => {
    for (const entry of SECRET_REGISTRY) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.required).toBe("boolean");
      expect(["auth", "database", "ai", "email", "sso", "cron"]).toContain(
        entry.scope,
      );
      expect(Number.isInteger(entry.rotationDays)).toBe(true);
      expect(entry.rotationDays).toBeGreaterThan(0);
    }
  });

  it("has unique names", () => {
    const names = SECRET_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("missingSecrets", () => {
  const registry = [
    { name: "AUTH_SECRET", required: true, scope: "auth", rotationDays: 90 },
    { name: "AI_API_KEY", required: false, scope: "ai", rotationDays: 180 },
    {
      name: "DATABASE_URL",
      required: true,
      scope: "database",
      rotationDays: 365,
    },
  ] as const;

  it("lists only required secrets that are absent", () => {
    expect(missingSecrets({}, registry)).toEqual(["AUTH_SECRET", "DATABASE_URL"]);
    expect(
      missingSecrets({ AUTH_SECRET: "x".repeat(32) }, registry),
    ).toEqual(["DATABASE_URL"]);
  });

  it("ignores optional secrets and empty strings", () => {
    expect(missingSecrets({ AI_API_KEY: "" }, registry)).toEqual([
      "AUTH_SECRET",
      "DATABASE_URL",
    ]);
  });

  it("never returns values", () => {
    const missing = missingSecrets({ AUTH_SECRET: SECRET_VALUE }, registry);
    expect(JSON.stringify(missing)).not.toContain(SECRET_VALUE);
    expect(missing).toEqual(["DATABASE_URL"]);
  });
});

describe("describeSecretStatus", () => {
  const registry = [
    { name: "AUTH_SECRET", required: true, scope: "auth", rotationDays: 90 },
    { name: "CRON_SECRET", required: false, scope: "cron", rotationDays: 90 },
    {
      name: "DATABASE_URL",
      required: true,
      scope: "database",
      rotationDays: 365,
    },
  ] as const;

  it("classifies present / weak / missing without values", () => {
    const statuses = describeSecretStatus(
      {
        AUTH_SECRET: "x".repeat(32),
        CRON_SECRET: "tiny",
        DATABASE_URL: undefined,
      },
      registry,
    );
    expect(statuses).toEqual([
      {
        name: "AUTH_SECRET",
        scope: "auth",
        required: true,
        status: "ok",
        rotationDays: 90,
      },
      {
        name: "CRON_SECRET",
        scope: "cron",
        required: false,
        status: "weak",
        rotationDays: 90,
      },
      {
        name: "DATABASE_URL",
        scope: "database",
        required: true,
        status: "missing",
        rotationDays: 365,
      },
    ]);
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain("xxxx");
    expect(serialized).not.toContain("tiny");
  });

  it("reports an absent optional secret as missing", () => {
    const [only] = describeSecretStatus({}, [registry[1]]);
    expect(only.status).toBe("missing");
    expect(only.required).toBe(false);
  });

  it("defaults to the built-in registry and covers every entry", () => {
    const statuses = describeSecretStatus({});
    expect(statuses).toHaveLength(SECRET_REGISTRY.length);
    expect(statuses.every((entry) => entry.status === "missing")).toBe(true);
  });
});

describe("maskConnString", () => {
  const dsn =
    "postgresql://noema:supersecretpw@localhost:5433/noema?schema=public";

  it("masks the password while keeping user, host, port, db and query", () => {
    const masked = maskConnString(dsn);
    expect(masked).not.toContain("supersecretpw");
    expect(masked).toContain("noema:***@localhost:5433");
    expect(masked).toContain("schema=public");
  });

  it("masks a password that contains a raw @ (the parser splits at the last @)", () => {
    const masked = maskConnString(
      "postgresql://noema:p@ssw0rd@127.0.0.1:5432/noema?schema=public",
    );
    expect(masked).not.toContain("ssw0rd");
    expect(masked).toBe(
      "postgresql://noema:***@127.0.0.1:5432/noema?schema=public",
    );
  });

  it("leaves a credential-free connection string unchanged", () => {
    const plain = "postgresql://localhost:5432/noema?schema=public";
    expect(maskConnString(plain)).toBe(plain);
  });

  it("returns an empty string for empty input", () => {
    expect(maskConnString(null)).toBe("");
    expect(maskConnString(undefined)).toBe("");
    expect(maskConnString("")).toBe("");
  });

  it("masks a password query parameter", () => {
    const masked = maskConnString(
      "postgresql://localhost:5432/noema?password=letmein&sslmode=require",
    );
    expect(masked).not.toContain("letmein");
    expect(masked).toContain("password=***");
    expect(masked).toContain("sslmode=require");
  });

  it("falls back to regex masking for strings URL cannot parse", () => {
    const masked = maskConnString("mysql://root:hunter2@db.internal:3306/app");
    expect(masked).not.toContain("hunter2");
    expect(masked).toBe("mysql://root:***@db.internal:3306/app");
  });

  it("never throws and always returns a string", () => {
    const inputs: Array<string | null | undefined> = [
      "",
      null,
      undefined,
      "not a url",
      "://::",
      "postgres://",
    ];
    for (const input of inputs) {
      expect(typeof maskConnString(input)).toBe("string");
    }
  });
});

describe("the share unlock cookie (B01)", () => {
  const TOKEN = "share-token-abc";
  const NOW = 1_800_000_000;

  it("mints a value that verifies for its own share token", () => {
    const value = createShareUnlockToken(TOKEN, { now: NOW });
    expect(value).not.toBe("1");
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(true);
  });

  it("refuses the old constant cookie value", () => {
    expect(verifyShareUnlockToken(TOKEN, "1", { now: NOW })).toBe(false);
  });

  it("refuses a value minted for a different share token", () => {
    const value = createShareUnlockToken("other-token", { now: NOW });
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(false);
  });

  it("refuses an expired value — the boundary instant counts as expired", () => {
    const value = createShareUnlockToken(TOKEN, { expiresAt: NOW, now: NOW });
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(false);
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW - 1 })).toBe(true);
  });

  it("refuses a tampered signature and a tampered expiry", () => {
    const value = createShareUnlockToken(TOKEN, { now: NOW });
    const [, expiry, signature] = value.split(":");

    const forgedSignature = `${expiry}:${signature.slice(0, -1)}${
      signature.endsWith("A") ? "B" : "A"
    }`;
    expect(verifyShareUnlockToken(TOKEN, forgedSignature, { now: NOW })).toBe(
      false,
    );

    const forgedExpiry = `${expiry + 1}:${signature}`;
    expect(verifyShareUnlockToken(TOKEN, forgedExpiry, { now: NOW })).toBe(false);
  });

  it("refuses malformed, empty and absent values", () => {
    for (const value of [
      "",
      "   ",
      "v1",
      "v1:123",
      "v1:123:abc:def",
      "v2:1800000000:abc",
      "v1:not-a-number:abc",
      "v1:-1:abc",
      "v1:1800000000:",
    ]) {
      expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(false);
    }
    expect(verifyShareUnlockToken(TOKEN, null, { now: NOW })).toBe(false);
    expect(verifyShareUnlockToken(TOKEN, undefined, { now: NOW })).toBe(false);
  });

  it("refuses everything when the server secret is missing", () => {
    const value = createShareUnlockToken(TOKEN, { now: NOW });
    delete process.env.AUTH_SECRET;
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(false);
    expect(() => createShareUnlockToken(TOKEN, { now: NOW })).toThrow(
      /AUTH_SECRET/,
    );
  });

  it("does not accept a value signed with a different secret", () => {
    const value = createShareUnlockToken(TOKEN, { now: NOW });
    process.env.AUTH_SECRET = "b85-a-completely-different-secret";
    expect(verifyShareUnlockToken(TOKEN, value, { now: NOW })).toBe(false);
  });

  it("names the cookie after the share token", () => {
    expect(shareUnlockCookieName(TOKEN)).toBe(`share_${TOKEN}`);
  });

  // The constant-time comparison is not observable at runtime: a plain `===`
  // returns the same result, so every behavioural test above stays green on a
  // regression to a short-circuiting comparison. The property is therefore
  // pinned at the source level.
  it("compares the signature in constant time", () => {
    const source = readFileSync(
      new URL("./secrets.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export function verifyShareUnlockToken");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("timingSafeEqual");
    expect(body).not.toMatch(/given\s*===|===\s*want|want\s*===/);
  });
});
