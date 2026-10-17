#!/usr/bin/env node
/**
 * Hook gate: the local pre-commit hook is a convenience, the CI step is the
 * check — and this keeps that statement true.
 *
 * The hole it closes: `.githooks/pre-commit` only runs after a contributor has
 * typed `git config core.hooksPath .githooks` in their own clone. That setting
 * is local — a repository cannot version it — and `git commit --no-verify`
 * skips the hook anyway. The hook was therefore never the boundary, but the
 * documentation called it a "gate" and left the activation step out of
 * `CONTRIBUTING.md`, the file a contributor reads before their first commit.
 *
 * The rules:
 *
 *   1. **CI enforces the checks the hook runs.** The workflow this gate owns
 *      (`.github/workflows/ci.yml`) must run `scripts/check-secrets.mjs` and
 *      `scripts/check-commit-dates.mjs` in steps that cannot be skipped: no
 *      `continue-on-error`, no swallowed exit code, no `if:` on the step, no
 *      `if:` on the job, and a `pull_request` trigger so the check also runs on
 *      the ref a pull request proposes. This is the assertion the
 *      documentation rests on — "the CI step is the check" is only true while
 *      it holds.
 *   2. **The hook stays what it is: an opt-in convenience.** It must be
 *      versioned (tracked by git) and executable, it must run both checks, and
 *      it must fail the commit when a check fails.
 *   3. **The activation is documented where a contributor looks.**
 *      `CONTRIBUTING.md` must carry the exact command
 *      `git config core.hooksPath .githooks` and name the workflow that
 *      enforces the check. Without the command the statement is not
 *      actionable, and a reader cannot tell an opt-in from a boundary.
 *
 * What it cannot prove: that the prose around the command is *true*. It pins
 * the command and the file, not the wording. Nor can it see the repository's
 * branch protection — whether a red CI run blocks the merge is a setting of
 * the repository, not of the workflow, and this gate reads neither.
 *
 * The last lines of the output are the local status: whether *this* clone has
 * the hook enabled. It is reported, never enforced — CI has no local Git
 * configuration, and a contributor is free not to install the hook.
 *
 *   npm run check:hooks
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workflow that enforces the checks — this gate owns it. */
export const OWNED_WORKFLOW = ".github/workflows/ci.yml";

/** The hook a contributor may install. */
export const HOOK_PATH = ".githooks/pre-commit";

/** The command that switches the hook on in a clone. */
export const ENABLE_COMMAND = "git config core.hooksPath .githooks";

/** The checks the hook runs — and the checks CI has to enforce. */
export const GATE_SCRIPTS = ["scripts/check-secrets.mjs", "scripts/check-commit-dates.mjs"];

// --- a small reader for the workflow ---------------------------------------

/** Remove a trailing `#` comment that is not inside a quoted string. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * A step of a workflow job.
 *
 * @typedef {object} Step
 * @property {string} name            the step's name, "" when it has none.
 * @property {string} run             the command the step runs, "" when it has none.
 * @property {string} condition       the step's `if:` expression, "" when it has none.
 * @property {string} continueOnError the step's `continue-on-error:` value.
 * @property {number} line            1-based line number in the source file.
 */

/**
 * A job of a workflow.
 *
 * @typedef {object} Job
 * @property {string} name      the job's key.
 * @property {string} condition the job's `if:` expression, "" when it has none.
 * @property {Step[]} steps     the job's steps.
 * @property {number} line      1-based line number in the source file.
 */

/** The value of a key inside a block of lines, block scalars included. */
function entryValue(entries, key) {
  for (let i = 0; i < entries.length; i += 1) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(entries[i].text.trim());
    if (!match || match[1] !== key) continue;
    const value = match[2].trim();
    if (!/^[|>][-+]?\d*$/.test(value)) return { value, line: entries[i].line };
    const keyIndent = indentOf(entries[i].text);
    const body = [];
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[j].text.trim() === "") {
        body.push("");
        continue;
      }
      if (indentOf(entries[j].text) <= keyIndent) break;
      body.push(entries[j].text.trim());
    }
    return { value: body.join("\n"), line: entries[i].line };
  }
  return { value: "", line: 0 };
}

/** The step that starts at `index`, with the lines that belong to it. */
function readStep(lines, index) {
  const first = lines[index];
  const indent = indentOf(first.text);
  // The dash is replaced by a space so the key keeps its column.
  const entries = [{ text: first.text.replace(/^(\s*)-\s*/, "$1 "), line: first.line }];
  let end = index + 1;
  while (end < lines.length) {
    const { text } = lines[end];
    if (text.trim() === "") {
      end += 1;
      continue;
    }
    if (indentOf(text) <= indent) break;
    entries.push(lines[end]);
    end += 1;
  }
  return {
    step: {
      name: entryValue(entries, "name").value,
      run: entryValue(entries, "run").value,
      condition: entryValue(entries, "if").value,
      continueOnError: entryValue(entries, "continue-on-error").value,
      line: entryValue(entries, "run").line || entryValue(entries, "name").line || first.line,
    },
    end,
  };
}

