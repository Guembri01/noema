#!/usr/bin/env node
/**
 * Secret gate: no credential may be committed, and no `.env` may be tracked.
 *
 * Why this exists: Noema ships as open source, so whatever is in the tree is
 * published as-is. A single `git add .env`, or a live key pasted into a fixture,
 * is permanent and public the moment it lands — git history does not forget.
 * This gate runs over **every tracked file** and fails with the exact
 * `file:line`, so the mistake is caught in the inner loop instead of on GitHub.
 *
 * The patterns are deliberately value-shaped rather than entropy-shaped: the
 * formats real providers actually issue, a connection string that carries a
 * password, a JWT, a private-key block, plus `NAME=<12+ chars>` for the
 * variables this app reads. That keeps false positives near zero, which is what
 * makes the gate worth running in CI: the CI runs it on every push and every
 * pull request, and whether a red run blocks a merge is the repository's
 * branch-protection setting, not a property of this script. Known-safe
 * documentation examples are listed in {@link ALLOWED} rather than matched by a
 * looser rule that would hide a real key too.
 *
 *   npm run check:secrets
 *   node scripts/check-secrets.mjs --root <dir>   # scan another directory
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `--root <dir>` scans another directory instead of the repository — the test
 * harness uses it to run the gate over a throw-away fixture.
 */
function rootFromArgs(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return REPO_ROOT;
  const target = argv[index + 1];
  if (!target) {
    console.error("check-secrets: --root needs a directory");
    process.exit(1);
  }
  return resolve(target);
}

const ROOT = rootFromArgs(process.argv.slice(2));

/** Files whose whole point is to contain secret-shaped strings. */
const SKIP = [/(^|\/)\.env\.example$/];
/** A test or spec file — a fixture may carry a documented dummy (B34). */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The path of the gate itself — the allow lists below are written in it. */
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, "/");

/**
 * The env var names this app reads, plus the usual suspects. The name alone is
 * never a finding — the value behind it has to look like a credential.
 */
const CONFIGURED_SECRET_NAMES = [
  // read by this app
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "AI_TRANSCRIBE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AUTH_SECRET",
  "AUTH_PASSWORD",
  "CRON_SECRET",
  "READY_SECRET",
  "NOTION_API_KEY",
  "NOTION_TOKEN",
  "PGPASSWORD",
  "S3_SECRET_ACCESS_KEY",
  "SMTP_PASSWORD",
  "SSO_CLIENT_SECRET",
  // the usual suspects
  "ACCESS_TOKEN",
  "API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "BOT_TOKEN",
  "CLIENT_SECRET",
  "DATABASE_PASSWORD",
  "DATADOG_API_KEY",
  "DB_PASSWORD",
  "DOPPLER_TOKEN",
  "ENCRYPTION_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "JWT_SECRET",
  "MONGO_PASSWORD",
  "MYSQL_PASSWORD",
  "NEXTAUTH_SECRET",
  "NPM_TOKEN",
  "PASSWORD",
  "PASSWD",
  "POSTGRES_PASSWORD",
  "PRIVATE_KEY",
  "REDIS_PASSWORD",
  "REFRESH_TOKEN",
  "SECRET",
  "SENDGRID_API_KEY",
  "SENTRY_DSN",
  "SESSION_SECRET",
  "SIGNING_KEY",
  "SLACK_TOKEN",
  "STRIPE_SECRET_KEY",
  "TOKEN",
  "TWILIO_AUTH_TOKEN",
  "WEBHOOK_SECRET",
].join("|");

