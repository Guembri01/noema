import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B55 — the `.env.example` placeholder must not be a valid `AUTH_SECRET`.
 *
 * `AUTH_SECRET` signs the session cookie (HS256) and derives the envelope
 * key for every stored provider key and 2FA seed. The placeholder that ships
 * in `.env.example` is public, so every instance that copies it runs with a
 * signing key everybody knows: whoever has it can mint a valid session cookie
 * for any user id.
 *
 * The test reads the placeholder **out of the repository** (`.env.example`),
 * not out of a copy in this file: change the shipped placeholder and this
 * suite fails until the rule is adapted with it.
 *
 * Red-first: before the rule existed, `secretKey()` only refused secrets
 * shorter than 16 characters and `encryptionKey()` only refused an empty
 * one — the 35-character placeholder passed both, and the two application
 * read sites below happily used it as the session/HMAC key.
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) as string } : undefined,
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

import {
  MIN_AUTH_SECRET_LENGTH,
  SHIPPED_AUTH_SECRET_PLACEHOLDERS,
  WEAK_AUTH_SECRETS,
  assertAuthSecret,
  authSecretProblem,
  resolveAuthSecret,
} from "@/lib/auth-secret";
import { createSession } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

/** The repository's own `.env.example`. */
const ENV_EXAMPLE = readFileSync(
  join(process.cwd(), ".env.example"),
  "utf8",
);

