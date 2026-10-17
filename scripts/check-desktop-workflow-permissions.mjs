#!/usr/bin/env node
/**
 * Workflow-permission gate for the desktop workflow.
 *
 * The hole it closes: a GitHub Actions workflow that declares `permissions:` at
 * the *workflow* level hands that scope to every job — including the jobs a
 * pull request reaches. `actions/checkout` persists the token in `.git/config`
 * by default, and `npm ci` runs the repository's own `postinstall`, so a pull
 * request that touches `package.json` could read the token out of the checkout
 * and the signing secrets out of the step environment.
 *
 * The rules:
 *  · a workflow-level `permissions:` block must not grant a write scope — it
 *    applies to every job, the pull-request ones included;
 *  · a job a pull request can reach must not name a secret at all;
 *  · a write scope may only live in a job that a tag push alone reaches (the
 *    release job);
 *  · `actions/checkout` must not keep the token (`persist-credentials: false`),
 *    because the step right after it installs dependencies.
 *
 * There is no YAML parser in the dependency tree, so this reads the subset of
 * YAML that GitHub workflows use: block mappings, block sequences, flow
 * scalars, block scalars and comments. A file it cannot read is an error, never
 * a silent pass.
 *
 * Scope: this gate owns the *desktop* workflow — `.github/workflows/desktop.yml`
 * — the workflow the finding behind it is about. The command line checks that
 * workflow by default and nothing else, because the repository is not clean
 * everywhere yet: the site workflow still has a workflow-level write scope of
 * its own (a separate finding with its own fix) and the CI workflow still
 * checks out with the token in `.git/config`. `--all` checks every workflow
 * and is meant for the day the repository as a whole is clean.
 *
 * The gate that runs in CI is the vitest file next to this one (`npm test` picks
 * it up); this script is the same rules, usable by hand:
 *
 *   node scripts/check-desktop-workflow-permissions.mjs             # desktop.yml
 *   node scripts/check-desktop-workflow-permissions.mjs --all       # every workflow
 *   node scripts/check-desktop-workflow-permissions.mjs <file>…     # the given files
 *
 * Paths are resolved against the repository root, so the command works from
 * any directory.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- a small YAML reader ---------------------------------------------------

/** A `#` starts a comment when it is outside quotes and follows a space. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const isBlank = (line) => line.trim() === "" || line.trim().startsWith("#");
const indentOf = (line) => line.length - line.trimStart().length;
const isSeqItem = (line) => /^\s*-\s/.test(line) || /^\s*-$/.test(line);
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;

/** The `:` that separates a key from its value — the first one outside quotes. */
function keyColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

