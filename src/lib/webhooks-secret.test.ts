import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * R28.17 / M28.3 — webhook signing secrets are sealed at rest. Pure tests over
 * the encrypt/decrypt helpers: no DB, no network. `@/lib/db` is mocked because
 * `webhooks.ts` imports the Prisma singleton at module load.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  decryptWebhookSecret,
  encryptWebhookSecret,
} from "./webhooks";
import { encryptSecret } from "@/lib/secrets";

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeAll(() => {
  process.env.AUTH_SECRET = "webhook-secret-test-key-0123456789";
});

afterAll(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
});

describe("webhook secret envelope at rest (R28.17)", () => {
  it("round-trips a secret through the keyring envelope without storing plaintext", () => {
    const sealed = encryptWebhookSecret("whsec_roundtrip_9f2c");
    expect(sealed).toMatch(/^v2:/);
    expect(sealed).not.toContain("whsec_roundtrip_9f2c");
    expect(decryptWebhookSecret(sealed)).toBe("whsec_roundtrip_9f2c");
  });

  it("seals the same plaintext to a fresh ciphertext each time (random IV)", () => {
    const first = encryptWebhookSecret("same-secret");
    const second = encryptWebhookSecret("same-secret");
    expect(first).not.toBe(second);
    expect(decryptWebhookSecret(first)).toBe("same-secret");
    expect(decryptWebhookSecret(second)).toBe("same-secret");
  });
});

describe("legacy plaintext transition window (M28.3)", () => {
  it("treats a pre-migration plaintext secret as-is so existing hooks keep signing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(decryptWebhookSecret("s3cr3t")).toBe("s3cr3t");
    expect(decryptWebhookSecret("legacy-plaintext")).toBe("legacy-plaintext");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("opens a legacy `v1:` envelope written by `encryptSecret`", () => {
    expect(decryptWebhookSecret(encryptSecret("legacy-envelope"))).toBe(
      "legacy-envelope",
    );
  });

  it("returns null for absent secrets, never a signature", () => {
    expect(decryptWebhookSecret(null)).toBeNull();
    expect(decryptWebhookSecret(undefined)).toBeNull();
    expect(decryptWebhookSecret("")).toBeNull();
  });

  it("never signs with ciphertext when an envelope is unreadable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(decryptWebhookSecret("v1:not:valid:base64!!")).toBeNull();
    expect(decryptWebhookSecret("v2:9:aaaa:bbbb:cccc")).toBeNull();
    warn.mockRestore();
  });
});