/** The `AUTH_SECRET` value as it is shipped in `.env.example`. */
function shippedPlaceholder(): string {
  const line = ENV_EXAMPLE.split(/\r?\n/).find((entry) =>
    entry.startsWith("AUTH_SECRET="),
  );
  if (!line) throw new Error(".env.example has no AUTH_SECRET line");
  const value = line.slice("AUTH_SECRET=".length).trim();
  return value.replace(/^["']|["']$/g, "");
}

const ORIGINAL_SECRET = process.env.AUTH_SECRET;
let sessionDir: string;

beforeEach(() => {
  jar.clear();
  sessionDir = mkdtempSync(join(tmpdir(), "b55-auth-secret-"));
  process.env.SESSION_STORE_PATH = join(sessionDir, "sessions.json");
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
  if (ORIGINAL_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe("B55 — the placeholder shipped in .env.example", () => {
  it(".env.example really does ship a placeholder (the premise of this suite)", () => {
    expect(shippedPlaceholder()).toBe("replace-me-with-a-32-byte-hex-secret");
    expect(shippedPlaceholder().length).toBeGreaterThanOrEqual(
      MIN_AUTH_SECRET_LENGTH,
    );
  });

  it("is refused by the rule", () => {
    expect(authSecretProblem(shippedPlaceholder())).toBe("placeholder");
    expect(() => assertAuthSecret(shippedPlaceholder())).toThrow(/AUTH_SECRET/);
  });

  it("is refused by the session key (src/lib/auth.ts)", async () => {
    process.env.AUTH_SECRET = shippedPlaceholder();
    await expect(createSession("user-a")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("is refused by the envelope key (src/lib/secrets.ts)", () => {
    process.env.AUTH_SECRET = shippedPlaceholder();
    expect(() => encryptSecret("provider-key")).toThrow(/AUTH_SECRET/);
  });

  it("cannot be smuggled in with another spelling", () => {
    const placeholder = shippedPlaceholder();
    const spellings = [
      placeholder.toUpperCase(),
      `  ${placeholder}  `,
      placeholder.replace(/-/g, "_"),
      placeholder.replace(/-/g, ""),
      placeholder.replace(/-/g, " "),
    ];
    for (const spelling of spellings) {
      expect(authSecretProblem(spelling)).toBe("placeholder");
      // …and the application refuses it, not only the pure rule.
      process.env.AUTH_SECRET = spelling;
      expect(() => encryptSecret("provider-key")).toThrow(/AUTH_SECRET/);
    }
  });

  it("is listed in the denylist that ships with the rule", () => {
    expect(SHIPPED_AUTH_SECRET_PLACEHOLDERS).toContain(shippedPlaceholder());
  });
});

describe("B55 — the length floor", () => {
  it("refuses a 16-character secret", () => {
    expect(authSecretProblem("a".repeat(16))).toBe("too-short");
  });

  it("refuses a 31-character secret", () => {
    expect(authSecretProblem("a".repeat(31))).toBe("too-short");
  });

  it("accepts a 32-character secret", () => {
    expect(authSecretProblem("a".repeat(32))).toBeNull();
  });

  it("accepts a 64-character secret", () => {
    expect(authSecretProblem("a".repeat(64))).toBeNull();
  });

  it("measures the trimmed value, not the padded one", () => {
    expect(authSecretProblem(`  ${"a".repeat(32)}  `)).toBeNull();
    expect(authSecretProblem(`  ${"a".repeat(31)}  `)).toBe("too-short");
  });
});

describe("B55 — well-known weak values", () => {
  it("refuses the classics", () => {
    for (const value of [
      "changeme",
      "change-me",
      "your-secret-here",
      "example",
      "secret",
      "password",
      "placeholder",
    ]) {
      expect(authSecretProblem(value)).not.toBeNull();
    }
  });

  it("refuses them in any case and with padding", () => {
    for (const value of [
      "CHANGEME",
      "Change-Me",
      "  Secret  ",
      "\tYour-Secret-Here\n",
      "PASSWORD",
    ]) {
      expect(authSecretProblem(value)).not.toBeNull();
    }
  });

  it("lists them in the denylist that ships with the rule", () => {
    for (const value of ["changeme", "change-me", "secret", "password"]) {
      expect(WEAK_AUTH_SECRETS.map((entry) => entry.toLowerCase())).toContain(
        value,
      );
    }
  });
});

describe("B55 — a real secret still works", () => {
  it("accepts a random 64-character secret and round-trips an envelope", () => {
    const secret = "492ab3e1125d19ee06fc1f72772e35ebbfd522c4953da50ab325e03cd5956d49";
    expect(secret).toHaveLength(64);
    process.env.AUTH_SECRET = secret;

    expect(resolveAuthSecret()).toBe(secret);
    const envelope = encryptSecret("provider-key");
    expect(decryptSecret(envelope)).toBe("provider-key");
  });

  it("derives two different keys from two different secrets", () => {
    const first = "492ab3e1125d19ee06fc1f72772e35ebbfd522c4953da50ab325e03cd5956d49";
    const second = "f230e462d51dada46995a5424a5fe4d10d2094fec0d89b97f45e92fea36b06db";

    process.env.AUTH_SECRET = first;
    const envelope = encryptSecret("provider-key");

    process.env.AUTH_SECRET = second;
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("issues a session that resolves to its user", async () => {
    process.env.AUTH_SECRET =
      "492ab3e1125d19ee06fc1f72772e35ebbfd522c4953da50ab325e03cd5956d49";
    await expect(createSession("user-a")).resolves.toBeUndefined();
  });
});

describe("B55 — fail closed", () => {
  it("refuses a missing AUTH_SECRET", () => {
    delete process.env.AUTH_SECRET;
    expect(authSecretProblem(undefined)).toBe("missing");
    expect(() => resolveAuthSecret()).toThrow(/AUTH_SECRET/);
    expect(() => encryptSecret("provider-key")).toThrow(/AUTH_SECRET/);
  });

  it("refuses an empty AUTH_SECRET", () => {
    process.env.AUTH_SECRET = "";
    expect(authSecretProblem("")).toBe("missing");
    expect(() => resolveAuthSecret()).toThrow(/AUTH_SECRET/);
  });

  it("never puts the rejected value into the error message", () => {
    const rejected = "REPLACE-ME-WITH-A-32-BYTE-HEX-SECRET";
    process.env.AUTH_SECRET = rejected;
    let message = "";
    try {
      resolveAuthSecret();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).not.toContain(rejected);
  });
});
