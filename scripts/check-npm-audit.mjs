#!/usr/bin/env node
/**
 * Dependency-advisory gate: a *new* advisory in the tree must fail the build.
 *
 * Why this exists: nothing in the repository looked at `npm audit`. The
 * lockfile carried advisories that no gate could see, and an advisory that
 * lands in it stayed there — the audit is a snapshot of the registry, not a
 * state somebody maintains.
 *
 * The rule this gate implements:
 *
 *   · Every advisory the audit reports must be on the list of **accepted**
 *     advisories (`scripts/npm-audit-baseline.mjs`). An advisory that is not
 *     on the list is a finding and fails the build. That is what catches a
 *     *new* advisory — the case the gate exists for.
 *   · Every entry of that list must still be reported. A list that keeps an
 *     advisory the tree no longer has is a finding as well: the list may
 *     only shrink, so a fixed advisory has to be deleted from it in the same
 *     change that fixes it.
 *
 * Why not `npm audit --audit-level=high` on its own: it fails on every
 * advisory that is already known, and the step is then dead after the first
 * week — nobody un-pins a package that cannot be un-pinned. The list is what
 * makes the step permanent: a known advisory is a decision with a reason,
 * and a new one is a failure.
 *
 * The severity does not decide whether an advisory is a finding: the list is
 * the whole decision. A moderate advisory that is not on the list is a
 * finding too — it is the high advisory of tomorrow, and the registry
 * re-rates advisories.
 *
 *   npm run check:audit
 *   node scripts/check-npm-audit.mjs --report <audit.json>   # read a report
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_ADVISORIES } from "./npm-audit-baseline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {object} Advisory
 * @property {string} id       The advisory id (the GHSA id).
 * @property {string} package  The package the advisory is about.
 * @property {string} severity The severity npm reports.
 * @property {string} title    The advisory's title.
 * @property {string} url      The advisory's URL.
 * @property {string} range    The versions the advisory covers.
 * @property {string[]} packages The packages in the tree that carry it.
 */

/**
 * The advisory id of a `via` entry of the report.
 *
 * npm prints the id in the advisory's URL (`…/advisories/GHSA-…`) and the
 * numeric source id next to it; the URL is the stable one.
 *
 * @param {{url?: string, source?: number, name?: string}} advisory
 * @returns {string}
 */
export function advisoryId(advisory) {
  const match = /advisories\/(GHSA-[A-Za-z0-9-]+)/.exec(advisory.url ?? "");
  if (match) return match[1];
  if (advisory.source !== undefined) return `npm-${advisory.source}`;
  return advisory.name ?? "unknown";
}

/**
 * Every advisory of a report, with the packages that carry it.
 *
 * npm reports a *package* per entry and lists the advisories it inherits
 * from its dependencies in `via`. The string entries of `via` are packages,
 * not advisories; the object entries are the advisories themselves. A report
 * of eight packages can therefore hold two advisories — and it is the
 * advisory that has to be on the list, not the package.
 *
 * The packages that carry an advisory are listed from the vulnerable one
 * outwards: `braces` ← `micromatch` ← `fast-glob` ← …
 *
 * @param {object} report The report `npm audit --json` prints.
 * @returns {Advisory[]}
 */
