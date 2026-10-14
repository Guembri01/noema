import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  maskSecret,
  randomToken,
} from "@/lib/secrets";

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

/** Flip the low bit of segment 1=iv, 2=tag, 3=payload. */
function tamper(envelope: string, segment: 1 | 2 | 3): string {
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