/** The triggers of a workflow: `push`, `pull_request`, … */
function triggersOf(lines) {
  const start = lines.findIndex((l) => /^on\s*:/.test(l.text) && indentOf(l.text) === 0);
  if (start === -1) return [];
  const inline = lines[start].text.replace(/^on\s*:/, "").trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const triggers = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const { text } = lines[i];
    if (text.trim() === "") continue;
    if (indentOf(text) === 0) break;
    const match = /^([A-Za-z_-]+):/.exec(text.trim());
    if (match && indentOf(text) === 2) triggers.push(match[1]);
  }
  return triggers;
}

/**
 * The jobs of a workflow, with their steps.
 *
 * This is not a YAML parser — it reads the block structure the workflow files
 * use: two-space indentation, `key: value` mappings and `- key: value` list
 * items. A file it cannot read is an error, never a silent pass.
 */
export function parseWorkflow(text) {
  const lines = text.split("\n").map((raw, index) => ({ raw, text: stripComment(raw), line: index + 1 }));
  const jobsIndex = lines.findIndex((l) => l.text.trimEnd() === "jobs:" && indentOf(l.text) === 0);
  if (jobsIndex === -1) throw new Error("no `jobs:` block");

  /** @type {Job[]} */
  const jobs = [];
  /** @type {Job | null} */
  let job = null;
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const { text, line } = lines[i];
    if (text.trim() === "") continue;
    const indent = indentOf(text);
    if (indent === 0) break;
    if (indent === 2) {
      const name = text.trim().replace(/:.*$/, "");
      job = { name, condition: "", steps: [], line };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    if (indent === 4) {
      const match = /^if\s*:\s*(.*)$/.exec(text.trim());
      if (match) job.condition = match[1].trim();
      continue;
    }
    if (indent === 6 && /^\s*-\s/.test(text)) {
      const read = readStep(lines, i);
      job.steps.push(read.step);
      i = read.end - 1;
    }
  }
  return { triggers: triggersOf(lines), jobs };
}

/** Whether a command swallows the exit code of what it runs. */
function swallowsExitCode(command) {
  return /(?:\|\||;)\s*(?:true|exit 0)\s*$/.test(command.trim());
}

/**
 * The problems of a workflow: the checks the hook runs must be enforced in CI
 * and must not be skippable.
 *
 * @returns {{ script: string | null, message: string }[]}
 */
export function auditWorkflow(text, { file = OWNED_WORKFLOW } = {}) {
  /** @type {{ script: string | null, message: string }[]} */
  const problems = [];
  const workflow = parseWorkflow(text);

  if (!workflow.triggers.includes("pull_request")) {
    problems.push({
      script: null,
      message: `${file} has no pull_request trigger — a push-only workflow does not check the ref a pull request proposes`,
    });
  }

  for (const script of GATE_SCRIPTS) {
    const anywhere = workflow.jobs.some((job) =>
      job.steps.some((step) => step.run.includes(script)),
    );
    if (!anywhere) {
      problems.push({ script, message: `${file} never runs ${script} — the check is not enforced in CI` });
    }
  }

  for (const job of workflow.jobs) {
    const steps = job.steps.filter((step) => GATE_SCRIPTS.some((script) => step.run.includes(script)));
    if (steps.length === 0) continue;
    if (job.condition) {
      problems.push({
        script: null,
        message: `${file}:${job.line} runs the checks in a job with an if: condition (${job.condition}) — they can be skipped`,
      });
    }
    for (const step of steps) {
      const script = GATE_SCRIPTS.find((candidate) => step.run.includes(candidate));
      if (/^true$/i.test(step.continueOnError.trim())) {
        problems.push({
          script,
          message: `${file}:${step.line} runs ${script} with continue-on-error: true — a failing run does not fail the job`,
        });
      }
      if (step.condition) {
        problems.push({
          script,
          message: `${file}:${step.line} runs ${script} under an if: condition — the check can be skipped`,
        });
      }
      if (swallowsExitCode(step.run)) {
        problems.push({
          script,
          message: `${file}:${step.line} swallows the exit code of ${script} — a failing run does not fail the job`,
        });
      }
    }
  }
  return problems;
}

/**
 * The problems of the hook: it must run both checks and fail the commit when
 * one of them fails.
 *
 * @returns {string[]}
 */