export function collectAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities ?? {};

  /** @type {Map<string, Advisory>} */
  const advisories = new Map();
  /** @type {Map<string, Set<string>>} */
  const carried = new Map();

  // The advisories themselves: the object entries of `via`.
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    for (const via of vulnerability?.via ?? []) {
      if (typeof via === "string") continue; // a package that inherits an advisory
      const id = advisoryId(via);
      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          package: via.name ?? name,
          severity: via.severity ?? "unknown",
          title: via.title ?? "",
          url: via.url ?? "",
          range: via.range ?? "",
          packages: [],
        });
      }
      const ids = carried.get(name) ?? new Set();
      ids.add(id);
      carried.set(name, ids);
    }
  }

  // The packages that inherit an advisory: the string entries of `via`.
  // A package inherits what the package it depends on carries, so the chain
  // is followed to the end.
  const inherits = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const ids = [];
    for (const via of vulnerabilities[name]?.via ?? []) {
      if (typeof via !== "string") {
        ids.push(advisoryId(via));
        continue;
      }
      ids.push(...inherits(via, seen));
    }
    return ids;
  };

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const ids = carried.get(name) ?? new Set();
    for (const id of inherits(name)) ids.add(id);
    carried.set(name, ids);
  }

  // The depth of a package in the chain: the vulnerable package is 0, the
  // package that depends on it 1, and so on.
  const depths = new Map();
  const depthOf = (name, seen = new Set()) => {
    if (depths.has(name)) return depths.get(name);
    if (seen.has(name)) return Number.MAX_SAFE_INTEGER;
    seen.add(name);
    let depth = Number.MAX_SAFE_INTEGER;
    for (const via of vulnerabilities[name]?.via ?? []) {
      if (typeof via !== "string") {
        depth = 0;
        break;
      }
      depth = Math.min(depth, 1 + depthOf(via, seen));
    }
    depths.set(name, depth);
    return depth;
  };

  for (const [name, ids] of carried) {
    for (const id of ids) {
      const advisory = advisories.get(id);
      if (advisory && !advisory.packages.includes(name)) advisory.packages.push(name);
    }
  }
  for (const advisory of advisories.values()) {
    advisory.packages.sort((left, right) => depthOf(left) - depthOf(right) || left.localeCompare(right));
  }

  return [...advisories.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The findings of a report against the accepted advisories.
 *
 * @param {object} report The report `npm audit --json` prints.
 * @param {{id: string, package: string, severity: string, reason: string}[]} [accepted]
 * @returns {{rule: string, message: string}[]}
 */
export function analyzeAuditReport(report, accepted = ACCEPTED_ADVISORIES) {
  /** @type {{rule: string, message: string}[]} */
  const findings = [];
  const advisories = collectAdvisories(report);
  const acceptedIds = new Set(accepted.map((entry) => entry.id));

  for (const advisory of advisories) {
    if (acceptedIds.has(advisory.id)) continue;
    findings.push({
      rule: "unaccepted-advisory",
      message:
        `${advisory.id} (${advisory.severity}) — ${advisory.package}: ${advisory.title || "no title"} — ` +
        `not on the list of accepted advisories (scripts/npm-audit-baseline.mjs); ` +
        `the tree carries it through ${advisory.packages.join(", ")}`,
    });
  }

  const reportedIds = new Set(advisories.map((advisory) => advisory.id));
  for (const entry of accepted) {
    if (reportedIds.has(entry.id)) continue;
    findings.push({
      rule: "stale-baseline",
      message:
        `${entry.id} — ${entry.package} is on the list of accepted advisories but the audit does not report it any more; ` +
        `the advisory is fixed — delete the entry from scripts/npm-audit-baseline.mjs`,
    });
  }

  return findings;
}

/**
 * Run the audit and read its report.
 *
 * @param {string} [cwd]
 * @returns {{report: object|null, error: string|null}}
 */
export function runAudit(cwd = ROOT) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["audit", "--audit-level=high", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // `npm.cmd` is a batch shim; Node 24 refuses to spawn it without a shell
    // (EINVAL) on Windows. The arguments are fixed, so the shell is safe here.
    shell: process.platform === "win32",
  });

  if (result.error) return { report: null, error: result.error.message };

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const stderr = (result.stderr ?? "").trim();
    return {
      report: null,
      error: `the audit did not print a report (exit ${result.status})${stderr ? `: ${stderr}` : ""}`,
    };
  }

  // npm prints a report with an `error` in it when the audit itself failed —
  // an unreachable registry, say. That is not an empty tree: the gate has to
  // fail, not pass, because it cannot know the state of the dependencies.
  if (report?.error || (report?.message && !report?.vulnerabilities)) {
    return { report: null, error: report.message ?? "the audit endpoint returned an error" };
  }

  return { report, error: null };
}

function main(argv) {
  const reportIndex = argv.indexOf("--report");
  let report = null;
  let error = null;

  if (reportIndex !== -1) {
    const file = argv[reportIndex + 1];
    if (!file) {
      console.error("check-npm-audit: --report needs a file");
      process.exit(1);
    }
    try {
      report = JSON.parse(readFileSync(resolve(file), "utf8"));
    } catch (readError) {
      error = `cannot read the report: ${readError.message}`;
    }
  } else {
    const audit = runAudit();
    report = audit.report;
    error = audit.error;
  }

  if (error) {
    console.error(`dependency audit — the audit could not be run\n\n  ${error}`);
    process.exit(1);
  }

  const advisories = collectAdvisories(report);
  const findings = analyzeAuditReport(report);
  const accepted = advisories.filter((advisory) =>
    ACCEPTED_ADVISORIES.some((entry) => entry.id === advisory.id),
  );

  console.log(
    `dependency audit — ${advisories.length} advisory/advisories reported, ` +
      `${accepted.length} accepted, ${findings.length} finding(s)\n`,
  );

  for (const finding of findings) {
    console.log(`  HOLE    ${finding.message}`);
  }

  if (findings.length === 0) {
    for (const advisory of accepted) {
      console.log(`  ok      ${advisory.id} (${advisory.severity}) — ${advisory.package} — accepted`);
    }
    console.log("\n0 finding(s).");
    process.exit(0);
  }

  console.error(
    [
      "",
      `${findings.length} finding(s).`,
      "",
      "Fix the advisory, or — when it cannot be fixed today — put it on the",
      "list of accepted advisories with the reason (scripts/npm-audit-baseline.mjs).",
      "A new advisory fails this gate; a known one does not.",
    ].join("\n"),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
