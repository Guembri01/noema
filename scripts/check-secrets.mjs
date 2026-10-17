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
 * formats real providers actually issue, plus `NAME=<12+ chars>` for the
 * variables this app reads. That keeps false positives near zero, which is what
 * makes the gate trustworthy enough to be a required check. Known-safe
 * documentation examples are listed in {@link ALLOWED} rather than matched by a
 * looser rule that would hide a real key too.
 *
 *   npm run check:secrets
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose whole point is to contain secret-shaped strings. */
const SKIP = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /(^|\/)\.env\.example$/];

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
      // Group 1 is the variable *name* in the last pattern; the value is the
      // first of the three quoted/bare alternatives.
      const value = match[2] ?? match[3] ?? match[4] ?? match[0];
      if (ALLOWED.has(value)) continue;
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
