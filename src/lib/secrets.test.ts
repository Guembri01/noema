import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_KEY_AGE_SECONDS,
  SecretDecryptError,
  createKeyring,
  decrypt,
  decryptSecret,
  deriveLegacyKey,
  encrypt,
  encryptSecret,
  hashToken,
  maskSecret,
  needsRotation,
  randomToken,
  reencrypt,
  rotateKeyring,
} from "@/lib/secrets";
import type { Keyring, SecretDecryptErrorCode } from "@/lib/secrets";

/**
 * B85 — envelope tests for `src/lib/secrets.ts` (READ-ONLY module).
 *
 * The module derives its AES-256-GCM key from `AUTH_SECRET`, so every test
 * pins the env var itself and restores the outer value in `afterEach` — the
 * ambient process env (loaded `.env`, CI) must not influence assertions.
 */

const SECRET_A = "b85-test-secret-a";
const SECRET_B = "b85-test-secret-b";
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
