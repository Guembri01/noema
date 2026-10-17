/**
 * Self-hosting readiness engine (§17 Self-hosting: *"Local dev works; packaging
 * pending"* — the pure decision core behind the packaging slice).
 *
 * Nothing here touches the filesystem, the network, Prisma or the real clock.
 * Every function is deterministic and side-effect free: it decides *what* a
 * self-hosted deployment needs, *whether* a given env + service probe set is
 * ready, *what* an `.env` file says, *how* to aggregate a health probe into a
 * status, and *which* capabilities belong to which edition.
 *
 * The pieces fit together as one operator workflow:
 *
 * 1. {@link REQUIRED_ENV} / {@link REQUIRED_SERVICES} describe the contract.
 * 2. {@link checkReadiness} grades a concrete `{ env, services }` pair.
 * 3. {@link validateEnvFile} parses the `.env` an operator actually shipped and
 *    reports unknown / missing / placeholder / weak values.
 * 4. {@link deploymentManifest} emits the machine-readable summary a build or
 *    compose entrypoint can consume.
 * 5. {@link healthPayload} turns runtime dependency probes into the status a
 *    health endpoint (and its compose healthcheck) reports.
 * 6. {@link describeReadiness} renders a one-line operator summary.
 * 7. {@link EDITION_FEATURES} maps capabilities onto the self-hosted vs cloud
 *    editions.
 *
 * Secret *presence* uses a length rule ({@link MIN_SECRET_LENGTH}) rather than
 * mere non-emptiness, and the shared placeholder list rejects the values
 * operators copy from examples (`changeme`, `xxx`, …) — both are exactly the
 * mistakes that turn a green deploy into a plaintext-secret incident.
 *
 * B55: the placeholders this repository *ships* (`.env.example` and the
 * examples below) are in the list as well, and `AUTH_SECRET` carries the
 * stricter length floor of the runtime rule (`src/lib/auth-secret.ts`) — the
 * readiness verdict must not say "ready" for a deployment the app then
 * refuses to sign a session with.
 */

import {
  MIN_AUTH_SECRET_LENGTH,
  SHIPPED_AUTH_SECRET_PLACEHOLDERS,
} from "./auth-secret";

/** Manifest format version; bump when the emitted shape changes. */
export const SELF_HOSTING_MANIFEST_VERSION = 1;

/** Node.js major version the deployment manifest targets. */
export const DEFAULT_NODE_MAJOR = 22;

/** Path the app exposes for liveness/readiness probes. */
export const HEALTHCHECK_PATH = "/api/health";

/** Minimum trimmed length accepted for a value flagged `secret: true`. */
export const MIN_SECRET_LENGTH = 16;

/**
 * Values that look configured but are not. Compared case-insensitively against
 * the trimmed value; `<...>`-wrapped values are matched separately. Empty
 * strings are treated as placeholders by {@link isPlaceholder} too.
 *
 * The first entries are the literals this repository ships (B55) — copying one
 * of them into `.env` is exactly what must not pass as a configured secret.
 */
export const PLACEHOLDER_VALUES: readonly string[] = [
  ...SHIPPED_AUTH_SECRET_PLACEHOLDERS,
  "changeme",
  "change-me",
  "change_me",
  "xxx",
  "xx",
  "todo",
  "tbd",
  "replace-me",
  "replace_me",
  "your-secret-here",
  "placeholder",
  "example",
  "password",
];

/** Functional grouping for an env variable. */
export type EnvScope =
  | "database"
  | "auth"
  | "storage"
  | "ai"
  | "sso"
  | "email"
  | "collab"
  | "ops";

/** One env variable a self-hosted deployment may or must provide. */
export type EnvDescriptor = {
  /** Exact environment variable name, e.g. `DATABASE_URL`. */
  name: string;
  /** True when the app cannot start a healthy deployment without it. */
  required: boolean;
  /** Functional grouping. */
  scope: EnvScope;
  /** True when the value must be treated as sensitive (length rule applies). */
  secret: boolean;
  /**
   * Minimum length of a usable value (secrets only). Defaults to
   * {@link MIN_SECRET_LENGTH}; `AUTH_SECRET` overrides it with the floor of
   * the runtime rule (`src/lib/auth-secret.ts`).
   */
  minLength?: number;
  /** A safe, non-sensitive illustrative value. */
  example: string;
  /** Human-readable explanation of what the variable is for. */
  description: string;
};

