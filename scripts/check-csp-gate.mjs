#!/usr/bin/env node
/**
 * CSP gate: the CSP check has to run in the CI — and it has to be able to.
 *
 * Why this exists: `scripts/check-csp.mjs` asserts against a running
 * **production** server that every inline script is nonced or hash-pinned. It
 * is a good gate — and it ran in no workflow at all, so a CSP regression was
 * only ever noticed by hand.
 *
 * This gate keeps that job honest. It reads the CI workflow and checks that
 *
 *   1. a job really runs `scripts/check-csp.mjs` (directly or through
 *      `npm run check:csp`),
 *   2. the step cannot be skipped: no `continue-on-error`, no `|| true`, no
 *      `if:` on the step,
 *   3. the job cannot be skipped: no `if:` on the job, no `continue-on-error`
 *      on it,
 *   4. the workflow is reached by a `pull_request`,
 *   5. the job gives the check what it needs to run: a postgres service (the
 *      sign-in reads the seeded demo user), an `AUTH_SECRET` (the app refuses
 *      to start without one), the Playwright Chromium (the runner has no
 *      Edge), a production build, a running server — and a `--base` URL on the
 *      port that server listens on.
 *
 * The rules are mechanical, not a word count: a workflow that *names* the
 * check but cannot run it is as good as no workflow at all, and a job that
 * runs the check against nothing but a dev server proves nothing.
 *
 * The workflow reader is the one the repository already has
 * (`scripts/check-desktop-workflow-permissions.mjs`): it is a generic reader
 * of the YAML subset GitHub workflows use — only the *rules* in that file are
 * desktop-specific.
 *
 *   node scripts/check-csp-gate.mjs            # .github/workflows/ci.yml
 *   node scripts/check-csp-gate.mjs <file>…    # the given workflows
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow, triggerNames } from "./check-desktop-workflow-permissions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workflow this gate owns — the CI workflow, the one every push reaches. */
export const OWNED_WORKFLOW = ".github/workflows/ci.yml";

/** The command that runs the CSP check. */
const CSP_COMMAND = /(?:\bnode\s+scripts\/check-csp\.mjs\b|\bnpm run check:csp\b)/;

/** The port `next start` listens on when the step names none. */
const DEFAULT_PORT = "3000";

/** The steps of a job. */
const stepsOf = (job) => (Array.isArray(job.get("steps")) ? job.get("steps") : []);

/** The `run:` text of a step. */
const runOf = (step) => (typeof step.get("run") === "string" ? step.get("run") : "");

