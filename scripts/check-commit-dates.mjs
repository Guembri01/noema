#!/usr/bin/env node
/**
 * Gate: every commit must obey the Noema authoring-window policy.
 *
 * Walks the commits of the ref under review — `HEAD` in a checkout, or the
 * revision range the caller names — and asserts that both the author date and
 * the committer date land inside one of the four windows defined in
 * `src/lib/dates-policy.ts` (Wed–Sat evenings, Europe/Paris). The committer
 * date is checked too, because a rebase or an amend can move it out of the
 * window even when the original author date was fine.
 *
 * Also verifies that author and committer e-mail addresses belong to a project
 * human, unless `--allow-nonhuman` is passed (some local automation still runs
 * under a service identity and should be able to self-check). A commit that
 * GitHub itself created is exempt as a whole: if its *committer* is GitHub's
 * automation — the identity GitHub commits merges under, or an App account —
 * then neither its author field nor its committer field is checked, against
 * either policy. A bot commit is not a human authoring decision.
 *
 * Why the ref under review and not every ref: CI checks out with
 * `fetch-depth: 0`, which fetches every branch, so walking every ref swept in
 * the branches that merely happen to be open. The policy polices the commits of
 * the change, not the branches that exist.
 *
 * Usage:
 *   node scripts/check-commit-dates.mjs                 # the commits of HEAD
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
  ["2719454+reisi007@users.noreply.github.com", "Florian Reisinger"],
  ["bilel.guembri@outlook.fr", "Bilel Guembri"],
  ["wissal.benothmen01@gmail.com", "Wissal Ben Othmen"],
  ["ugochukwuc762@gmail.com", "Ugochukwu Chidera"],
]);

/**
 * GitHub's own automation identities — GitHub App accounts, which carry the
 * reserved `[bot]` marker, and the `noreply@github.com` identity GitHub
 * commits merges under.
 *
 * The *set* of identities is deliberately narrow: a *human* who keeps their
 * e-mail private commits as `<id>+<login>@users.noreply.github.com`, and that
 * address is NOT a bot. Matching the whole no-reply domain would exempt real
 * people from the date *and* the identity policy, and would make their entry
 * in {@link HUMANS} unreachable.
 *
 * The *scope* of the exemption, on the other hand, is the whole commit, and it
 * is anchored on the **committer**: a commit whose committer is GitHub's
 * automation was created by GitHub, so no field of it is a human authoring
 * decision and neither the date policy nor the identity policy applies to it.
 * That is load-bearing for the date policy: Dependabot commits whenever it
 * runs, and GitHub's synthetic merge commit (`refs/pull/N/merge`, which a
 * pull-request checkout makes `HEAD`) is dated at ref-build time.
 *
 * The converse does not hold, and the asymmetry is the point: a commit whose
 * *author* is a bot but whose committer is a human was not created by GitHub,
 * so it is checked like any other commit — its author field included.
 */
const BOT_EMAIL = /\[bot\]@users\.noreply\.github\.com$|^noreply@github\.com$/;

/** Whether an identity belongs to GitHub's automation rather than a person. */
function isBot(email) {
  return BOT_EMAIL.test(String(email ?? ""));
}

/**
 * Whether a commit is GitHub's own automation — then the exemption covers the
 * whole commit: neither the author field nor the committer field is checked,
 * against either the date policy or the identity policy.
 *
 * The anchor is the **committer**, because that is what says who created the
 * commit. GitHub's synthetic merge commit for a pull request is the reason
 * the author field needs the same exemption: the merge commit carries the
 * *human's* address in its author field, while its clock and its committer
 * are GitHub's. The reverse anchor would exempt a commit a human made on top
 * of a bot's work — that one was committed by a human and must pass.
 */
function isGitHubAutomation(committerEmail) {
  return isBot(committerEmail);
}

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
  // The same rule the history path applies: a commit that GitHub's automation
  // committers is exempt as a whole, so the pending path exempts it from both
  // policies — the two paths cannot disagree.
  if (!isGitHubAutomation(committerEmail)) {
    if (!authorDate || !isAllowedInstant(authorDate)) {
      problems.push(`author date  ${describeVerdict(authorDate ?? "invalid")}`);
    }
    if (!committerDate || !isAllowedInstant(committerDate)) {
      problems.push(`committer    ${describeVerdict(committerDate ?? "invalid")}`);
    }
  }
  if (!allowNonHuman && !isGitHubAutomation(committerEmail) && !HUMANS.has(committerEmail)) {
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

// The commits to check are the ones of the ref under review — `HEAD` in a
// checkout, or the revision range the caller names. Walking *every* ref
// (`--all`) swept in the branches that merely exist in the repository: CI
// checks out with `fetch-depth: 0`, so the open Dependabot branches were part
// of the traversal, and their bot commits failed the gate for pull requests
// that had nothing to do with them. The policy polices the commits of the
// change, not the branches that happen to be open.
const logArgs = ["log", ...(range.length ? range : ["HEAD"]), `--pretty=format:%H${US}%an${US}%ae${US}%aI${US}%cn${US}%ce${US}%cI${US}%s${RS}`];

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
  // GitHub's own automation is recognised by the committer: such a commit was
  // created by GitHub, so the exemption covers the *whole* commit — the author
  // field included. GitHub's synthetic merge commit for a pull request is the
  // case that needs it: the author field carries the human's address, while
  // the clock and the committer are GitHub's. A commit whose author is a bot
  // but whose committer is a human was not created by GitHub, so it is
  // checked like any other commit.
  if (isGitHubAutomation(commit.committerEmail)) continue;
  for (const [field, iso] of [
    ["author", commit.authorDate],
    ["committer", commit.committerDate],
  ]) {
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
  console.log(`check-commit-dates: OK — ${commits.length} commits inside ${describeWindows().length} windows${allowNonHuman ? " (identity relaxed)" : ""}, humans only (GitHub's automation exempt)`);
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