const unquote = (text) =>
  (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
    ? text.slice(1, -1)
    : text;

function skipBlank(lines, state) {
  while (state.i < lines.length && isBlank(lines[state.i])) state.i += 1;
}

/** The block that belongs to a key: a deeper block, or a sequence at its level. */
function parseChild(lines, state, indent) {
  skipBlank(lines, state);
  if (state.i >= lines.length) return { value: null, next: state.i };
  const raw = lines[state.i];
  const ind = indentOf(raw);
  if (ind > indent) {
    const value = parseNode(lines, state, ind);
    return { value, next: state.i };
  }
  if (ind === indent && isSeqItem(raw)) {
    const value = parseSeq(lines, state, ind);
    return { value, next: state.i };
  }
  return { value: null, next: state.i };
}

function readBlockScalar(lines, state, indent) {
  const body = [];
  let base = null;
  while (state.i < lines.length) {
    const raw = lines[state.i];
    if (raw.trim() === "") {
      body.push("");
      state.i += 1;
      continue;
    }
    const ind = indentOf(raw);
    if (ind <= indent) break;
    if (base === null) base = ind;
    body.push(raw.slice(base));
    state.i += 1;
  }
  return body.join("\n").trim();
}

function parseMap(lines, state, indent) {
  const map = new Map();
  for (;;) {
    skipBlank(lines, state);
    if (state.i >= lines.length) break;
    const raw = lines[state.i];
    const ind = indentOf(raw);
    if (ind < indent) break;
    if (ind > indent) throw new Error(`unexpected indentation: ${raw.trim()}`);
    if (isSeqItem(raw)) break;
    const text = stripComment(raw).trim();
    if (text === "") {
      state.i += 1;
      continue;
    }
    const colon = keyColon(text);
    if (colon < 0) throw new Error(`not a mapping entry: ${text}`);
    const key = unquote(text.slice(0, colon).trim());
    const rest = text.slice(colon + 1).trim();
    state.i += 1;
    if (rest === "") {
      const child = parseChild(lines, state, indent);
      map.set(key, child.value);
      state.i = child.next;
    } else if (BLOCK_SCALAR.test(rest)) {
      map.set(key, readBlockScalar(lines, state, indent));
    } else {
      map.set(key, rest);
    }
  }
  return map;
}

function parseSeq(lines, state, indent) {
  const items = [];
  for (;;) {
    skipBlank(lines, state);
    if (state.i >= lines.length) break;
    const raw = lines[state.i];
    const ind = indentOf(raw);
    if (ind !== indent || !isSeqItem(raw)) break;
    const text = stripComment(raw).trim();
    const after = text.slice(1);
    const content = after.trim();
    const contentIndent = ind + 1 + (after.length - after.trimStart().length);
    state.i += 1;
    if (content === "") {
      const child = parseChild(lines, state, ind);
      items.push(child.value);
      state.i = child.next;
      continue;
    }
    const colon = keyColon(content);
    if (colon < 0) {
      items.push(content);
      continue;
    }
    const key = unquote(content.slice(0, colon).trim());
    const rest = content.slice(colon + 1).trim();
    const map = new Map();
    if (rest === "") {
      const child = parseChild(lines, state, contentIndent - 1);
      map.set(key, child.value);
      state.i = child.next;
    } else {
      map.set(key, rest);
    }
    const rest2 = parseMap(lines, state, contentIndent);
    for (const [k, v] of rest2) map.set(k, v);
    items.push(map);
  }
  return items;
}

function parseNode(lines, state, indent) {
  skipBlank(lines, state);
  if (state.i >= lines.length) return null;
  const ind = indentOf(lines[state.i]);
  if (ind < indent) return null;
  if (isSeqItem(lines[state.i])) return parseSeq(lines, state, ind);
  return parseMap(lines, state, ind);
}

/**
 * Reads a workflow into a map: `on`, `permissions`, `jobs` (each job a map
 * with `permissions`, `if` and `steps`).
 */
export function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const state = { i: 0 };
  const parsed = parseNode(lines, state, 0);
  return parsed instanceof Map ? parsed : new Map();
}

// --- the rules -------------------------------------------------------------

/**
 * The entries of a flow collection — `{ a: 1, b: 2 }` → ["a: 1", "b: 2"],
 * `[a, b]` → ["a", "b"]. Nested collections stay whole.
 */
function splitFlowEntries(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The `:` that separates a key from its value inside a flow collection. */
function flowColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") return i;
  }
  return -1;
}

/**
 * A flow mapping — `{ contents: write }` → Map { contents → "write" }. The
 * parser keeps flow collections as text, so the rules that care about them
 * read them here.
 */
function parseFlowMapping(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const map = new Map();
  for (const entry of splitFlowEntries(trimmed.slice(1, -1))) {
    const colon = flowColon(entry);
    if (colon < 0) continue;
    map.set(unquote(entry.slice(0, colon).trim()), unquote(entry.slice(colon + 1).trim()));
  }
  return map;
}

/** A flow sequence — `[push, pull_request]` → ["push", "pull_request"]. */
function parseFlowSequence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return splitFlowEntries(trimmed.slice(1, -1)).map((entry) => unquote(entry));
}

/** The permission values that grant a write scope. */
const WRITE_GRANTS = new Set(["write", "write-all"]);

/** True when a permission value grants a write scope. */
export function isWriteGrant(value) {
  return typeof value === "string" && WRITE_GRANTS.has(value.trim().toLowerCase());
}

/** How a grant reads in a message: `contents: write`, or `every scope`. */
function describeGrant(scope, value) {
  const grant = value.trim();
  if (scope === "all" && grant.toLowerCase().endsWith("-all")) {
    return `every scope (\`${grant}\`)`;
  }
  return `\`${scope}: ${grant}\``;
}