/** True for a YAML scalar that reads as "yes". */
function isTrue(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/** True when the value carries a condition of its own. */
function hasCondition(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * True when the step swallows its own failure — `continue-on-error: true`, or
 * a `|| true` / `|| exit 0` at the end of a command.
 */
function swallowsFailure(step) {
  if (isTrue(step.get("continue-on-error"))) return true;
  return runOf(step)
    .split("\n")
    .some((line) => /\|\|\s*(?:true|exit 0)\s*$/.test(line.trim()));
}

/** The port a command starts a server on. */
function serverPort(text) {
  const explicit = text.match(/--port[= ](\d+)/) ?? text.match(/\bPORT=(\d+)/);
  return explicit ? explicit[1] : DEFAULT_PORT;
}

/** The port the `--base` URL of the check names, or `null` when it names none. */
function basePort(text) {
  const match = text.match(/--base\s+(\S+)/);
  if (!match) return null;
  const url = match[1].replace(/^["']|["']$/g, "");
  const port = url.match(/:(\d+)(?:\/|$)/);
  return port ? port[1] : null;
}

/** The commands of every step of a job. */
function runTexts(job) {
  return stepsOf(job).map(runOf).filter((text) => text !== "");
}

/** True when the job declares a postgres service. */
function hasPostgres(job) {
  const services = job.get("services");
  if (!(services instanceof Map)) return false;
  for (const [name, service] of services) {
    if (/postgres/i.test(name)) return true;
    const image = service instanceof Map ? service.get("image") : undefined;
    if (typeof image === "string" && /postgres/i.test(image)) return true;
  }
  return false;
}

/** True when the environment of the job (or of the workflow) names AUTH_SECRET. */
function hasAuthSecret(job, workflow) {
  for (const scope of [job.get("env"), workflow.get("env")]) {
    if (scope instanceof Map && scope.has("AUTH_SECRET")) return true;
  }
  return false;
}

/** The job runs the CSP check against a server of its own. */
function cspFacts(job, workflow) {
  const texts = runTexts(job);
  const check = texts.find((text) => CSP_COMMAND.test(text)) ?? "";
  const server = texts.find((text) => /next start\b|\bnpm run start\b|\bnpm start\b/.test(text)) ?? "";
  return {
    check,
    server,
    database: hasPostgres(job),
    authSecret: hasAuthSecret(job, workflow),
    browser: texts.some((text) => /playwright install[^\n]*chromium/.test(text)),
    build: texts.some((text) => /next build\b|\bnpm run (?:site:)?build\b/.test(text)),
    basePort: basePort(check),
    serverPort: server === "" ? null : serverPort(server),
    chromium: /--browser\s+chromium\b|CSP_BROWSER\s*=\s*chromium\b/.test(check),
  };
}

/** True when the job gives the check everything it needs to run. */
function isComplete(facts) {
  return (
    facts.database &&
    facts.authSecret &&
    facts.browser &&
    facts.build &&
    facts.server !== "" &&
    facts.basePort !== null &&
    facts.basePort === facts.serverPort &&
    facts.chromium
  );
}

/**
 * The holes of one workflow.
 *
 * @param {string} text the workflow source
 * @param {{ file?: string }} [options]
 * @returns {{ rule: string, message: string }[]}
 */
export function auditCspGate(text, { file = OWNED_WORKFLOW } = {}) {
  const violations = [];
  const report = (rule, message) => violations.push({ file, rule, message });

  const workflow = parseWorkflow(text);
  const jobs = workflow.get("jobs");
  const jobEntries = jobs instanceof Map ? [...jobs.entries()] : [];

  // 1. a job that runs the check
  const runners = [];
  for (const [name, job] of jobEntries) {
    for (const step of stepsOf(job)) {
      if (CSP_COMMAND.test(runOf(step))) runners.push({ name, job, step });
    }
  }

  if (runners.length === 0) {
    report(
      "csp-check-missing",
      `no job in ${file} runs scripts/check-csp.mjs — the CSP check is not enforced in CI`,
    );
    return violations;
  }

  // 2. the workflow is reached by a pull request
  if (!triggerNames(workflow.get("on")).includes("pull_request")) {
    report(
      "csp-no-pull-request",
      `${file} has no pull_request trigger — a CSP regression in a pull request would not be caught`,
    );
  }

  for (const { name, job, step } of runners) {
    // 3. the step cannot be skipped
    if (swallowsFailure(step)) {
      report(
        "csp-step-swallowed",
        `the step that runs scripts/check-csp.mjs in the job \`${name}\` swallows its failure (\`continue-on-error\` or \`|| true\`) — the check would report green whatever it finds`,
      );
    }
    if (hasCondition(step.get("if"))) {
      report(
        "csp-step-conditional",
        `the step that runs scripts/check-csp.mjs in the job \`${name}\` carries an \`if:\` — a pull request could skip the check`,
      );
    }
    // 4. the job cannot be skipped
    if (hasCondition(job.get("if"))) {
      report(
        "csp-job-conditional",
        `the job \`${name}\` carries an \`if:\` — a pull request could skip the check`,
      );
    }
    if (isTrue(job.get("continue-on-error"))) {
      report(
        "csp-job-allow-failure",
        `the job \`${name}\` is marked \`continue-on-error\` — its failure would not fail the workflow`,
      );
    }
  }

  // 5. the job gives the check what it needs to run
  const facts = runners.map((runner) => cspFacts(runner.job, workflow));
  if (!facts.some(isComplete)) {
    const name = runners[0].name;
    const job = facts[0];

    if (!job.database) {
      report(
        "csp-missing-database",
        `the job \`${name}\` has no postgres service — the check signs in with the seeded demo user, so it needs a database`,
      );
    }
    if (!job.authSecret) {
      report(
        "csp-missing-auth-secret",
        `the job \`${name}\` sets no AUTH_SECRET — the app refuses to start without one`,
      );
    }
    if (!job.browser) {
      report(
        "csp-missing-browser",
        `the job \`${name}\` installs no Playwright Chromium — the check drives a browser, and the CI runner has no Edge`,
      );
    }
    if (!job.build) {
      report(
        "csp-missing-build",
        `the job \`${name}\` builds nothing — \`next dev\` serves a laxer policy, so the check only means something against a production build`,
      );
    }
    if (job.server === "") {
      report(
        "csp-missing-server",
        `the job \`${name}\` starts no server — the check asserts against a running one`,
      );
    }
    if (job.basePort === null) {
      report(
        "csp-missing-base-url",
        `the check in the job \`${name}\` names no \`--base\` URL — it would probe its default port instead of the server the job started`,
      );
    } else if (job.server !== "" && job.basePort !== job.serverPort) {
      report(
        "csp-port-mismatch",
        `the check in the job \`${name}\` probes port ${job.basePort}, the server listens on port ${job.serverPort}`,
      );
    }
    if (!job.chromium) {
      report(
        "csp-edge-browser",
        `the check in the job \`${name}\` does not select the bundled Chromium (\`--browser chromium\`) — it defaults to Edge, which the CI runner does not provide`,
      );
    }
  }

  return violations;
}

// --- the command line ------------------------------------------------------

/** The path a file argument points at. */
function workflowPath(file) {
  return isAbsolute(file) ? file : resolve(ROOT, file);
}

const USAGE = `usage: check-csp-gate.mjs [<file>…]

  (no arguments)  check ${OWNED_WORKFLOW} — the workflow this gate owns
  <file>…         check the given workflows (paths are resolved against the
                  repository root)`;

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const files = argv.length > 0 ? argv : [OWNED_WORKFLOW];

  let count = 0;
  for (const file of files) {
    let source;
    try {
      source = readFileSync(workflowPath(file), "utf8");
    } catch (error) {
      console.error(`${file}: cannot read the workflow: ${error.message}`);
      count += 1;
      continue;
    }
    for (const violation of auditCspGate(source, { file })) {
      console.error(`${violation.file}: ${violation.rule}: ${violation.message}`);
      count += 1;
    }
  }
  if (count === 0) {
    console.log(`CSP gate — the check runs in CI (${files.join(", ")})`);
    return;
  }
  console.error(`\n${count} CSP gate problem(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2));
}