/** Provider formats, plus the env var names this app reads. */
const PATTERNS = [
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "OpenAI / DeepSeek key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "AWS secret access key",
    // The key is 40 base64 characters. The name is matched case-insensitively
    // so the lower-case spelling (`aws_secret_access_key`) is caught too.
    re: /\b(aws_secret_access_key)\b\s*[:=]\s*(?:"([A-Za-z0-9/+=]{40})"|'([A-Za-z0-9/+=]{40})'|([A-Za-z0-9/+=]{40}))/gi,
  },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { name: "Doppler token", re: /\bdop_v1_[A-Za-z0-9]{20,}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Slack app token", re: /\bxapp-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  // RSA, EC, OPENSSH, PGP (`PRIVATE KEY BLOCK`) and ENCRYPTED PRIVATE KEY.
  // A certificate is public and stays out.
  { name: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g },
  {
    name: "connection string with password",
    // A URL whose userinfo carries a password — the password is what makes it
    // a secret, so a URL without one does not match. A masked password is a
    // redaction, not a credential.
    re: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s@]*)?:(?!\*+@)[^\s@]+@[^\s"'`\\]*[A-Za-z0-9]/g,
  },
  {
    name: "configured secret value",
    // Quoted values of any shape, or bare values that look issued rather than
    // referenced: at least 12 chars, at least one digit, and not a call
    // (`ensureAuthSecret()`), so `process.env.AUTH_SECRET = ensureAuthSecret()`
    // is code and `AUTH_SECRET="4f59…"` is a credential.
    re: new RegExp(
      `\\b(${CONFIGURED_SECRET_NAMES})\\s*[:=]\\s*(?:"([^"\\n]{12,})"|'([^'\\n]{12,})'|((?=[A-Za-z0-9_\\-/+]*\\d)[A-Za-z0-9_\\-/+]{12,}(?![A-Za-z0-9_\\-/+.]*[ \\t]*\\()))`,
      "g",
    ),
  },
  {
    name: "password value",
    // A password needs no digit to be a password: `supersecretpassword` is
    // one. Only the password-ish names are matched — `secret` and `token` are
    // design-system words in this repo (`token: "var(--dur-1)"`), so they would
    // drown the gate in false positives; their env-var spellings
    // (`AUTH_SECRET`, `GITHUB_TOKEN`) are in CONFIGURED_SECRET_NAMES.
    re: /\b(password|passwd|pwd|passphrase)\s*[:=]\s*(?:"([^"\n]{12,})"|'([^'\n]{12,})'|([A-Za-z0-9_\-/+]{12,}(?![A-Za-z0-9_\-/+.]*[ \t]*\()))/gi,
  },
];

/**
 * Literals that are documentation, not credentials. Kept as an exact list: a
 * wildcard here would also excuse the real thing.
 */
const ALLOWED = new Set([
  "AKIAIOSFODNN7EXAMPLE", // AWS's own docs example, used by src/lib/self-hosting.ts
  "sk-example-0000000000000000", // src/lib/self-hosting.ts placeholder
  "ci-only-secret-not-used-in-production-000000", // .github/workflows/site.yml
  "b74-build-time-dummy-secret-not-a-real-key", // Dockerfile build-time dummy
  "unit-test-auth-secret-0123456789", // scripts/collab-server.test.mjs fixture
  "REDACTED_PLACEHOLDER", // src/lib/secrets.ts, the redaction marker itself
  // Connection strings the tree uses as examples. Every one of them is a
  // documented dummy — the value in front of the colon is a placeholder.
  "postgresql://user:pass@127.0.0.1:5432/noema", // .github/workflows/ci.yml
  "postgresql://noema:noema@127.0.0.1:5432/noema", // .github/workflows/ci.yml
  "postgresql://noema:dummy@127.0.0.1:5432/noema?schema=public", // .github/workflows/desktop.yml
  "postgresql://noema:noema@127.0.0.1:5432/noema?schema=public", // .github/workflows/desktop.yml, site.yml
  "postgresql://noema:noema@host.docker.internal:5432/noema?schema=public", // .github/workflows/site.yml, docs/DOCKER.md
  "postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public", // Dockerfile build-time dummy
  "postgresql://noema:noema@db:5432/noema?schema=public", // docker-compose.yml
  "postgresql://noema:noema@noema-db:5432/noema?schema=public", // docs/DOCKER.md
  "postgresql://postgres:postgres@127.0.0.1:5432/noema", // docs/DESKTOP.md
  "postgresql://postgres:postgres@127.0.0.1:5432/noema?schema=public", // scripts/desktop/boot-wrapper.cjs
  "postgresql://postgres:postgres@127.0.0.1:<port>/postgres?pgbouncer=true&connection_limit=1", // docs/DESKTOP.md
  "postgresql://noema:noema@localhost:5433/noema?schema=public", // src/lib/self-hosting.ts
  "postgresql://${USER}:${USER}@localhost:5433/${DATABASE}?schema=public", // scripts/check-payload-features.mjs
  "postgresql://${DB_USER}:${DB_USER}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1&pgbouncer=true", // scripts/desktop/embedded-db.cjs
  "postgresql://${DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}?schema=public", // scripts/desktop/docker-db.cjs
  "postgresql://user:password@127.0.0.1:5432/noema", // src-tauri/dist/index.html placeholder
  "postgresql://u:p@host:5432/db?schema=public", // src-tauri/src/state.rs fixture
  "postgresql://user:pw@host:5432/db", // src/lib/secrets.ts, the masking example
  "postgresql://user:pw@host/db", // src/lib/redaction.ts, the shape of a connection string in a comment
  "postgresql://noema:sup3r-secret@db.example.com:5432/noema?schema=public", // src-tauri/src/commands.rs, the redaction fixture
  // The database URL of the embedded engine. The password is a template — the
  // launch's own random one — and the host is the loopback.
  "postgresql://${DB_USER}:${password}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1&pgbouncer=true", // scripts/desktop/embedded-db.cjs
  "postgresql://postgres:<password>@127.0.0.1:<port>/postgres?pgbouncer=true&connection_limit=1", // docs/DESKTOP.md
  // The database password comes from `.env` (B09). These are the shapes that
  // carry it — a mandatory interpolation and a placeholder. None of them is a
  // value that works: the interpolation asks Compose to refuse the start, the
  // placeholder has to be replaced by the operator.
  "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required - copy .env.example to .env and set it}", // docker-compose.yml
  "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}", // scripts/check-compose-exposure.test.mjs fixture
  "${POSTGRES_PASSWORD:-noema}", // scripts/check-compose-exposure.test.mjs fixture — the default form the gate must reject
  "postgresql://noema:<POSTGRES_PASSWORD>@localhost:5433/noema?schema=public", // .env.example, scripts/check-compose-exposure.test.mjs
  "postgresql://${USER}:${encodeURIComponent(password)}@localhost:5433/${DATABASE}?schema=public", // scripts/check-payload-features.mjs
  "postgresql://noema:sup3r-secret@db.example.com:5432/noema", // src-tauri/src/commands.rs — the redaction fixture (an earlier revision)
  "sk-proj-0123456789abcdef", // src/lib/ai-provider.error.test.ts — a fixture of an earlier revision
  "postgresql://${DB_USER}:${DB_USER}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1", // scripts/desktop/embedded-db.cjs — an earlier revision
  "b85-proof-secret", // scripts/_b85-redproof.mjs — a deleted proof script, only in the history
]);