/** The `permissions:` block as scope → value. */
export function permissionMap(value) {
  if (value instanceof Map) return [...value.entries()];
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return [];
    if (text.startsWith("{")) {
      const flow = parseFlowMapping(text);
      return flow ? [...flow.entries()] : [];
    }
    // The scalar forms: `read`, `read-all`, `write`, `write-all`.
    return [["all", unquote(text)]];
  }
  return [];
}

/**
 * The triggers of a workflow (`push`, `pull_request`, …).
 *
 * The trigger block has three shapes: a block mapping (`on:` with keys under
 * it), a flow mapping (`on: { pull_request: … }`) and a scalar (`on:
 * pull_request`). The last two are as valid as the first, and a trigger block
 * the reader cannot read means the pull-request rules go quiet — so all three
 * are read.
 */
export function triggerNames(on) {
  if (on instanceof Map) return [...on.keys()];
  if (Array.isArray(on)) return on;
  if (typeof on === "string") {
    const text = on.trim();
    if (text === "") return [];
    if (text.startsWith("{")) {
      const flow = parseFlowMapping(text);
      return flow ? [...flow.keys()] : [];
    }
    if (text.startsWith("[")) return parseFlowSequence(text) ?? [];
    return [unquote(text)];
  }
  return [];
}

/**
 * The tag gates this gate understands: a check that demands a *tag* of the
 * commit. `github.ref` is the ref the workflow runs for — a pull request runs
 * it for `refs/pull/<n>/merge`, never for a tag — and `github.ref_type` is
 * `tag` exactly on a tag push.
 */