/** The full env contract: two required process vars plus the optional surface. */
export const REQUIRED_ENV: readonly EnvDescriptor[] = [
  {
    name: "DATABASE_URL",
    required: true,
    scope: "database",
    secret: true,
    example: "postgresql://noema:noema@localhost:5433/noema?schema=public",
    description: "PostgreSQL connection string used by Prisma.",
  },
  {
    name: "AUTH_SECRET",
    required: true,
    scope: "auth",
    secret: true,
    minLength: MIN_AUTH_SECRET_LENGTH,
    example: "0123456789abcdef0123456789abcdef",
    description: "HS256 key that signs session cookies and derives envelope keys.",
  },
  {
    name: "STORAGE_DIR",
    required: false,
    scope: "storage",
    secret: false,
    example: "./uploads",
    description: "Local upload directory used when S3 is not configured.",
  },
  {
    name: "S3_BUCKET",
    required: false,
    scope: "storage",
    secret: false,
    example: "noema-assets",
    description: "S3-compatible bucket for uploaded files; enables the S3 driver.",
  },
  {
    name: "S3_REGION",
    required: false,
    scope: "storage",
    secret: false,
    example: "us-east-1",
    description: "Region for the S3-compatible bucket.",
  },
  {
    name: "S3_ENDPOINT",
    required: false,
    scope: "storage",
    secret: false,
    example: "https://s3.amazonaws.com",
    description: "S3-compatible endpoint (MinIO, R2, …).",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    required: false,
    scope: "storage",
    secret: true,
    example: "AKIAIOSFODNN7EXAMPLE",
    description: "Access key id for the S3-compatible bucket.",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    required: false,
    scope: "storage",
    secret: true,
    example: "wJalrXUtnFEMI/BK7MDENG/bPxRfiCYEXAMPLEKEY",
    description: "Secret access key for the S3-compatible bucket.",
  },
  {
    name: "S3_PREFIX",
    required: false,
    scope: "storage",
    secret: false,
    example: "noema/",
    description: "Key prefix applied to every object in the bucket.",
  },
  {
    name: "AI_API_KEY",
    required: false,
    scope: "ai",
    secret: true,
    example: "sk-example-0000000000000000",
    description: "API key for the OpenAI-compatible chat provider.",
  },
  {
    name: "AI_BASE_URL",
    required: false,
    scope: "ai",
    secret: false,
    example: "https://api.openai.com/v1",
    description: "Base URL for the OpenAI-compatible chat provider.",
  },
  {
    name: "AI_MODEL",
    required: false,
    scope: "ai",
    secret: false,
    example: "gpt-4o-mini",
    description: "Default chat model name.",
  },
  {
    name: "AI_TRANSCRIBE_API_KEY",
    required: false,
    scope: "ai",
    secret: true,
    example: "sk-example-0000000000000000",
    description: "API key for the speech-to-text provider.",
  },
  {
    name: "AI_TRANSCRIBE_BASE_URL",
    required: false,
    scope: "ai",
    secret: false,
    example: "https://api.openai.com/v1",
    description: "Base URL for the speech-to-text provider.",
  },
  {
    name: "AI_TRANSCRIBE_MODEL",
    required: false,
    scope: "ai",
    secret: false,
    example: "whisper-1",
    description: "Default speech-to-text model name.",
  },
  {
    name: "SSO_ISSUER",
    required: false,
    scope: "sso",
    secret: false,
    example: "https://accounts.example.com",
    description: "OIDC issuer URL; enables single sign-on.",
  },
  {
    name: "SSO_CLIENT_ID",
    required: false,
    scope: "sso",
    secret: false,
    example: "noema",
    description: "OIDC client id.",
  },
  {
    name: "SSO_CLIENT_SECRET",
    required: false,
    scope: "sso",
    secret: true,
    example: "sso-client-secret-value",
    description: "OIDC client secret.",
  },
  {
    name: "SSO_REDIRECT_URI",
    required: false,
    scope: "sso",
    secret: false,
    example: "http://localhost:3000/api/auth/sso/callback",
    description: "OIDC redirect URI registered with the provider.",
  },
  {
    name: "SMTP_HOST",
    required: false,
    scope: "email",
    secret: false,
    example: "smtp.example.com",
    description: "SMTP host used for invitation email.",
  },
  {
    name: "SMTP_PORT",
    required: false,
    scope: "email",
    secret: false,
    example: "587",
    description: "SMTP port.",
  },
  {
    name: "SMTP_SECURE",
    required: false,
    scope: "email",
    secret: false,
    example: "false",
    description: "Whether the SMTP connection uses TLS from the start.",
  },
  {
    name: "SMTP_USER",
    required: false,
    scope: "email",
    secret: false,
    example: "noema@example.com",
    description: "SMTP username.",
  },
  {
    name: "SMTP_PASSWORD",
    required: false,
    scope: "email",
    secret: true,
    example: "smtp-password-value",
    description: "SMTP password.",
  },
  {
    name: "SMTP_FROM",
    required: false,
    scope: "email",
    secret: false,
    example: "noema@example.com",
    description: "From address used for outgoing mail.",
  },
  {
    name: "SMTP_FROM_NAME",
    required: false,
    scope: "email",
    secret: false,
    example: "Noema",
    description: "Display name used for outgoing mail.",
  },
  {
    name: "SMTP_REPLY_TO",
    required: false,
    scope: "email",
    secret: false,
    example: "support@example.com",
    description: "Reply-to address used for outgoing mail.",
  },
  {
    name: "SMTP_ALLOW_SELF_SIGNED",
    required: false,
    scope: "email",
    secret: false,
    example: "false",
    description: "Allow a self-signed TLS certificate for SMTP.",
  },
  {
    name: "NEXT_PUBLIC_COLLAB_URL",
    required: false,
    scope: "collab",
    secret: false,
    example: "ws://localhost:1234",
    description: "WebSocket URL of the realtime collaboration server.",
  },
  {
    name: "CRON_SECRET",
    required: false,
    scope: "ops",
    secret: true,
    example: "cron-secret-value",
    description: "Shared secret required by the cron HTTP endpoint.",
  },
  {
    name: "APP_URL",
    required: false,
    scope: "ops",
    secret: false,
    example: "https://noema.example.com",
    description: "Absolute public URL used in invitation email.",
  },
  {
    name: "APP_ORIGINS",
    required: false,
    scope: "ops",
    secret: false,
    example: "https://noema.example.com",
    description: "Comma-separated allow-list for Server-Action origins.",
  },
];

