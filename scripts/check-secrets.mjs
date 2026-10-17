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
const SKIP = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /(^|\/)\.env\.example$/];

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
  "postgresql://noema:sup3r-secret@db.example.com:5432/noema?schema=public", // src-tauri/src/commands.rs, the redaction fixture
  // The database URL of the embedded engine. The password is a template — the
  // launch's own random one — and the host is the loopback.
  "postgresql://${DB_USER}:${password}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1&pgbouncer=true", // scripts/desktop/embedded-db.cjs
  "postgresql://postgres:<password>@127.0.0.1:<port>/postgres?pgbouncer=true&connection_limit=1", // docs/DESKTOP.md
]);

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
const findings = [];
const seen = new Set();
const trackedEnvFiles = [];

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

  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      // Group 1 is the variable *name* in the two value patterns; the value is
      // the first of the three quoted/bare alternatives.
      const value = match[2] ?? match[3] ?? match[4] ?? match[0];
      // The allow-list holds **exact literals**: the value behind a variable
      // name, and — for the connection string, whose groups are the user and
      // the password — the whole URL. Both spellings are checked, so an
      // entry can name the connection string as a whole.
      if (ALLOWED.has(value) || ALLOWED.has(match[0])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      // One credential usually matches more than one pattern (`sk-proj-…` is
      // both an OpenAI key and a configured value). Report the line once.
      const fingerprint = `${path}:${line}:${value}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      findings.push({ path, line, name, value });
    }
  }
}

console.log(
  `secret gate — ${files.length} tracked file(s) scanned · ${PATTERNS.length} pattern(s)\n`,
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

if (findings.length === 0 && trackedEnvFiles.length === 0) {
  console.log("  ok       no credential-shaped value in the tree");
  console.log("\n0 finding(s).");
  process.exit(0);
}

console.error(
  [
    "",
    `${findings.length + trackedEnvFiles.length} finding(s).`,
    "",
    "Move the value into `.env` (git-ignored) and read it from the environment,",
    "then rotate it at the provider — anything committed is already public. If it",
    "is a documentation example, add the exact literal to ALLOWED in",
    "scripts/check-secrets.mjs rather than loosening a pattern.",
  ].join("\n"),
);
process.exit(1);