const TAG_CHECKS = [
  /startsWith\s*\(\s*github\.ref\s*,\s*['"]refs\/tags\//,
  /contains\s*\(\s*github\.ref\s*,\s*['"]refs\/tags\//,
  /github\.ref\s*==\s*['"]refs\/tags\/[^'"]*['"]/,
  /github\.ref_type\s*==\s*['"]tag['"]/,
];

/**
 * A job that only a tag push reaches.
 *
 * The condition has to demand a tag of the *commit*: `github.ref` (or
 * `github.ref_type == 'tag'`). A condition on `github.head_ref` asks for the
 * pull request's head *branch*, and a branch may be named `refs/tags/…`, so it
 * says nothing about a tag push — a pull request can satisfy it. A negated
 * check (`!startsWith(…)`) is the other way round: that is the path *without* a
 * tag.
 */
export function isTagGated(condition) {
  if (typeof condition !== "string") return false;
  if (/\bhead_ref\b/.test(condition) || /\bhead_branch\b/.test(condition)) return false;
  for (const check of TAG_CHECKS) {
    const match = check.exec(condition);
    if (!match) continue;
    const before = condition.slice(0, match.index).replace(/\s+$/, "");
    // `!startsWith(…)` and `!(startsWith(…))` are the path *without* a tag.
    if (/!(?:\s*\(\s*)?$/.test(before)) continue;
    return true;
  }
  return false;
}

/** A job that explicitly keeps pull requests out (`event_name != 'pull_request'`). */
export function excludesPullRequest(condition) {
  if (typeof condition !== "string") return false;
  return condition.includes("pull_request") && condition.includes("!=");
}

const stepsOf = (job) => (Array.isArray(job.get("steps")) ? job.get("steps") : []);

const isCheckout = (step) =>
  step instanceof Map && typeof step.get("uses") === "string" && step.get("uses").startsWith("actions/checkout");

/** True when the checkout step drops the token instead of persisting it. */
export function persistCredentialsDisabled(step) {
  const with_ = step.get("with");
  if (with_ instanceof Map) {
    const value = with_.get("persist-credentials");
    return typeof value === "string" && value.trim().toLowerCase() === "false";
  }
  if (typeof with_ === "string") return /persist-credentials\s*:\s*false/i.test(with_);
  return false;
}

/** Every string in a value, so a secret reference cannot hide in a nested map. */
function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value instanceof Map) for (const nested of value.values()) stringsIn(nested, out);
  else if (Array.isArray(value)) for (const nested of value) stringsIn(nested, out);
  return out;
}

/**
 * A secret reference: `secrets.NAME` or `secrets['NAME']`. Only the name
 * syntax counts — `secrets.` on its own is a file name, not a reference.
 */
const SECRET_REFERENCE = /\bsecrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*|\[\s*['"][^'"]+['"]\s*\])/;

/** The `${{ … }}` expressions in a text. */
function expressions(text) {
  const found = [];
  const pattern = /\$\{\{([\s\S]*?)\}\}/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push(match[1]);
  }
  return found;
}

/**
 * True when the job names a secret.
 *
 * A secret exists only inside an expression — `${{ secrets.NAME }}` or
 * `${{ secrets['NAME'] }}`. A bare `secrets.` in a command (`node
 * scripts/check-secrets.mjs`) is a file name, and a secret named in the
 * workflow's own text is no secret at all.
 */
export function referencesSecret(job) {
  return stringsIn(job).some((text) =>
    expressions(text).some((expression) => SECRET_REFERENCE.test(expression)),
  );
}

/**
 * The permission holes of one workflow.
 *
 * @param {string} text the workflow source
 * @param {{ file?: string }} [options]
 * @returns {{ rule: string, message: string }[]}
 */
export function auditWorkflow(text, { file = "workflow" } = {}) {
  const violations = [];
  const workflow = parseWorkflow(text);
  const pullRequestReachable = triggerNames(workflow.get("on")).includes("pull_request");

  for (const [scope, value] of permissionMap(workflow.get("permissions"))) {
    if (isWriteGrant(value)) {
      violations.push({
        rule: "workflow-write-permission",
        message: `the workflow-level permissions grant ${describeGrant(scope, value)} — it applies to every job, the pull-request ones included`,
      });
    }
  }

  const jobs = workflow.get("jobs");
  for (const [name, job] of jobs instanceof Map ? jobs : []) {
    const condition = job.get("if");
    const tagGated = isTagGated(condition);
    const prReachable = pullRequestReachable && !tagGated && !excludesPullRequest(condition);

    for (const [scope, value] of permissionMap(job.get("permissions"))) {
      if (isWriteGrant(value) && !tagGated) {
        violations.push({
          rule: "write-permission-outside-release",
          message: `the job \`${name}\` grants ${describeGrant(scope, value)} outside a tag-gated release job`,
        });
      }
    }

    if (prReachable && referencesSecret(job)) {
      violations.push({
        rule: "secret-in-pull-request-job",
        message: `the job \`${name}\` runs for pull requests and names a secret — a pull request must never see one`,
      });
    }

    if (!prReachable) continue;
    for (const step of stepsOf(job)) {
      if (!isCheckout(step)) continue;
      if (!persistCredentialsDisabled(step)) {
        violations.push({
          rule: "checkout-persists-credentials",
          message: `the job \`${name}\` checks out without \`persist-credentials: false\` — the token stays in .git/config for the next step to read`,
        });
      }
    }
  }

  return violations.map((violation) => ({ file, ...violation }));
}

// --- the command line ------------------------------------------------------

/** The workflow this gate owns — the desktop workflow. */
export const OWNED_WORKFLOW = ".github/workflows/desktop.yml";

/** Every workflow in the repository, as paths relative to the root. */
export function workflowFiles() {
  const dir = join(ROOT, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

/**
 * The workflows the command line checks when it is not told otherwise: the
 * one this gate owns. The repository is not clean everywhere yet — the site
 * workflow has a workflow-level write scope of its own — so a run that is not
 * asked for must not fail over a workflow this gate does not own.
 */
export function defaultFiles() {
  return [OWNED_WORKFLOW];
}

const USAGE = `usage: check-desktop-workflow-permissions.mjs [--all] [<file>…]

  (no arguments)  check ${OWNED_WORKFLOW} — the workflow this gate owns
  --all            check every workflow in .github/workflows/; the whole
                  repository has to be clean for this to pass (the site
                  workflow's own finding is tracked separately)
  <file>…         check the given workflows (paths are resolved against the
                  repository root)`;

/** The path a file argument points at. */
function workflowPath(file) {
  return isAbsolute(file) ? file : resolve(ROOT, file);
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const all = argv.includes("--all");
  const given = argv.filter((arg) => arg !== "--all");
  const files = all ? workflowFiles() : given.length > 0 ? given : defaultFiles();

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
    for (const violation of auditWorkflow(source, { file })) {
      console.error(`${violation.file}: ${violation.rule}: ${violation.message}`);
      count += 1;
    }
  }
  if (count === 0) {
    console.log(`workflow permissions — no hole found (${files.join(", ")})`);
    return;
  }
  console.error(`\n${count} workflow permission problem(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2));
}
