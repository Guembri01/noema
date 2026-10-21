import { describe, expect, it } from "vitest";
import { redactMessage } from "./error-tracking";
import { redactSecrets } from "./error-reporting";
import { REDACTED, VALUE_SCRUBBERS, scrubSecretValues } from "./value-scrubbing";

/**
 * The one list of credential-shaped values (B121) — red-first.
 *
 * The error reporter (`src/lib/error-reporting.ts`) and the error tracker
 * (`src/lib/error-tracking.ts`) each used to carry their own copy of the same
 * nine patterns, so a change to one list did not reach the other. Both now
 * scrub through `value-scrubbing.ts`.
 *
 * Contract pinned here:
 *  - every credential shape in the shared list is masked, and the marker is
 *    the same one the consumers export;
 *  - ordinary text is untouched and the scrub is idempotent;
 *  - the two consumers scrub a credential the same way — the pin that fails
 *    if one of them ever grows a private copy of the list again;
 *  - a shape added to the shared list reaches both consumers.
 */

/** One sample per pattern of the shared list. */
const CREDENTIAL_SAMPLES: readonly string[] = [
  "auth failed for Bearer abcdefgh12345678",
  "Authorization: Basic Zm9vOmJhcg==",
  "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
  "key sk-live-abcdefghijklmno",
  "key pk_abcdefghijklmnop",
  "key rk_abcdefghijklmnop",
  "pat ghp_abcdefghijklmnopqrstuvwxyz01",
  "pat gho_abcdefghijklmnopqrstuvwxyz01",
  "pat ghu_abcdefghijklmnopqrstuvwxyz01",
  "pat ghs_abcdefghijklmnopqrstuvwxyz01",
  "pat ghr_abcdefghijklmnopqrstuvwxyz01",
  "pat github_pat_abcdefghijklmnopqrstuvwxyz01",
  "slack xoxb-123456789012-abcdefghijkl",
  "slack xoxp-123456789012-abcdefghijkl",
  "slack xoxo-123456789012-abcdefghijkl",
  "slack xoxa-123456789012-abcdefghijkl",
  "slack xoxr-123456789012-abcdefghijkl",
  "aws AKIAIOSFODNN7EXAMPLE",
  "https://x.test/cb?token=deadbeefcafe&next=/home",
  "https://x.test/cb?access_token=deadbeefcafe",
  "https://x.test/cb?api_key=deadbeefcafe",
  "https://x.test/cb?apikey=deadbeefcafe",
  "https://x.test/cb?password=deadbeefcafe",
  "https://x.test/cb?secret=deadbeefcafe",
];

describe("scrubSecretValues", () => {
  it("masks every credential shape of the shared list", () => {
    for (const sample of CREDENTIAL_SAMPLES) {
      const scrubbed = scrubSecretValues(sample);
      expect(scrubbed).toContain(REDACTED);
      expect(scrubbed).not.toBe(sample);
    }
  });

  it("covers all nine patterns of the list", () => {
    expect(VALUE_SCRUBBERS).toHaveLength(9);
  });

  it("leaves ordinary text untouched and is idempotent", () => {
    expect(scrubSecretValues("all clear")).toBe("all clear");
    expect(scrubSecretValues("")).toBe("");
    const once = scrubSecretValues(CREDENTIAL_SAMPLES[0] ?? "");
    expect(scrubSecretValues(once)).toBe(once);
  });

  it("keeps the parameter name of a credential query parameter", () => {
    expect(scrubSecretValues("https://x.test/cb?token=deadbeefcafe&next=/home")).toBe(
      `https://x.test/cb?token=${REDACTED}&next=/home`,
    );
  });
});

describe("one source, two consumers", () => {
  it("scrubs a credential the same way in the reporter and the tracker", () => {
    for (const sample of CREDENTIAL_SAMPLES) {
      expect(redactSecrets(sample)).toBe(scrubSecretValues(sample));
      expect(redactMessage(sample)).toBe(scrubSecretValues(sample));
    }
  });

  it("propagates a shape added to the shared list to both consumers", () => {
    const list = VALUE_SCRUBBERS as { pattern: RegExp; replace: string }[];
    list.push({ pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: REDACTED });
    try {
      const secret = "gitlab glpat-abcdefghij0123456789";
      expect(redactMessage(secret)).toBe(`gitlab ${REDACTED}`);
      expect(redactSecrets(secret)).toBe(`gitlab ${REDACTED}`);
    } finally {
      list.pop();
    }
  });
});