const ALLOWED_IN_TESTS = new Set([
  "sk-live-abcdef1234567890", // src/app/api/ai/*.test.ts, src/lib/ai-provider.error.test.ts
  "sk-transcribe-abcdef1234567890", // src/app/api/ai/transcribe/route.test.ts
  "sk-proj-zzzzzzzzzzzzzzzz", // src/lib/ai-provider.error.test.ts
  "sk-live-abcdefghijklmno", // src/lib/error-reporting.test.ts, src/lib/error-tracking.test.ts
  "sk-live-abcdefghijklmnop", // src/lib/observability.test.ts, src/lib/redaction.test.ts
  "postgresql://noema:pw@localhost:5433/noema", // src/lib/observability.test.ts
  "postgresql://noema:supersecretpw@localhost:5433/noema", // src/lib/redaction.test.ts
  "whsec-inbound-rules-fixture", // src/app/api/webhooks/inbound/route.rules.test.ts
  "postgresql://noema:${encodeURIComponent(password)}@127.0.0.1:5434/noema?schema=public", // scripts/desktop/docker-db.test.mjs
  "b39-unit-secret-0123456789abcdef", // src/lib/auth-session-idle-timeout.test.ts
  "b39-two-factor-test-secret-0123456789", // src/server/actions/two-factor-revoke-sessions.test.ts
  "RECIPIENT_PASSWORD", // src/server/actions/ownership-transfer-actions.test.ts — a constant, not a secret
  "not-the-password", // src/server/actions/ownership-transfer-actions.test.ts — the wrong password
  "sk-live-9f2c7a4b8e1d6205cafebabe", // src/lib/secrets.test.ts
  "sk-ant-api03-DEADBEEFcafe", // src/lib/secrets.test.ts
  "ghp_abcdefghijklmnopqrstuvwx", // src/lib/ai-provider.error.test.ts
  "ghp_abcdefghijklmnopqrstuvwxyz01", // src/lib/error-reporting.test.ts, src/lib/error-tracking.test.ts
  "xoxb-123456789012-abcdefghijkl", // src/lib/error-reporting.test.ts, src/lib/error-tracking.test.ts
  "test-secret-for-the-ai-route-suite", // src/app/api/ai/route.provider.test.ts
  "test-secret-for-the-ai-workspace-suite", // src/lib/ai-provider.workspace.test.ts
  "test-secret-for-share-page-tests", // src/app/s/[token]/page.test.ts
  "test-secret-for-share-unlock-tests", // src/app/s/[token]/unlock/route.test.ts
  "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e", // src/app/api/ai/route.workspace.test.ts
  "492ab3e1125d19ee06fc1f72772e35ebbfd522c4953da50ab325e03cd5956d49", // src/lib/auth-secret.test.ts
  "4f8a1c9e2b7d3056f8a1c9e2b7d3056f4f8a1c9e2b7d3056f8a1c9e2b7d3056f", // src/lib/self-hosting.test.ts
  "0123456789abcdef0123456789abcdef", // src/lib/self-hosting.test.ts (an earlier revision)
  "b54-unit-secret-0123456789abcdef", // src/lib/auth-sessions.test.ts
  "b54-unit-secret-0123456789", // src/lib/auth-sessions.test.ts (an earlier revision)
  "b85-a-completely-different-secret", // src/lib/secrets.test.ts
  "webhook-secret-test-key-0123456789", // src/lib/webhooks-secret.test.ts
  "webhook-secret-test-key", // src/lib/webhooks-secret.test.ts (an earlier revision)
  "webhook-ssrf-test-key-0123456789ab", // src/server/actions/webhooks.test.ts
  "webhook-ssrf-test-key", // src/server/actions/webhooks.test.ts (an earlier revision)
  "auth-test-secret-for-the-two-factor-gate", // src/server/actions/auth*.test.ts
  "auth-test-secret-for-two-factor-0123", // src/server/actions/auth.test.ts
  "auth-test-secret-for-two-factor", // src/server/actions/auth.test.ts (an earlier revision)
  "b05-two-factor-test-secret-0123456789", // src/server/actions/two-factor-secret.test.ts
  "b05-two-factor-test-secret", // src/server/actions/two-factor-secret.test.ts (an earlier revision)
  "B95-2fa-passw0rd!", // e2e/auth-2fa.spec.ts
  "memberPassword", // e2e/inbox.spec.ts
  "B54-parole-123!", // e2e/sessions-parity.spec.ts
  "test-secret-that-is-long-enough-for-the-rule", // src/app/api/ai/route.workspace.test.ts
  "cron-test-secret", // src/app/api/cron/backups/route.test.ts
  "cron-digest-secret", // src/app/api/cron/digest/route.test.ts
  "postgres://user:pass@localhost:5432/noema", // src/app/api/ops-gate-order.test.ts
  "noema_scope_test_token", // src/app/api/v1/scope-enforcement.test.ts
  "inbound-webhook-test-key-0123456789abcdef", // src/app/api/webhooks/inbound/route.test.ts
  "whsec-inbound-fixture-value", // src/app/api/webhooks/inbound/route.test.ts
  "client-secret", // src/app/oauth/token/route.grant.test.ts
  "client-secret-plaintext", // src/app/oauth/token/route.hash.test.ts
  "share-token-abc", // src/app/s/[token]/page.test.ts
  "correct-horse-battery-staple", // src/app/s/[token]/unlock/route.test.ts
  "JBSWY3DPEHPK3PXP", // src/components/two-factor-manager.test.ts
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature", // src/lib/ai-provider.error.test.ts
  "noema_api_auth_test_token", // src/lib/api-auth.scopes.test.ts
  "old-secret-value", // src/lib/audit-diff.test.ts
  "new-secret-value", // src/lib/audit-diff.test.ts
  "supersecret1", // src/lib/audit-diff.test.ts
  "supersecret2", // src/lib/audit-diff.test.ts
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", // src/lib/error-reporting.test.ts
  "whsec_inbound_1234567890", // src/lib/inbound-webhooks.test.ts
  "stored-pass-B88", // src/lib/mailer.test.ts
  "SMTP_PASSWORD_CANARY", // src/lib/mailer.test.ts
  "postgresql://noema:supersecretpw@localhost:5433/noema?schema=public", // src/lib/secrets.test.ts
  "mysql://root:hunter2@db.internal:3306/app", // src/lib/secrets.test.ts
  "SECRET_VALUE", // src/lib/secrets.test.ts
  "postgresql://noema:noema@localhost:5433/noema", // src/lib/self-hosting.test.ts
  "whsec_test_1234567890", // src/lib/webhook-signature.test.ts
  "webhook-delivery-test-key-0123456789ab", // src/lib/webhooks.test.ts
  "correct-horse", // src/server/actions/auth.lockout.test.ts
  "Str0ngPassphrase", // src/server/actions/auth.lockout.test.ts
  "GOOD_PASSWORD", // src/server/actions/auth.test.ts
  "b30-action-secret", // src/server/actions/automations-ops-gate.test.ts
  "Vivid-Quartz-91!Lantern", // src/server/actions/two-factor-replay.test.ts
  "b25-two-factor-replay-test-secret-0123456789", // src/server/actions/two-factor-replay.test.ts
]);