/** External dependencies a deployment may need to reach. */
export type ServiceKind = "postgres" | "s3" | "smtp" | "redis";

/** One external service in the self-hosting contract. */
export type ServiceDescriptor = {
  /** Stable probe-map key, e.g. `postgres`. */
  name: string;
  /** The kind of dependency. */
  kind: ServiceKind;
  /** True when the app runs without it. */
  optional: boolean;
};

/** The service contract: Postgres required, the rest optional integrations. */
export const REQUIRED_SERVICES: readonly ServiceDescriptor[] = [
  { name: "postgres", kind: "postgres", optional: false },
  { name: "s3", kind: "s3", optional: true },
  { name: "smtp", kind: "smtp", optional: true },
  { name: "redis", kind: "redis", optional: true },
];

/** One problem found while grading a deployment. */
export type ReadinessMiss = {
  /** Env variable name or service name. */
  name: string;
  /** Stable, human-readable reason (includes thresholds where relevant). */
  reason: string;
};

/** A graded readiness report. */
export type ReadinessReport = {
  /** True only when nothing is missing (warnings do not block). */
  ok: boolean;
  /** Blocking problems: required env missing/weak and required services down. */
  missing: ReadinessMiss[];
  /** Non-blocking problems: optional env/service misconfigured or down. */
  warnings: ReadinessMiss[];
  /** Readiness score in `[0, 100]`; 100 when nothing is missing or warned. */
  score: number;
};

