import { describe, expect, it } from "vitest";
import { MIN_AUTH_SECRET_LENGTH } from "./auth-secret";
import {
  DEFAULT_NODE_MAJOR,
  EDITION_FEATURES,
  HEALTHCHECK_PATH,
  MIN_SECRET_LENGTH,
  REQUIRED_ENV,
  REQUIRED_SERVICES,
  SELF_HOSTING_MANIFEST_VERSION,
  checkReadiness,
  deploymentManifest,
  describeReadiness,
  editionFeatureKeys,
  healthPayload,
  isFeatureInEdition,
  validateEnvFile,
  type Edition,
  type EnvDescriptor,
  type HealthState,
  type ServiceDescriptor,
} from "./self-hosting";

/**
 * Self-hosting readiness engine (§17 Self-hosting, "packaging pending").
 *
 * Red-first: this file was written BEFORE `src/lib/self-hosting.ts` existed, so
 * every import resolved to module-not-found and the suite failed to collect.
 * It pins the pure, deterministic contract a self-host operator can rely on:
 * env/service descriptors, a readiness check with length + placeholder rules, a
 * deployment manifest, an `.env` file validator, a health aggregation and an
 * edition/feature map.
 */

/** A complete, healthy env for the two required descriptors. */
const GOOD_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://noema:noema@localhost:5433/noema?schema=public",
  AUTH_SECRET: "4f8a1c9e2b7d3056f8a1c9e2b7d3056f4f8a1c9e2b7d3056f8a1c9e2b7d3056f",
};

/** Probe map where every declared service is reachable. */
const GOOD_PROBES: Record<string, boolean> = {
  postgres: true,
  s3: true,
  smtp: true,
  redis: true,
};

const names = (descriptors: readonly EnvDescriptor[]): string[] =>
  descriptors.map((entry) => entry.name);

const serviceNames = (descriptors: readonly ServiceDescriptor[]): string[] =>
  descriptors.map((entry) => entry.name);

describe("REQUIRED_ENV descriptors", () => {
  it("is a non-empty list of well-formed descriptors", () => {
    expect(REQUIRED_ENV.length).toBeGreaterThan(0);
    for (const descriptor of REQUIRED_ENV) {
      expect(descriptor.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(descriptor.example).not.toBe("");
      expect(descriptor.description).not.toBe("");
      expect(typeof descriptor.required).toBe("boolean");
      expect(typeof descriptor.secret).toBe("boolean");
      expect(typeof descriptor.scope).toBe("string");
    }
  });

  it("has unique names", () => {
    const list = names(REQUIRED_ENV);
    expect(new Set(list).size).toBe(list.length);
  });

  it("treats DATABASE_URL and AUTH_SECRET as required secrets", () => {
    const db = REQUIRED_ENV.find((entry) => entry.name === "DATABASE_URL");
    const auth = REQUIRED_ENV.find((entry) => entry.name === "AUTH_SECRET");
    expect(db).toBeDefined();
    expect(auth).toBeDefined();
    expect(db?.required).toBe(true);
    expect(db?.secret).toBe(true);
    expect(auth?.required).toBe(true);
    expect(auth?.secret).toBe(true);
  });

  it("marks the documented process secrets as secrets", () => {
    const secrets = REQUIRED_ENV.filter((entry) => entry.secret).map((entry) => entry.name);
    for (const expected of [
      "AUTH_SECRET",
      "SSO_CLIENT_SECRET",
      "SMTP_PASSWORD",
      "CRON_SECRET",
      "AI_API_KEY",
    ]) {
      expect(secrets).toContain(expected);
    }
  });

  it("includes the storage and AI variables the app actually reads", () => {
    const list = names(REQUIRED_ENV);
    for (const expected of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "AI_API_KEY", "SMTP_HOST"]) {
      expect(list).toContain(expected);
    }
  });
});

