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
 * Test files are scanned like every other file. A fixture is exactly where a
 * live key gets pasted, and the fixtures this repository ships are exempted
 * by *value* ({@link ALLOWED_IN_TESTS}), not by path: a path exemption hides
 * a real key in every test file at once.
 *
 * The scan covers the *present* of the repository. The *past* is a second
 * gate, and it catches the leak that cannot be undone: a credential that was
 * committed and later removed is still in the published history — the commit
 * is the publication, not the current tree. `--history` walks every blob of
 * the ref under review.
 *
 * The patterns are deliberately value-shaped rather than entropy-shaped: the
 * formats real providers actually issue, plus `NAME=<12+ chars>` for the
 * variables this app reads. That keeps false positives near zero, which is what
 * makes the gate trustworthy enough to be a required check. Known-safe
 * documentation examples are listed in {@link ALLOWED} rather than matched by a
 * looser rule that would hide a real key too.
 *
 *   npm run check:secrets          # the current tree
 *   npm run check:secrets:history  # the current tree *and* the history
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The path of the gate itself — the allow lists below are written in it. */
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, "/");

/**
 * Files whose whole point is to contain secret-shaped strings.
 *
 * Test files are deliberately *not* in this list: a fixture is where a live
 * key gets pasted, and the fixtures the repository ships are exempted by
 * value instead (see {@link ALLOWED_IN_TESTS}).
 */
const SKIP = [/(^|\/)\.env\.example$/];

/** A test file — the one place a fixture literal is exempt. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Provider formats, plus the env var names this app reads. */
const PATTERNS = [
  { name: "OpenAI / DeepSeek key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "configured secret value",
    // Quoted values of any shape, or bare values that look issued rather than
    // referenced: at least 12 chars, at least one digit, and not a call
    // (`ensureAuthSecret()`), so `process.env.AUTH_SECRET = ensureAuthSecret()`
    // is code and `AUTH_SECRET="4f59…"` is a credential.
    re: /\b(AI_API_KEY|OPENAI_API_KEY|AI_TRANSCRIBE_API_KEY|SMTP_PASSWORD|SSO_CLIENT_SECRET|CRON_SECRET|AUTH_SECRET|S3_SECRET_ACCESS_KEY|NOTION_TOKEN|NOTION_API_KEY)\s*[:=]\s*(?:"([^"\n]{12,})"|'([^'\n]{12,})'|((?=[A-Za-z0-9_\-/+]*\d)[A-Za-z0-9_\-/+]{12,}(?!\s*\()))/g,
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
  "b85-proof-secret", // scripts/_b85-redproof.mjs — a deleted proof script, only in the history
]);

/**
 * The fixture literals of the test suites: fake values the tests need, and
 * therefore not credentials.
 *
 * The exemption is scoped to a test file on purpose. A value that is a
 * fixture in `src/lib/x.test.ts` is a hard-coded credential the moment it
 * sits in `src/lib/x.ts`, and exempting it everywhere would let a real
 * secret hide behind a fixture's name.
 */
const ALLOWED_IN_TESTS = new Set([
  "sk-live-abcdef1234567890", // src/app/api/ai/*.test.ts, src/lib/ai-provider.error.test.ts
  "sk-transcribe-abcdef1234567890", // src/app/api/ai/transcribe/route.test.ts
  "sk-proj-zzzzzzzzzzzzzzzz", // src/lib/ai-provider.error.test.ts
  "sk-live-abcdefghijklmno", // src/lib/error-reporting.test.ts, src/lib/error-tracking.test.ts
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

/**
 * Whether a value may not be reported at this path: a documented example
 * anywhere, or a fixture literal where it is written down as a fixture — in
 * a test file, or in the allow list of the gate that names it.
 */
function isAllowed(path, value) {
  if (ALLOWED.has(value)) return true;
  if (!ALLOWED_IN_TESTS.has(value)) return false;
  return TEST_FILE.test(path) || path === SELF;
}

const findings = [];
const historyFindings = [];
const seen = new Set();
const trackedEnvFiles = [];
/** How many blobs of the history the history scan read. */
let historyBlobs = 0;

/**
 * Report every credential-shaped value in one text.
 *
 * The value is the first of the three quoted/bare alternatives of the last
 * pattern; for every other pattern it is the whole match.
 */
function scanText(path, text, found) {
  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[2] ?? match[3] ?? match[4] ?? match[0];
      if (isAllowed(path, value)) continue;
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

const files = trackedFiles();

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

/**
 * Scan every blob of the history of `ref`.
 *
 * Git stores a blob by its content, so the history of this repository is
 * ~160 MB of text in ~3,900 blobs — a file that was changed ten times is
 * scanned ten times at most, once per revision. The answer of
 * `git cat-file --batch` is read in one go and walked with an index: the
 * blobs are views into it, so nothing is copied twice.
 */
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
  console.log(
    withHistory
      ? "  ok       no credential-shaped value in the tree or in the history"
      : "  ok       no credential-shaped value in the tree",
  );
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
    "scripts/check-secrets.mjs rather than loosening a pattern — and if it is",
    "a fixture, to ALLOWED_IN_TESTS (test files only).",
    ...(historyFindings.length > 0
      ? [
          "",
          "A finding in the history is public even if the file is gone: rotate it at",
          "the provider now, and rewrite the history if it must not stay there.",
        ]
      : []),
  ].join("\n"),
);
process.exit(1);
