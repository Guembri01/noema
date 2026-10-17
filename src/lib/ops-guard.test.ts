import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/secrets";
import {
  CRON_SECRET_NOT_CONFIGURED,
  OPS_SECRET_HEADER,
  READY_SECRET_HEADER,
  guardOpsSecret,
  opsSecretLimitKey,
  requestHasOpsSecret,
  safeSecretEqual,
} from "@/lib/ops-guard";

/**
 * The shared ops gate (`@/lib/ops-guard`).
 *
 * Two properties are pinned here:
 *
 *  1. **The comparison is constant time in the content.** A timing test would
 *     be unreliable, so the proof is structural: the comparison delegates to
 *     `constantTimeEqual` (`@/lib/secrets`), which folds the length difference
 *     into the accumulator and never returns early on a mismatch. There is no
 *     `===`/`!==` on a secret anywhere in the ops gate — `ops-gate-order.test.ts`
 *     greps the nine gate files for exactly that.
 *  2. **The gate fails closed.** An absent, blank or unset secret is never a
 *     match, and the rate limit runs *before* the comparison.
 */

const SECRET = "s3cret";

describe("safeSecretEqual", () => {
  it("matches identical secrets", () => {
    expect(safeSecretEqual(SECRET, SECRET)).toBe(true);
  });

  it("rejects a near miss that shares a prefix", () => {
    expect(safeSecretEqual("s3cret", "s3crev")).toBe(false);
    expect(safeSecretEqual("s3cret", "s3cretx")).toBe(false);
  });

  it("trims the header before the comparison", () => {
    expect(safeSecretEqual("s3cret", "s3cret ")).toBe(true);
    expect(safeSecretEqual(" s3cret", "s3cret")).toBe(true);
    expect(safeSecretEqual(" s3cret ", "s3cret")).toBe(true);
  });

  it("fails closed on an empty value", () => {
    expect(safeSecretEqual("", "")).toBe(false);
    expect(safeSecretEqual("", SECRET)).toBe(false);
    expect(safeSecretEqual(SECRET, "")).toBe(false);
    expect(safeSecretEqual("   ", "   ")).toBe(false);
  });

  it("fails closed on an absent value", () => {
    expect(safeSecretEqual(undefined, "x")).toBe(false);
    expect(safeSecretEqual("x", undefined)).toBe(false);
    expect(safeSecretEqual(null, null)).toBe(false);
    expect(safeSecretEqual(undefined, undefined)).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(safeSecretEqual("s3cret", "s3cre")).toBe(false);
    expect(safeSecretEqual("s3cret", "s3cret-longer")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(safeSecretEqual("S3cret", "s3cret")).toBe(false);
  });
});

describe("constantTimeEqual (the base the ops gate compares with)", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a near miss and a length mismatch", () => {
    expect(constantTimeEqual("s3cret", "s3crev")).toBe(false);
    expect(constantTimeEqual("s3cret", "s3cretx")).toBe(false);
  });

  it("is the raw helper: unlike the ops gate it does not fail closed on empties", () => {
    // Documented difference — `safeSecretEqual` adds the fail-closed rule.
    expect(constantTimeEqual("", "")).toBe(true);
    expect(safeSecretEqual("", "")).toBe(false);
  });
});

describe("requestHasOpsSecret", () => {
  const request = (headers: Record<string, string>): Request =>
    new Request("http://localhost/api/cron/templates", { headers });

  it("accepts the secret in the ops header", () => {
    expect(requestHasOpsSecret(request({ [OPS_SECRET_HEADER]: SECRET }), SECRET)).toBe(true);
  });

  it("rejects a wrong or missing header", () => {
    expect(requestHasOpsSecret(request({ [OPS_SECRET_HEADER]: "nope" }), SECRET)).toBe(false);
    expect(requestHasOpsSecret(request({}), SECRET)).toBe(false);
  });

  it("accepts the readiness alias when the caller asks for it", () => {
    const withAlias = requestHasOpsSecret(
      request({ [READY_SECRET_HEADER]: SECRET }),
      SECRET,
      [OPS_SECRET_HEADER, READY_SECRET_HEADER],
    );
    expect(withAlias).toBe(true);
  });
});

describe("guardOpsSecret", () => {
  const request = (headers: Record<string, string>): Request =>
    new Request("http://localhost/api/cron/templates", { headers });

  it("fails closed with 503 when no secret is configured", () => {
    const gate = guardOpsSecret(request({ [OPS_SECRET_HEADER]: SECRET }), { secret: undefined });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.response.status).toBe(503);
    expect(gate.response.headers.get("content-type")).toContain("application/json");
  });

  it("answers 503 with the cron hint by default", async () => {
    const gate = guardOpsSecret(request({}), { secret: "" });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    await expect(gate.response.json()).resolves.toEqual({
      error: CRON_SECRET_NOT_CONFIGURED,
    });
  });

  it("answers 401 for a wrong secret", async () => {
    const gate = guardOpsSecret(request({ [OPS_SECRET_HEADER]: "nope" }), { secret: SECRET });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.response.status).toBe(401);
    await expect(gate.response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("runs the rate limit BEFORE the comparison (a wrong secret is throttled)", async () => {
    const limited = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    const gate = guardOpsSecret(request({ [OPS_SECRET_HEADER]: "nope" }), {
      secret: SECRET,
      limit: () => limited,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    // 429, not 401: the limit is what bounds the guessing, so it runs first.
    expect(gate.response.status).toBe(429);
  });

  it("lets a correct secret through", () => {
    const gate = guardOpsSecret(request({ [OPS_SECRET_HEADER]: SECRET }), { secret: SECRET });
    expect(gate.ok).toBe(true);
  });
});

describe("opsSecretLimitKey", () => {
  it("is stable for the same configured secret", () => {
    expect(opsSecretLimitKey("automations", SECRET)).toBe(opsSecretLimitKey("automations", SECRET));
  });

  it("separates scopes and deployments", () => {
    expect(opsSecretLimitKey("automations", SECRET)).not.toBe(
      opsSecretLimitKey("other", SECRET),
    );
    expect(opsSecretLimitKey("automations", SECRET)).not.toBe(
      opsSecretLimitKey("automations", "other"),
    );
  });

  it("never carries the raw secret", () => {
    expect(opsSecretLimitKey("automations", SECRET)).not.toContain(SECRET);
  });
});