describe("REQUIRED_SERVICES descriptors", () => {
  it("requires postgres and leaves the rest optional", () => {
    const postgres = REQUIRED_SERVICES.find((entry) => entry.name === "postgres");
    expect(postgres).toBeDefined();
    expect(postgres?.kind).toBe("postgres");
    expect(postgres?.optional).toBe(false);

    for (const optional of ["s3", "smtp", "redis"]) {
      const entry = REQUIRED_SERVICES.find((candidate) => candidate.name === optional);
      expect(entry?.optional).toBe(true);
    }
  });

  it("uses only known service kinds and unique names", () => {
    const allowed = new Set(["postgres", "s3", "smtp", "redis"]);
    const list = serviceNames(REQUIRED_SERVICES);
    expect(new Set(list).size).toBe(list.length);
    for (const descriptor of REQUIRED_SERVICES) {
      expect(allowed.has(descriptor.kind)).toBe(true);
    }
  });

  it("declares exactly one service per kind", () => {
    const kinds = REQUIRED_SERVICES.map((entry) => entry.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("checkReadiness", () => {
  it("reports a fully configured deployment as ready with a perfect score", () => {
    const report = checkReadiness({ env: GOOD_ENV, services: GOOD_PROBES });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("flags a missing required variable", () => {
    const report = checkReadiness({ env: { AUTH_SECRET: GOOD_ENV.AUTH_SECRET } });
    expect(report.ok).toBe(false);
    const entry = report.missing.find((item) => item.name === "DATABASE_URL");
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain("missing");
  });

  it("flags a missing required secret by name", () => {
    const report = checkReadiness({ env: { DATABASE_URL: GOOD_ENV.DATABASE_URL } });
    expect(report.ok).toBe(false);
    expect(report.missing.map((item) => item.name)).toContain("AUTH_SECRET");
  });

  it("treats a too-short secret as missing, citing the length rule", () => {
    const report = checkReadiness({ env: { ...GOOD_ENV, AUTH_SECRET: "short" } });
    const entry = report.missing.find((item) => item.name === "AUTH_SECRET");
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain("short");
    expect(entry?.reason).toContain(String(MIN_AUTH_SECRET_LENGTH));
  });

  it("rejects placeholder secret values", () => {
    const report = checkReadiness({ env: { ...GOOD_ENV, AUTH_SECRET: "changeme" } });
    const entry = report.missing.find((item) => item.name === "AUTH_SECRET");
    expect(entry).toBeDefined();
    expect(entry?.reason.toLowerCase()).toContain("placeholder");
  });

  it("does not treat an empty required value as present", () => {
    const report = checkReadiness({ env: { ...GOOD_ENV, DATABASE_URL: "   " } });
    expect(report.missing.map((item) => item.name)).toContain("DATABASE_URL");
  });

  it("warns (without failing) about a weak or placeholder optional value", () => {
    const report = checkReadiness({
      env: { ...GOOD_ENV, SMTP_PASSWORD: "changeme", AI_API_KEY: "short" },
      services: GOOD_PROBES,
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings.map((item) => item.name)).toEqual(
      expect.arrayContaining(["SMTP_PASSWORD", "AI_API_KEY"]),
    );
    expect(report.score).toBeLessThan(100);
    expect(report.score).toBeGreaterThanOrEqual(0);
  });

  it("flags a required service that was never probed", () => {
    const report = checkReadiness({ env: GOOD_ENV, services: { s3: true } });
    const entry = report.missing.find((item) => item.name === "postgres");
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain("probe");
  });

  it("flags a required service reported down", () => {
    const report = checkReadiness({ env: GOOD_ENV, services: { ...GOOD_PROBES, postgres: false } });
    const entry = report.missing.find((item) => item.name === "postgres");
    expect(entry?.reason).toContain("unreachable");
  });

  it("warns about an optional service reported down", () => {
    const report = checkReadiness({ env: GOOD_ENV, services: { ...GOOD_PROBES, redis: false } });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((item) => item.name)).toContain("redis");
    expect(report.missing.map((item) => item.name)).not.toContain("redis");
  });

  it("lowers the score as problems accumulate and clamps at zero", () => {
    const healthy = checkReadiness({ env: GOOD_ENV, services: GOOD_PROBES });
    const broken = checkReadiness({
      env: { AUTH_SECRET: "x", SMTP_PASSWORD: "changeme", AI_API_KEY: "short" },
      services: { postgres: false, redis: false },
    });
    expect(broken.score).toBeLessThan(healthy.score);
    expect(broken.score).toBeGreaterThanOrEqual(0);
    expect(broken.score).toBeLessThanOrEqual(100);
  });

  it("accepts missing/empty input without throwing", () => {
    const report = checkReadiness({ env: {} });
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("does not mutate the provided env or probes", () => {
    const env = { ...GOOD_ENV, SMTP_PASSWORD: "changeme" };
    const snapshot = { ...env };
    const services = { ...GOOD_PROBES };
    checkReadiness({ env, services });
    expect(env).toEqual(snapshot);
    expect(services).toEqual(GOOD_PROBES);
  });
});

describe("validateEnvFile", () => {
  const FILE = [
    "# Noema environment",
    "",
    "DATABASE_URL=postgresql://noema:noema@localhost:5433/noema",
    'AUTH_SECRET="4f8a1c9e2b7d3056f8a1c9e2b7d3056f4f8a1c9e2b7d3056f8a1c9e2b7d3056f"',
    "SMTP_HOST=smtp.example.com",
  ].join("\n");

  it("parses keys and values, stripping surrounding quotes", () => {
    const report = validateEnvFile(FILE);
    expect(report.values.DATABASE_URL).toBe("postgresql://noema:noema@localhost:5433/noema");
    expect(report.values.AUTH_SECRET).toBe(
      "4f8a1c9e2b7d3056f8a1c9e2b7d3056f4f8a1c9e2b7d3056f8a1c9e2b7d3056f",
    );
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("records line numbers and ignores comments/blank lines", () => {
    const report = validateEnvFile(FILE);
    const auth = report.lines.find((line) => line.key === "AUTH_SECRET");
    expect(auth?.line).toBe(4);
    expect(report.lines).toHaveLength(3);
  });

  it("accepts an `export` prefix", () => {
    const report = validateEnvFile(
      "export DATABASE_URL=postgresql://noema@db\nAUTH_SECRET=4f8a1c9e2b7d3056f8a1c9e2b7d3056f",
    );
    expect(report.values.DATABASE_URL).toBe("postgresql://noema@db");
    expect(report.values.AUTH_SECRET).toBe(
      "4f8a1c9e2b7d3056f8a1c9e2b7d3056f",
    );
    expect(report.ok).toBe(true);
  });

  it("preserves `=` characters inside a value", () => {
    const report = validateEnvFile("DATABASE_URL=postgresql://x?schema=public&sslmode=require");
    expect(report.values.DATABASE_URL).toBe("postgresql://x?schema=public&sslmode=require");
  });

  it("reports unknown keys", () => {
    const report = validateEnvFile("NOT_A_REAL_KEY=1");
    expect(report.unknown).toContain("NOT_A_REAL_KEY");
    expect(report.ok).toBe(false);
    const issue = report.issues.find((entry) => entry.key === "NOT_A_REAL_KEY");
    expect(issue?.kind).toBe("unknown");
  });

  it("reports missing required keys", () => {
    const report = validateEnvFile("SMTP_HOST=smtp.example.com");
    expect(report.missing.sort()).toEqual(["AUTH_SECRET", "DATABASE_URL"]);
  });

  it("reports placeholder and empty values", () => {
    const report = validateEnvFile(
      ["DATABASE_URL=changeme", "AUTH_SECRET=", "SMTP_HOST=xxx"].join("\n"),
    );
    expect(report.placeholders).toEqual(
      expect.arrayContaining(["DATABASE_URL", "AUTH_SECRET", "SMTP_HOST"]),
    );
    const kinds = report.issues
      .filter((entry) => entry.key !== "AUTH_SECRET" || entry.kind !== "missing")
      .map((entry) => entry.kind);
    expect(kinds).toContain("placeholder");
    expect(kinds).toContain("empty");
  });

  it("reports a weak secret value", () => {
    const report = validateEnvFile(["DATABASE_URL=postgresql://db", "AUTH_SECRET=short"].join("\n"));
    const issue = report.issues.find((entry) => entry.key === "AUTH_SECRET");
    expect(issue?.kind).toBe("weak");
  });

  it("flags a malformed line as invalid", () => {
    const report = validateEnvFile("this is not an assignment");
    expect(report.ok).toBe(false);
    expect(report.issues.some((entry) => entry.kind === "invalid")).toBe(true);
  });

  it("lets the last assignment of a key win", () => {
    const report = validateEnvFile("DATABASE_URL=first\nDATABASE_URL=second");
    expect(report.values.DATABASE_URL).toBe("second");
  });
});

describe("deploymentManifest", () => {
  it("returns the format version, node major, healthcheck path and migrations", () => {
    const manifest = deploymentManifest({ env: GOOD_ENV });
    expect(manifest.version).toBe(SELF_HOSTING_MANIFEST_VERSION);
    expect(manifest.nodeMajor).toBe(DEFAULT_NODE_MAJOR);
    expect(manifest.healthcheckPath).toBe(HEALTHCHECK_PATH);
    expect(manifest.healthcheckPath).toBe("/api/health");
    expect(manifest.migrations.length).toBeGreaterThan(0);
    expect(manifest.migrations.every((name) => typeof name === "string" && name !== "")).toBe(true);
  });

  it("lists every required env name, sorted", () => {
    const manifest = deploymentManifest({ env: GOOD_ENV });
    const required = REQUIRED_ENV.filter((entry) => entry.required).map((entry) => entry.name);
    expect(manifest.requiredEnv).toEqual([...required].sort());
    expect(manifest.requiredEnv).toContain("DATABASE_URL");
  });

  it("lists only the optional env names that are configured", () => {
    const empty = deploymentManifest({ env: {} });
    expect(empty.optionalEnv).toEqual([]);

    const manifest = deploymentManifest({ env: { ...GOOD_ENV, SMTP_HOST: "smtp.example.com" } });
    expect(manifest.optionalEnv).toEqual(["SMTP_HOST"]);
  });

  it("exposes the service descriptors verbatim", () => {
    const manifest = deploymentManifest({ env: GOOD_ENV });
    expect(manifest.services).toEqual([...REQUIRED_SERVICES]);
  });

  it("does not mutate its input env", () => {
    const env = { ...GOOD_ENV };
    const snapshot = { ...env };
    deploymentManifest({ env });
    expect(env).toEqual(snapshot);
  });
});

describe("healthPayload", () => {
  it("is up when every dependency is up", () => {
    const payload = healthPayload({ db: "up", storage: "up", ai: "up" });
    expect(payload.status).toBe("up");
    expect(payload.checks.map((check) => check.name)).toEqual(["db", "storage", "ai"]);
    expect(payload.checks.every((check) => check.ok)).toBe(true);
  });

  it("is down when the database is down", () => {
    const payload = healthPayload({ db: "down", storage: "up" });
    expect(payload.status).toBe("down");
    expect(payload.checks.find((check) => check.name === "db")?.ok).toBe(false);
  });

  it("degrades (not down) when storage is degraded", () => {
    const payload = healthPayload({ db: "up", storage: "degraded", ai: "up" });
    expect(payload.status).toBe("degraded");
    expect(payload.checks.find((check) => check.name === "storage")?.state).toBe("degraded");
  });

  it("degrades when a non-critical dependency is down", () => {
    const payload = healthPayload({ db: "up", storage: "up", ai: "down" });
    expect(payload.status).toBe("degraded");
  });

  it("accepts boolean dependency states", () => {
    expect(healthPayload({ db: true }).status).toBe("up");
    expect(healthPayload({ db: false }).status).toBe("down");
  });

  it("omits dependencies that were not provided", () => {
    const payload = healthPayload({ db: "up" });
    expect(payload.checks.map((check) => check.name)).toEqual(["db"]);
  });

  it("stamps checkedAt from the injected clock", () => {
    const payload = healthPayload({ db: "up", now: new Date("2026-01-02T03:04:05.000Z") });
    expect(payload.checkedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("describeReadiness", () => {
  it("summarises a ready deployment", () => {
    const text = describeReadiness(checkReadiness({ env: GOOD_ENV, services: GOOD_PROBES }));
    expect(text.toLowerCase()).toContain("ready");
    expect(text).toContain("100");
  });

  it("names the missing items and the score when not ready", () => {
    const text = describeReadiness(checkReadiness({ env: {} }));
    expect(text.toLowerCase()).toContain("not ready");
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("AUTH_SECRET");
  });

  it("mentions warnings without calling the deployment unready", () => {
    const text = describeReadiness(
      checkReadiness({ env: { ...GOOD_ENV, SMTP_PASSWORD: "changeme" }, services: GOOD_PROBES }),
    );
    expect(text.toLowerCase()).toContain("warning");
    expect(text).toContain("SMTP_PASSWORD");
  });
});

describe("EDITION_FEATURES", () => {
  it("maps features to one or both editions with unique keys", () => {
    const keys = EDITION_FEATURES.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const feature of EDITION_FEATURES) {
      expect(feature.editions.length).toBeGreaterThan(0);
      expect(feature.label).not.toBe("");
      for (const edition of feature.editions) {
        expect(["self-hosted", "cloud"]).toContain(edition);
      }
    }
  });

  it("marks self-hosting itself as a self-hosted-only capability", () => {
    expect(isFeatureInEdition("self-hosted", "self-hosting")).toBe(true);
    expect(isFeatureInEdition("cloud", "self-hosting")).toBe(false);
  });

  it("marks billing as cloud-only", () => {
    expect(isFeatureInEdition("cloud", "billing")).toBe(true);
    expect(isFeatureInEdition("self-hosted", "billing")).toBe(false);
  });

  it("lists the feature keys for an edition", () => {
    const selfHosted = editionFeatureKeys("self-hosted");
    expect(selfHosted).toContain("self-hosting");
    expect(selfHosted).not.toContain("billing");
    expect(editionFeatureKeys("cloud")).toContain("billing");
  });

  it("returns an empty list for an unknown edition", () => {
    expect(editionFeatureKeys("nonsense" as Edition)).toEqual([]);
  });

  it("treats every declared edition as a valid key", () => {
    const editions: Edition[] = ["self-hosted", "cloud"];
    for (const edition of editions) {
      expect(editionFeatureKeys(edition).length).toBeGreaterThan(0);
    }
  });
});

describe("constants", () => {
  it("pins the documented defaults", () => {
    expect(SELF_HOSTING_MANIFEST_VERSION).toBe(1);
    expect(DEFAULT_NODE_MAJOR).toBe(22);
    expect(HEALTHCHECK_PATH).toBe("/api/health");
    expect(MIN_SECRET_LENGTH).toBeGreaterThanOrEqual(16);
  });

  it("keeps health states exhaustive", () => {
    const states: HealthState[] = ["up", "degraded", "down"];
    for (const state of states) {
      expect(healthPayload({ db: state }).status).toBe(state === "down" ? "down" : state);
    }
  });
});