/** Input to {@link checkReadiness}. */
export type ReadinessInput = {
  /** The env under test; `undefined` values are treated as absent. */
  env: Record<string, string | undefined>;
  /** Reachability probe per service name; absent means "not probed". */
  services?: Record<string, boolean | undefined>;
};

/** Score penalty applied per blocking {@link ReadinessReport.missing} entry. */
export const MISSING_PENALTY = 12;

/** Score penalty applied per {@link ReadinessReport.warnings} entry. */
export const WARNING_PENALTY = 4;

/** The declared env contract, keyed by name for O(1) lookup. */
const ENV_BY_NAME: ReadonlyMap<string, EnvDescriptor> = new Map(
  REQUIRED_ENV.map((descriptor) => [descriptor.name, descriptor]),
);

/** Runtime variables that are recognised in an `.env` file but are not part of the contract. */
const EXTRA_KNOWN_ENV: ReadonlySet<string> = new Set(["NODE_ENV", "PORT", "HOST", "TZ"]);

/**
 * Whether a trimmed value is a placeholder a real deployment must replace.
 * Empty strings count; so do `<...>`-wrapped tokens.
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return true;
  if (/^<.+>$/.test(trimmed)) return true;
  return PLACEHOLDER_VALUES.includes(trimmed);
}

/**
 * Classify one descriptor against an env map. `null` means the value is present
 * and usable. Otherwise the reason is stable enough to assert on: `missing`,
 * a placeholder citation, or the exact length shortfall for a secret.
 */
function classifyEnvValue(
  descriptor: EnvDescriptor,
  env: Record<string, string | undefined>,
): ReadinessMiss | null {
  const raw = env[descriptor.name];
  if (typeof raw !== "string") return { name: descriptor.name, reason: "missing" };
  const value = raw.trim();
  if (value === "") return { name: descriptor.name, reason: "missing" };
  if (isPlaceholder(value)) {
    return { name: descriptor.name, reason: `placeholder value "${value}"` };
  }
  const minLength = descriptor.minLength ?? MIN_SECRET_LENGTH;
  if (descriptor.secret && value.length < minLength) {
    return {
      name: descriptor.name,
      reason: `too short (${value.length} < ${minLength})`,
    };
  }
  return null;
}

/**
 * Grade a deployment.
 *
 * - A **required** env variable that is absent, empty, a placeholder or a
 *   too-short secret is `missing`.
 * - An **optional** env variable that is *set* but a placeholder or a too-short
 *   secret is a `warning`; absent optional variables are ignored.
 * - A **required** service that is unprobed or reported `false` is `missing`.
 * - An **optional** service reported `false` is a `warning`.
 *
 * `ok` is true exactly when `missing` is empty. Inputs are never mutated.
 */
export function checkReadiness(input: ReadinessInput): ReadinessReport {
  const env = input.env ?? {};
  const services = input.services ?? {};

  const missing: ReadinessMiss[] = [];
  const warnings: ReadinessMiss[] = [];

  for (const descriptor of REQUIRED_ENV) {
    const problem = classifyEnvValue(descriptor, env);
    if (descriptor.required) {
      if (problem) missing.push(problem);
      continue;
    }
    if (problem && env[descriptor.name] !== undefined && problem.reason !== "missing") {
      warnings.push(problem);
    }
  }

  for (const descriptor of REQUIRED_SERVICES) {
    const probe = services[descriptor.name];
    if (probe === undefined) {
      if (!descriptor.optional) {
        missing.push({ name: descriptor.name, reason: "not probed by the provided probe map" });
      }
      continue;
    }
    if (probe === false) {
      const entry: ReadinessMiss = { name: descriptor.name, reason: "unreachable" };
      if (descriptor.optional) warnings.push(entry);
      else missing.push(entry);
    }
  }

  const score = Math.max(
    0,
    Math.min(100, 100 - missing.length * MISSING_PENALTY - warnings.length * WARNING_PENALTY),
  );

  return { ok: missing.length === 0, missing, warnings, score };
}

