#!/usr/bin/env node
/**
 * Gate: every commit must obey the Noema authoring-window policy.
 *
 * Walks every commit reachable from every ref and asserts that both the author
 * date and the committer date land inside one of the four windows defined in
 * `src/lib/dates-policy.ts` (Wed–Sat evenings, Europe/Paris). The committer
 * date is checked too, because a rebase or an amend can move it out of the
 * window even when the original author date was fine.
 *
 * Also verifies that author and committer e-mail addresses belong to a project
 * human, unless `--allow-nonhuman` is passed (some local automation still runs
 * under a service identity and should be able to self-check).
 *
 * Usage:
 *   node scripts/check-commit-dates.mjs                 # all refs
 *   node scripts/check-commit-dates.mjs main            # one revision range
 *   node scripts/check-commit-dates.mjs --allow-nonhuman
 *
 * Exits 1 and prints every offending commit when the policy is broken.
 */
import { execFileSync } from "node:child_process";
import { describeVerdict, describeWindows, isAllowedInstant } from "../src/lib/dates-policy.ts";

const US = "\u001f";
const RS = "\u001e";

const HUMANS = new Map([
  ["bilel.guembri@outlook.fr", "Bilel Guembri"],
  ["wissal.benothmen01@gmail.com", "Wissal Ben Othmen"],
]);

const argv = process.argv.slice(2);
const allowNonHuman = argv.includes("--allow-nonhuman");
const pending = argv.includes("--pending");
const range = argv.filter((arg) => !arg.startsWith("--"));

/** Git accepts several `GIT_*_DATE` shapes; normalise the ones we hand out. */
function parseGitDate(value) {
  if (!value) return new Date();
  const raw = String(value).trim();
  const epoch = /^@?(\d{9,11})(?:\s+([+-]\d{4}))?$/.exec(raw);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

if (pending) {
  const config = (key) => {
    try {
      return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const committerEmail = process.env.GIT_COMMITTER_EMAIL || config("user.email");
  const authorDate = parseGitDate(process.env.GIT_AUTHOR_DATE);
  const committerDate = parseGitDate(process.env.GIT_COMMITTER_DATE);
  const problems = [];
  if (!authorDate || !isAllowedInstant(authorDate)) {
    problems.push(`author date  ${describeVerdict(authorDate ?? "invalid")}`);
  }
  if (!committerDate || !isAllowedInstant(committerDate)) {
    problems.push(`committer    ${describeVerdict(committerDate ?? "invalid")}`);
  }
  if (!allowNonHuman && !HUMANS.has(committerEmail)) {
    problems.push(`committer e-mail <${committerEmail}> is not a project human`);
  }
  if (problems.length === 0) {
    console.log("check-commit-dates: pending commit is inside a window");
    process.exit(0);
  }
  console.error("check-commit-dates: refusing this commit - declare an in-window timestamp:");
  console.error(`  windows: ${describeWindows().join(" | ")} (Europe/Paris)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('  e.g. GIT_AUTHOR_DATE="2026-10-17T19:00:00+02:00" GIT_COMMITTER_DATE="2026-10-17T19:00:00+02:00" git commit ...');
  process.exit(1);
}

const logArgs = ["log", ...(range.length ? range : ["--all"]), `--pretty=format:%H${US}%an${US}%ae${US}%aI${US}%cn${US}%ce${US}%cI${US}%s${RS}`];

let raw;
try {
  raw = execFileSync("git", logArgs, { encoding: "utf8", maxBuffer: 1 << 30 });
} catch (error) {
  console.error(`check-commit-dates: git log failed: ${error.message}`);
  process.exit(2);
}

const commits = raw
  .split(RS)
  .map((record) => record.replace(/^\n/, ""))
  .filter(Boolean)
  .map((record) => {
    const [hash, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, subject] = record.split(US);
    return { hash, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, subject: (subject ?? "").trim() };
  });

if (commits.length === 0) {
  console.log("check-commit-dates: no commits to check");
  process.exit(0);
}

const dateFailures = [];
const identityFailures = [];

for (const commit of commits) {
  for (const [field, iso] of [["author", commit.authorDate], ["committer", commit.committerDate]]) {
    if (!isAllowedInstant(iso)) {
      dateFailures.push({ ...commit, field, iso });
    }
  }
  if (!allowNonHuman) {
    for (const [field, email] of [["author", commit.authorEmail], ["committer", commit.committerEmail]]) {
      if (!HUMANS.has(email)) {
        identityFailures.push({ ...commit, field, email });
      }
    }
  }
}

if (dateFailures.length === 0 && identityFailures.length === 0) {
  console.log(`check-commit-dates: OK — ${commits.length} commits inside ${describeWindows().length} windows, humans only${allowNonHuman ? " (identity relaxed)" : ""}`);
  process.exit(0);
}

console.error(`check-commit-dates: FAILED on ${dateFailures.length} date and ${identityFailures.length} identity violation(s) across ${commits.length} commits`);
console.error(`windows: ${describeWindows().join(" | ")} (${"Europe/Paris"})\n`);

for (const failure of dateFailures.slice(0, 40)) {
  console.error(`  ${failure.hash.slice(0, 12)}  ${failure.field.padEnd(9)}  ${describeVerdict(failure.iso)}  — ${failure.subject.slice(0, 60)}`);
}
if (dateFailures.length > 40) console.error(`  … and ${dateFailures.length - 40} more date violations`);

for (const failure of identityFailures.slice(0, 20)) {
  console.error(`  ${failure.hash.slice(0, 12)}  ${failure.field.padEnd(9)}  unknown identity <${failure.email}>  — ${failure.subject.slice(0, 60)}`);
}
if (identityFailures.length > 20) console.error(`  … and ${identityFailures.length - 20} more identity violations`);

process.exit(1);
