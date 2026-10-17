import { describe, expect, it } from "vitest";
import {
  CONNECTION_STRING_KEYS,
  SECRET_KEY_FRAGMENTS,
  SECRET_KEY_LIST,
  SECRET_KEY_NAMES,
  isSecretKey,
  isSecretKeyName,
  normalizeSecretKey,
} from "./redaction";
import { REDACTED as LOG_REDACTED, isSensitiveKey } from "./observability";
import { REDACTED as ERROR_REDACTED, redactSecrets } from "./error-reporting";
import { redactObject } from "@/lib/secrets";

/**
 * B35 — the repository's one secret-key list.
 *
 * The observability logger, the error reporter and the env-secret diagnostics
 * each used to carry their own list of secret-shaped field names, and the
 * three had drifted: `apiKey` and `privateKey` were masked by the error
 * reporter but printed by the logger, while `dbUrl` was masked by nobody.
 *
 * `src/lib/redaction.ts` owns the names now. What stays with each consumer is
 * its matching rule (the logger and the error reporter over-redact by
 * substring, the diagnostics match whole names) and its value handling.
 *
 * The contract pinned here:
 *  - the list is the union of the three former lists, so nothing that was
 *    masked before is unmasked now;
 *  - every name in the list is masked by all three consumers;
 *  - ordinary field names (`author`, `publicKey`, `username`) stay readable
 *    everywhere.
 */

/** The names the three former lists covered, in one place. */
const EXPECTED_NAMES: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "passcode",
  "pass",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "sessionid",
  "signature",
  "auth",
  "dsn",
  "dburl",
  "databaseurl",
  "connectionstring",
];

/** Ordinary fields that must survive every redaction path. */
const BENIGN_KEYS: readonly string[] = [
  "username",
  "email",
  "requestId",
  "author",
  "authorId",
  "publicKey",
  "host",
  "port",
  "name",
  "tags",
  "enabled",
];

/** A connection string, for the keys whose value is one. */
const DSN = "postgresql://noema:supersecretpw@localhost:5433/noema";

/** A plain secret value, for every other key. */
const SECRET = "sk-live-abcdefghijklmnop";

describe("the shared secret-key list", () => {
  it("is the union of the three former lists", () => {
    expect([...SECRET_KEY_LIST].sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it("splits the names into substrings and whole names", () => {
    expect(SECRET_KEY_LIST).toEqual([...SECRET_KEY_FRAGMENTS, ...SECRET_KEY_NAMES]);
    // A whole name is too ambiguous to be matched inside a longer name.
    expect(SECRET_KEY_NAMES).toContain("auth");
    expect(SECRET_KEY_FRAGMENTS).not.toContain("auth");
  });

  it("knows the connection-string keys", () => {
    expect(CONNECTION_STRING_KEYS).toContain("dburl");
    expect(CONNECTION_STRING_KEYS).toContain("databaseurl");
  });

  it("normalises a key the same way everywhere", () => {
    expect(normalizeSecretKey("apiKey")).toBe("apikey");
    expect(normalizeSecretKey("API KEY")).toBe("apikey");
    expect(normalizeSecretKey("api-key")).toBe("apikey");
    expect(normalizeSecretKey("refresh_token")).toBe("refreshtoken");
  });

  it("matches a name whatever the spelling", () => {
    for (const key of ["apiKey", "api_key", "API KEY", "Api-Key"]) {
      expect(isSecretKey(key)).toBe(true);
      expect(isSecretKeyName(key)).toBe(true);
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const key of BENIGN_KEYS) {
      expect(isSecretKey(key)).toBe(false);
      expect(isSecretKeyName(key)).toBe(false);
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("the three consumers share the list", () => {
  for (const name of SECRET_KEY_LIST) {
    it(`masks ${name} in the logger, the error reporter and the diagnostics`, () => {
      const isConnectionString = CONNECTION_STRING_KEYS.includes(name);
      const value = isConnectionString ? DSN : SECRET;

      // The logger: the value is replaced outright.
      expect(isSensitiveKey(name)).toBe(true);

      // The error reporter: the value is replaced outright, too.
      expect(redactSecrets({ [name]: value })).toEqual({ [name]: ERROR_REDACTED });

      // The diagnostics: the value is masked, never handed out in the clear.
      const masked = redactObject({ [name]: value }) as Record<string, unknown>;
      expect(masked[name]).not.toBe(value);
      expect(masked[name]).not.toContain("supersecretpw");
      expect(masked[name]).not.toContain("abcdefghijklmnop");
    });
  }

  it("keeps ordinary fields readable in every consumer", () => {
    for (const key of BENIGN_KEYS) {
      expect(redactSecrets({ [key]: "plain" })).toEqual({ [key]: "plain" });
      expect(redactObject({ [key]: "plain" })).toEqual({ [key]: "plain" });
    }
  });

  it("over-redacts compound names in the logger and the error reporter (by design)", () => {
    // The substring rule is deliberate: masking `tokenCount` is preferable to
    // leaking a real `token`.
    expect(isSensitiveKey("secretKey")).toBe(true);
    expect(isSensitiveKey("tokenCount")).toBe(true);
    expect(redactSecrets({ tokenCount: 3 })).toEqual({ tokenCount: ERROR_REDACTED });
  });

  it("masks a logged field the way the error reporter does", () => {
    expect(LOG_REDACTED).toBe(ERROR_REDACTED);
    expect(isSensitiveKey("apiKey")).toBe(true);
  });
});