/** One variable parsed from an `.env` file. */
export type EnvFileLine = {
  key: string;
  value: string;
  /** 1-based source line number. */
  line: number;
};

/** Why a variable in an `.env` file was flagged. */
export type EnvFileIssueKind =
  | "unknown"
  | "missing"
  | "placeholder"
  | "empty"
  | "weak"
  | "invalid";

/** One finding from {@link validateEnvFile}. */
export type EnvFileIssue = {
  key: string;
  kind: EnvFileIssueKind;
  reason: string;
  /** Source line, or `null` for file-level (missing) findings. */
  line: number | null;
};

/** The result of validating an `.env` file. */
export type EnvFileReport = {
  /** True only when there are no issues at all. */
  ok: boolean;
  /** Final parsed value per key (last assignment wins). */
  values: Record<string, string>;
  /** Every parsed assignment, in file order. */
  lines: EnvFileLine[];
  /** Keys that are not part of the contract or the runtime allow-list. */
  unknown: string[];
  /** Required keys absent from the file. */
  missing: string[];
  /** Keys whose value is empty or a literal placeholder. */
  placeholders: string[];
  /** All findings, in file order, with missing findings last. */
  issues: EnvFileIssue[];
};

/** Parse a single raw value, stripping quotes or an unquoted inline comment. */
function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
  if (doubleQuoted || singleQuoted) return value.slice(1, -1);
  const comment = value.indexOf(" #");
  if (comment >= 0) return value.slice(0, comment).trim();
  return value;
}

/**
 * Parse an `.env` string and report what is wrong with it.
 *
 * Recognised lines are `KEY=value` (an `export ` prefix is tolerated); blank
 * lines and `#` comments are skipped; matching quotes are stripped and, for
 * unquoted values, a trailing ` # comment` is removed. Findings are `unknown`
 * keys, `missing` required keys, and per-value `invalid` / `empty` /
 * `placeholder` / `weak` problems.
 */
export function validateEnvFile(text: string): EnvFileReport {
  const lines: EnvFileLine[] = [];
  const values: Record<string, string> = {};
  const issues: EnvFileIssue[] = [];
  const unknownSet = new Set<string>();
  const placeholderSet = new Set<string>();

  const rawLines = typeof text === "string" ? text.split(/\r?\n/) : [];

  rawLines.forEach((raw, index) => {
    const line = index + 1;
    let content = raw.trim();
    if (content === "" || content.startsWith("#")) return;
    if (/^export\s+/.test(content)) content = content.replace(/^export\s+/, "");

    const equals = content.indexOf("=");
    if (equals < 0) {
      issues.push({ key: content, kind: "invalid", reason: "not a KEY=VALUE assignment", line });
      return;
    }

    const key = content.slice(0, equals).trim();
    if (key === "") {
      issues.push({ key: content, kind: "invalid", reason: "empty key", line });
      return;
    }
    const value = parseEnvValue(content.slice(equals + 1));

    lines.push({ key, value, line });
    values[key] = value;

    const descriptor = ENV_BY_NAME.get(key);
    const recognised = descriptor !== undefined || EXTRA_KNOWN_ENV.has(key) || key.startsWith("NEXT_PUBLIC_");
    if (!recognised) {
      if (!unknownSet.has(key)) unknownSet.add(key);
      issues.push({ key, kind: "unknown", reason: "not a recognised variable", line });
      return;
    }

    if (value === "") {
      placeholderSet.add(key);
      issues.push({ key, kind: "empty", reason: "empty value", line });
      return;
    }
    if (isPlaceholder(value)) {
      placeholderSet.add(key);
      issues.push({ key, kind: "placeholder", reason: `placeholder value "${value}"`, line });
      return;
    }
    if (descriptor?.secret) {
      const minLength = descriptor.minLength ?? MIN_SECRET_LENGTH;
      if (value.length < minLength) {
        issues.push({
          key,
          kind: "weak",
          reason: `too short (${value.length} < ${minLength})`,
          line,
        });
      }
    }
  });

  const missing = REQUIRED_ENV.filter((descriptor) => descriptor.required)
    .map((descriptor) => descriptor.name)
    .filter((name) => !(name in values))
    .sort();
  for (const name of missing) {
    issues.push({ key: name, kind: "missing", reason: "required variable is absent", line: null });
  }

  return {
    ok: issues.length === 0,
    values,
    lines,
    unknown: [...unknownSet],
    missing,
    placeholders: [...placeholderSet],
    issues,
  };
}

