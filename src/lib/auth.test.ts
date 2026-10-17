import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth";

/**
 * Only the pure helpers of src/lib/auth.ts are unit-tested here.
 * createSession / destroySession / getSessionUserId / getCurrentUser /
 * requireUser depend on next/headers cookies, env secret and prisma — impure,
 * covered by e2e instead of being forced into this suite.
 *
 * bcrypt cost 12 is intentionally slow; under parallel CPU load a single
 * hash/compare can exceed vitest's 5s default, so every bcrypt test gets an
 * explicit timeout and hashes are computed once in beforeAll.
 */
const BCRYPT_TIMEOUT = 30_000;

let sharedHash: string;

beforeAll(async () => {
  sharedHash = await hashPassword("shared-password");
}, BCRYPT_TIMEOUT);

describe("auth password helpers", () => {
  it(
    "hashes with bcrypt cost 12 and never leaks the plaintext",
    async () => {
      const hash = await hashPassword("correct horse battery staple");
      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      expect(hash).toHaveLength(60);
      expect(hash).not.toContain("correct horse");
    },
    BCRYPT_TIMEOUT,
  );

  it(
    "salts: same password yields different hashes, both verify",
    async () => {
      const a = await hashPassword("same-password");
      const b = await hashPassword("same-password");
      expect(a).not.toBe(b);
      expect(await verifyPassword("same-password", a)).toBe(true);
      expect(await verifyPassword("same-password", b)).toBe(true);
    },
    BCRYPT_TIMEOUT,
  );

  it(
    "rejects wrong passwords",
    async () => {
      expect(await verifyPassword("wrong-password", sharedHash)).toBe(false);
      expect(await verifyPassword("", sharedHash)).toBe(false);
    },
    BCRYPT_TIMEOUT,
  );

  it(
    "returns false for a non-bcrypt hash",
    async () => {
      expect(await verifyPassword("pw", "not-a-bcrypt-hash")).toBe(false);
    },
    BCRYPT_TIMEOUT,
  );

  it(
    "rejects a hash of a different password",
    async () => {
      expect(await verifyPassword("password-two", sharedHash)).toBe(false);
    },
    BCRYPT_TIMEOUT,
  );
});
