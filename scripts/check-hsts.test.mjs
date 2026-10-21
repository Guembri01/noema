import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { BASE_HEADERS, checkConfig, HSTS_HEADER, SCENARIOS } from "./check-hsts.mjs";

/**
 * B33 — the gate's own regression test.
 *
 * A gate that cannot go red is a gate that passes by accident, so the red
 * states are pinned here: the finding returning (no header at all), the
 * static header (the deployment can no longer turn the header off), and a
 * configuration that drops one of the B61 headers on the way.
 */

/** A configuration that sends the given headers for every path. */
function configWith(headers) {
  return { headers: async () => [{ source: "/:path*", headers }] };
}

/** The B61 map, as a configuration would send it. */
function baseHeaders(extra = []) {
  return [
    { key: "Content-Security-Policy", value: "default-src 'self'" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "accelerometer=()" },
    ...extra,
  ];
}

describe("HSTS gate (scripts/check-hsts.mjs)", () => {
  it("the repository's own configuration passes the gate", async () => {
    const { ok, problems } = await checkConfig(nextConfig);
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it("knows the header it is about and the headers that must survive", () => {
    expect(HSTS_HEADER).toBe("Strict-Transport-Security");
    expect(BASE_HEADERS).toContain("X-Content-Type-Options");
    expect(SCENARIOS.length).toBeGreaterThan(3);
  });

  it("is red when the configuration never sends the header (the finding)", async () => {
    const { ok, problems } = await checkConfig(configWith(baseHeaders()));
    expect(ok).toBe(false);
    expect(problems.join("\n")).toContain("the default (no HSTS_MAX_AGE)");
  });

  it("is red when the header is static (the deployment cannot turn it off)", async () => {
    const { ok, problems } = await checkConfig(
      configWith(baseHeaders([{ key: HSTS_HEADER, value: "max-age=31536000" }])),
    );
    expect(ok).toBe(false);
    expect(problems.join("\n")).toContain("HSTS_MAX_AGE=0 (the documented way out)");
  });

  it("is red when a B61 header is dropped on the way", async () => {
    const { ok, problems } = await checkConfig(
      configWith(baseHeaders().filter((header) => header.key !== "X-Frame-Options")),
    );
    expect(ok).toBe(false);
    expect(problems.join("\n")).toContain("`X-Frame-Options` is missing");
  });

  it("leaves the environment of its caller unchanged", async () => {
    const before = { ...process.env };
    await checkConfig(nextConfig);
    expect(process.env.HSTS_MAX_AGE).toBe(before.HSTS_MAX_AGE);
    expect(process.env.HSTS_INCLUDE_SUBDOMAINS).toBe(before.HSTS_INCLUDE_SUBDOMAINS);
  });
});