/** Migration directory names applied by `prisma migrate deploy`, oldest first. */
export const DEPLOYMENT_MIGRATIONS: readonly string[] = ["20260113000000_init"];

/** The machine-readable description of a self-hosted deployment. */
export type DeploymentManifest = {
  /** {@link SELF_HOSTING_MANIFEST_VERSION}. */
  version: number;
  /** Targeted Node.js major version. */
  nodeMajor: number;
  /** Names of the required env variables, sorted. */
  requiredEnv: string[];
  /** Names of the optional env variables that are configured, sorted. */
  optionalEnv: string[];
  /** The service contract. */
  services: ServiceDescriptor[];
  /** Health endpoint path. */
  healthcheckPath: string;
  /** Migrations to apply before the app starts. */
  migrations: string[];
};

/** Input to {@link deploymentManifest}. */
export type DeploymentManifestInput = {
  /** The env that is configured; optional variables present here are listed. */
  env?: Record<string, string | undefined>;
};

/**
 * Emit the deployment manifest for a given env.
 *
 * `requiredEnv` is the full set of required names. `optionalEnv` lists only the
 * optional variables that are actually configured (non-empty) in `env`, so the
 * manifest reflects what the operator has enabled rather than the whole
 * catalogue. Inputs are not mutated.
 */
export function deploymentManifest(input: DeploymentManifestInput = {}): DeploymentManifest {
  const env = input.env ?? {};

  const requiredEnv = REQUIRED_ENV.filter((descriptor) => descriptor.required)
    .map((descriptor) => descriptor.name)
    .sort();
  const optionalEnv = REQUIRED_ENV.filter(
    (descriptor) =>
      !descriptor.required &&
      typeof env[descriptor.name] === "string" &&
      (env[descriptor.name] ?? "").trim() !== "",
  )
    .map((descriptor) => descriptor.name)
    .sort();

  const services: ServiceDescriptor[] = REQUIRED_SERVICES.map((descriptor) => ({ ...descriptor }));

  return {
    version: SELF_HOSTING_MANIFEST_VERSION,
    nodeMajor: DEFAULT_NODE_MAJOR,
    requiredEnv,
    optionalEnv,
    services,
    healthcheckPath: HEALTHCHECK_PATH,
    migrations: [...DEPLOYMENT_MIGRATIONS],
  };
}

/** A dependency's observed health. */
export type HealthState = "up" | "degraded" | "down";

/** A dependency state may be expressed as a boolean for convenience. */
export type HealthInputState = HealthState | boolean;

/** One row of a health payload. */
export type HealthCheck = {
  /** Dependency name (`db`, `storage`, `ai`). */
  name: string;
  state: HealthState;
  /** Convenience flag: true only when `state === "up"`. */
  ok: boolean;
};

/** Aggregated health status: `up`, `degraded` or `down`. */
export type HealthStatus = HealthState;

/** The health payload an endpoint returns. */
export type HealthPayload = {
  status: HealthStatus;
  checks: HealthCheck[];
  /** ISO-8601 timestamp from the injected (or real) clock. */
  checkedAt: string;
};

/** Input to {@link healthPayload}; `db` is mandatory and critical. */
export type HealthInput = {
  db: HealthInputState;
  storage?: HealthInputState;
  ai?: HealthInputState;
  /** Epoch millis or a `Date`; injected for deterministic tests. */
  now?: Date | number;
};

/** Normalise a boolean/detailed dependency state, or `undefined` when absent. */
function toHealthState(value: HealthInputState | undefined): HealthState | undefined {
  if (value === undefined) return undefined;
  if (value === true) return "up";
  if (value === false) return "down";
  return value;
}

