#!/usr/bin/env node
/**
 * Gate: every human-authored commit must use a registered project identity.
 * Commit dates are unrestricted. GitHub automation commits are exempt as a
 * whole when the committer is a GitHub bot or GitHub's merge identity.
 */
import { execFileSync } from "node:child_process";

const US = "\u001f";
const RS = "\u001e";
const HUMANS = new Map([
  ["2719454+reisi007@users.noreply.github.com", "Florian Reisinger"],
  ["bilel.guembri@outlook.fr", "Bilel Guembri"],
  ["wissal.benothmen01@gmail.com", "Wissal Ben Othmen"],
]);
const BOT_EMAIL = /\[bot\]@users\.noreply\.github\.com$|^noreply@github\.com$/;
const isGitHubAutomation = (email) => BOT_EMAIL.test(String(email ?? ""));
const argv = process.argv.slice(2);
const allowNonHuman = argv.includes("--allow-nonhuman");
const pending = argv.includes("--pending");
const range = argv.filter((arg) => !arg.startsWith("--"));

if (pending) {
  const config = (key) => {
    try {
      return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || config("user.email");
  const committerEmail = process.env.GIT_COMMITTER_EMAIL || config("user.email");
  const failures = [];
  if (!isGitHubAutomation(committerEmail) && !allowNonHuman) {
    for (const [field, email] of [["author", authorEmail], ["committer", committerEmail]]) {
      if (!HUMANS.has(email)) failures.push(`${field} e-mail <${email}> is not a project human`);
    }
  }
  if (failures.length) {
    console.error("check-commit-dates: refusing this commit:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-commit-dates: pending commit uses project human identities (GitHub automation exempt)");
  process.exit(0);
}

const logArgs = ["log", ...(range.length ? range : ["HEAD"]), `--pretty=format:%H${US}%an${US}%ae${US}%cn${US}%ce${US}%s${RS}`];
let raw;
try {
  raw = execFileSync("git", logArgs, { encoding: "utf8", maxBuffer: 1 << 30 });
} catch (error) {
  console.error(`check-commit-dates: git log failed: ${error.message}`);
  process.exit(2);
}
const commits = raw.split(RS).map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
  const [hash, authorName, authorEmail, committerName, committerEmail, subject] = record.split(US);
  return { hash, authorName, authorEmail, committerName, committerEmail, subject: (subject ?? "").trim() };
});
if (commits.length === 0) {
  console.log("check-commit-dates: no commits to check");
  process.exit(0);
}

const failures = [];
for (const commit of commits) {
  if (isGitHubAutomation(commit.committerEmail)) continue;
  if (!allowNonHuman) {
    for (const [field, email] of [["author", commit.authorEmail], ["committer", commit.committerEmail]]) {
      if (!HUMANS.has(email)) failures.push({ ...commit, field, email });
    }
  }
}
if (!failures.length) {
  console.log(`check-commit-dates: OK — ${commits.length} commits use project human identities${allowNonHuman ? " (identity relaxed)" : ""} (GitHub automation exempt)`);
  process.exit(0);
}
console.error(`check-commit-dates: FAILED on ${failures.length} identity violation(s) across ${commits.length} commits`);
for (const failure of failures.slice(0, 40)) {
  console.error(`  ${failure.hash.slice(0, 12)}  ${failure.field.padEnd(9)}  unknown identity <${failure.email}>  — ${failure.subject.slice(0, 60)}`);
}
if (failures.length > 40) console.error(`  … and ${failures.length - 40} more identity violations`);
process.exit(1);
