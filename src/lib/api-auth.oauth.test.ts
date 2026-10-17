/**
 * (Its own file: the resolver suite of B04 mocks the database, and two
 * `vi.mock` blocks for one module cannot live in one file. These helpers are
 * pure functions — no database is involved at all.)
 */
import { describe, expect, it } from "vitest";

/**
 * `src/lib/api-auth.ts` — the OAuth helpers.
 *
 * OAuth client secrets and authorization codes are stored the same way API
 * tokens are: as a SHA-256 digest. The plaintext exists only in the response
 * that shows it (once, at creation) and in the redirect that hands the code to
 * the client — never in the database.
 *
 * The digest vectors below are the ones the migration produces in Postgres
 * (`encode(sha256(convert_to(x, 'UTF8')), 'hex')`): lowercase hex, UTF-8
 * bytes, byte for byte the same as `node:crypto`'s
 * `createHash("sha256").update(x).digest("hex")`.
 */

import { apiTokenMatches, hashApiToken, hashOAuthSecret, oauthSecretMatches } from "./api-auth";

describe("hashOAuthSecret", () => {
  it("is the SHA-256 hex digest of the UTF-8 bytes", () => {
    expect(hashOAuthSecret("noema_oauth_secret_probe")).toBe(
      "7f4e4fcb66b115132cbfa41b7b341234f8ef4c32a3db8121524ca0481b5bb354",
    );
    expect(hashOAuthSecret("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // Multi-byte characters are hashed as their UTF-8 bytes — the same bytes
    // `convert_to(x, 'UTF8')` hands to Postgres' `sha256()`.
    expect(hashOAuthSecret("sécret-🔐-日本語")).toBe(
      "30c2f68f907b8c24b615f8f6e9b9dd3c83b4e9371f483b3c58cee16b06144f80",
    );
  });

  it("produces the same digest as the API token hash", () => {
    expect(hashOAuthSecret("same-value")).toBe(hashApiToken("same-value"));
  });

  it("is lowercase hex of a fixed length", () => {
    const digest = hashOAuthSecret("noema_oauth_secret_probe");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("oauthSecretMatches", () => {
  it("accepts the secret the digest was made of", () => {
    const secret = "client-secret-plaintext";
    expect(oauthSecretMatches(secret, hashOAuthSecret(secret))).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    const digest = hashOAuthSecret("client-secret-plaintext");
    expect(oauthSecretMatches("client-secret-plaintexT", digest)).toBe(false);
  });

  it("rejects a secret of a different length without throwing", () => {
    // `timingSafeEqual` throws when the buffers differ in length, so the
    // length is checked first — a stored digest that is not a digest (empty,
    // truncated, or from an older format) must not crash the token endpoint.
    const digest = hashOAuthSecret("client-secret-plaintext");
    expect(oauthSecretMatches("short", digest)).toBe(false);
    expect(oauthSecretMatches("", digest)).toBe(false);
    expect(oauthSecretMatches("client-secret-plaintext", "")).toBe(false);
    expect(oauthSecretMatches("client-secret-plaintext", digest.slice(0, 63))).toBe(false);
  });

  it("is the same comparison the API tokens use", () => {
    const secret = "client-secret-plaintext";
    const digest = hashOAuthSecret(secret);
    expect(oauthSecretMatches(secret, digest)).toBe(apiTokenMatches(secret, digest));
    expect(oauthSecretMatches("wrong", digest)).toBe(apiTokenMatches("wrong", digest));
  });
});