export function auditHook(text) {
  /** @type {string[]} */
  const problems = [];
  const lines = text.split("\n");
  if (!/^#!/.test(lines[0] ?? "")) problems.push("has no shebang — git cannot run it as a hook");
  const failsFast = lines.some((line) => /^set\s+-e\b/.test(line.trim()));
  for (const script of GATE_SCRIPTS) {
    const index = lines.findIndex((line) => line.includes(script) && !line.trimStart().startsWith("#"));
    if (index === -1) {
      problems.push(`does not run ${script}`);
      continue;
    }
    if (!failsFast && !/\|\|\s*exit\s+1\b/.test(lines[index])) {
      problems.push(`does not fail the commit when ${script} fails — the line is: ${lines[index].trim()}`);
    }
  }
  return problems;
}

/** A string that is safe to drop into a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The problems of the documentation: the activation command and the workflow
 * that enforces the check have to be where a contributor reads.
 *
 * The command is matched on a word boundary, so a paragraph that names a
 * *different* hooks path (`git config core.hooksPath .githooks-disabled`)
 * does not pass for the command a contributor has to type.
 *
 * @returns {string[]}
 */
export function auditDocs(text) {
  /** @type {string[]} */
  const problems = [];
  if (!new RegExp(`${escapeRegExp(ENABLE_COMMAND)}(?![\\w.-])`).test(text)) {
    problems.push(`does not carry the activation command \`${ENABLE_COMMAND}\``);
  }
  if (!new RegExp(`${escapeRegExp(OWNED_WORKFLOW)}(?![\\w-])`).test(text)) {
    problems.push(`does not name ${OWNED_WORKFLOW} — the workflow that enforces the check`);
  }
  return problems;
}

/**
 * The mode and the path git has for the hook.
 *
 * @returns {{ mode: string, path: string } | { error: string } | null} null when
 *   git does not track the hook at all.
 */
export function hookMode() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "--stage", "--", HOOK_PATH], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    return { error: error.message };
  }
  if (!out) return null;
  const match = /^(\d+)\s+\S+\s+\d+\t(.*)$/.exec(out);
  if (!match) return { error: `git ls-files returned an unreadable line: ${out}` };
  return { mode: match[1], path: match[2] };
}

/** The `core.hooksPath` of this clone, or null when it is not set. */
export function localHooksPath() {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const failures = [];
  const ok = (label, detail) => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  const fail = (label, detail) => {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  console.log(`hook gate — ${HOOK_PATH} is an opt-in convenience, the CI step is the check\n`);

  // 1. CI enforces the checks the hook runs.
  let workflow;
  try {
    workflow = readFileSync(join(ROOT, OWNED_WORKFLOW), "utf8");
  } catch (error) {
    fail("the CI workflow can be read", error.message);
    workflow = null;
  }
  if (workflow !== null) {
    const problems = auditWorkflow(workflow, { file: OWNED_WORKFLOW });
    if (problems.length === 0) {
      for (const script of GATE_SCRIPTS) ok(`${OWNED_WORKFLOW} enforces ${script}`);
    } else {
      for (const problem of problems) fail(problem.message);
    }
  }

  // 2. The hook is versioned, executable, and fails the commit on a bad check.
  const mode = hookMode();
  if (!mode) {
    fail(`${HOOK_PATH} is versioned`, "git does not track it — a fresh clone has no hook");
  } else if (mode.error) {
    fail(`${HOOK_PATH} is versioned`, mode.error);
  } else if (mode.mode !== "100755") {
    fail(`${HOOK_PATH} is versioned and executable`, `mode ${mode.mode}, expected 100755`);
  } else {
    ok(`${HOOK_PATH} is versioned and executable`, mode.path);
    const problems = auditHook(readFileSync(join(ROOT, HOOK_PATH), "utf8"));
    if (problems.length === 0) ok(`${HOOK_PATH} runs both checks and fails the commit on a bad one`);
    else for (const problem of problems) fail(`${HOOK_PATH} ${problem}`);
  }

  // 3. The activation is documented where a contributor looks.
  const problems = auditDocs(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8"));
  if (problems.length === 0) ok("CONTRIBUTING.md documents the activation and names the CI workflow");
  else for (const problem of problems) fail(`CONTRIBUTING.md ${problem}`);

  // The local status: reported, never enforced.
  const hooksPath = localHooksPath();
  console.log("");
  if (hooksPath === ".githooks") {
    console.log(`  local  core.hooksPath = ${hooksPath} — the hook runs in this clone`);
  } else {
    console.log(`  local  core.hooksPath is ${hooksPath ? hooksPath : "not set"} — the hook does NOT run in this clone`);
    console.log(`  local  enable it once with: ${ENABLE_COMMAND}`);
  }
  console.log("  local  the hook is optional: `git commit --no-verify` skips it, CI does not");

  console.log(`\n${failures.length === 0 ? "OK" : "FAILED"} — ${failures.length} failure(s)`);
  if (failures.length > 0) {
    console.log("\nFix the failures above, then re-run this gate.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