const args = process.argv.slice(2);
const withHistory = args.includes("--history");
const ref = args.find((arg) => !arg.startsWith("--")) ?? "HEAD";

const rel = (file) => relative(ROOT, file).replace(/\\/g, "/");

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((file) => join(ROOT, file));
  } catch (error) {
    console.error(`check-secrets: could not list tracked files — is git installed?\n${error.message}`);
    process.exit(1);
  }
}

const files = trackedFiles();
function isAllowed(path, value) {
  if (ALLOWED.has(value)) return true;
  if (!ALLOWED_IN_TESTS.has(value)) return false;
  return TEST_FILE.test(path) || path === SELF;
}

function scanText(path, text, found) {
  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[2] ?? match[3] ?? match[4] ?? match[0];
      if (isAllowed(path, value) || isAllowed(path, match[0])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      // One credential usually matches more than one pattern (`sk-proj-…` is
      // both an OpenAI key and a configured value). Report the line once.
      const fingerprint = `${path}:${line}:${value}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      found.push({ path, line, name, value });
    }
  }
}

function scanHistory() {
  let objects;
  try {
    objects = execFileSync("git", ["rev-list", "--objects", ref], {
      cwd: ROOT,
      maxBuffer: 1024 * 1024 * 1024,
    }).toString("utf8");
  } catch (error) {
    console.error(`check-secrets: could not read the history of ${ref}\n${error.message}`);
    process.exit(1);
  }

  // The path a blob was last seen at — the one a reader would look at.
  const pathOf = new Map();
  for (const line of objects.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const sha = space === -1 ? line : line.slice(0, space);
    const path = space === -1 ? "" : line.slice(space + 1);
    if (path && !pathOf.has(sha)) pathOf.set(sha, path);
  }

  // `git cat-file --batch` answers with a header line and the raw contents of
  // every object. The whole answer is read in one go: the contents are read
  // as views into it, so no blob is copied twice.
  let raw;
  try {
    raw = execFileSync("git", ["cat-file", "--batch"], {
      cwd: ROOT,
      input: `${[...pathOf.keys()].join("\n")}\n`,
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    console.error(`check-secrets: could not read the blobs of ${ref}\n${error.message}`);
    process.exit(1);
  }

  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf(10, offset);
    if (newline === -1) break;
    const [sha, type, size] = raw.toString("utf8", offset, newline).split(" ");
    offset = newline + 1;
    if (type === "missing") continue;
    const length = Number(size);
    const payload = raw.subarray(offset, offset + length);
    offset += length + 1; // every record ends with a newline
    if (type !== "blob") continue;
    historyBlobs += 1;
    if (payload.includes(0)) continue; // binary — nothing to match against
    const path = pathOf.get(sha);
    if (!path) continue;
    if (SKIP.some((re) => re.test(path))) continue;
    scanText(path, payload.toString("utf8"), historyFindings);
  }
}

const findings = [];
const historyFindings = [];
const seen = new Set();
const trackedEnvFiles = [];
/** How many blobs of the history the history scan read. */
let historyBlobs = 0;

for (const file of files) {
  const path = rel(file);
  if (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")) {
    trackedEnvFiles.push(path);
  }
  if (SKIP.some((re) => re.test(path))) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable — nothing to match against
  }

  scanText(path, text, findings);
}

if (withHistory) {
  scanHistory();
}

console.log(
  `secret gate — ${files.length} tracked file(s) scanned · ${PATTERNS.length} pattern(s)` +
    (withHistory ? ` · ${historyBlobs} historical blob(s) scanned` : "") +
    "\n",
);

if (trackedEnvFiles.length > 0) {
  for (const path of trackedEnvFiles) {
    console.log(`  TRACKED  ${path} — environment files must never be committed`);
  }
}

for (const { path, line, name, value } of findings) {
  const shown = value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
  console.log(`  LEAK     ${path}:${line} — ${name} (${shown})`);
}

for (const { path, line, name, value } of historyFindings) {
  const shown = value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
  console.log(`  HISTORY  ${path}:${line} — ${name} (${shown})`);
}

if (findings.length === 0 && historyFindings.length === 0 && trackedEnvFiles.length === 0) {
  console.log("  ok       no credential-shaped value in the tree");
  console.log("\n0 finding(s).");
  process.exit(0);
}

console.error(
  [
    "",
    `${findings.length + historyFindings.length + trackedEnvFiles.length} finding(s).`,
    "",
    "Move the value into `.env` (git-ignored) and read it from the environment,",
    "then rotate it at the provider — anything committed is already public. If it",
    "is a documentation example, add the exact literal to ALLOWED in",
    "scripts/check-secrets.mjs rather than loosening a pattern.",
  ].join("\n"),
);
process.exit(1);