/** Resolve an injectable `now` to an ISO string. */
function toIso(now: Date | number | undefined): string {
  const date = now instanceof Date ? now : new Date(typeof now === "number" ? now : Date.now());
  return date.toISOString();
}

/**
 * Aggregate dependency probes into a payload.
 *
 * Aggregation is deliberately asymmetric: a `down` **database** makes the whole
 * deployment `down`, while any other `down` or `degraded` dependency (including
 * a degraded database) makes it `degraded`. Everything `up` is `up`. Only the
 * provided dependencies appear in `checks`, in the fixed order db, storage, ai.
 */
export function healthPayload(input: HealthInput): HealthPayload {
  const entries: Array<{ name: string; state: HealthState | undefined }> = [
    { name: "db", state: toHealthState(input.db) },
    { name: "storage", state: toHealthState(input.storage) },
    { name: "ai", state: toHealthState(input.ai) },
  ];

  const checks: HealthCheck[] = [];
  for (const entry of entries) {
    if (entry.state === undefined) continue;
    checks.push({ name: entry.name, state: entry.state, ok: entry.state === "up" });
  }

  const dbState = toHealthState(input.db) ?? "down";
  let status: HealthStatus;
  if (dbState === "down") {
    status = "down";
  } else if (checks.some((check) => check.state !== "up")) {
    status = "degraded";
  } else {
    status = "up";
  }

  return { status, checks, checkedAt: toIso(input.now) };
}

/**
 * Render a {@link ReadinessReport} as one operator-facing line. The ready and
 * not-ready cases, the score, every missing item and every warning are all
 * present so a log line is actionable on its own.
 */
export function describeReadiness(report: ReadinessReport): string {
  const status = report.ok ? "ready" : "not ready";
  let text = `Self-hosting readiness: ${status} (score ${report.score}/100)`;
  if (report.missing.length > 0) {
    const items = report.missing.map((item) => `${item.name} (${item.reason})`).join(", ");
    text += `. Missing: ${items}`;
  }
  if (report.warnings.length > 0) {
    const items = report.warnings.map((item) => `${item.name} (${item.reason})`).join(", ");
    text += `. Warnings: ${items}`;
  }
  return `${text}.`;
}

/** The two deployment editions. */
export type Edition = "self-hosted" | "cloud";

/** One capability and the editions that include it. */
export type EditionFeature = {
  key: string;
  label: string;
  /** Editions that ship the capability; at least one. */
  editions: readonly Edition[];
};

/**
 * Capability map for the self-hosted vs cloud editions. Self-hosted is the
 * default MIT tree (everything an operator can run themselves); cloud adds the
 * managed-only concerns (billing, managed upgrades) and never takes away a
 * self-hosting capability.
 */
export const EDITION_FEATURES: readonly EditionFeature[] = [
  { key: "self-hosting", label: "Self-hosting", editions: ["self-hosted"] },
  { key: "custom-storage", label: "Custom S3-compatible storage", editions: ["self-hosted"] },
  { key: "billing", label: "Billing & subscriptions", editions: ["cloud"] },
  { key: "managed-upgrades", label: "Managed upgrades", editions: ["cloud"] },
  { key: "collaboration", label: "Realtime collaboration", editions: ["self-hosted", "cloud"] },
  { key: "ai", label: "AI assistance", editions: ["self-hosted", "cloud"] },
  { key: "sso", label: "SSO / OIDC", editions: ["self-hosted", "cloud"] },
  { key: "backup-restore", label: "Backup & restore", editions: ["self-hosted", "cloud"] },
];

/** Whether `edition` ships the capability identified by `key`. */
export function isFeatureInEdition(edition: Edition, key: string): boolean {
  const feature = EDITION_FEATURES.find((candidate) => candidate.key === key);
  return feature !== undefined && feature.editions.includes(edition);
}

/**
 * The capability keys shipped by `edition`, in declaration order. An unknown
 * edition yields an empty list.
 */
export function editionFeatureKeys(edition: Edition): string[] {
  return EDITION_FEATURES.filter((feature) => feature.editions.includes(edition)).map(
    (feature) => feature.key,
  );
}
