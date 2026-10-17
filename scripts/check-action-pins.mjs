#!/usr/bin/env node
/**
 * Action-pin gate: every action a workflow runs must be pinned to a commit
 * SHA, and every tool a workflow installs must be pinned to an exact version.
 *
 * The hole it closes: a workflow that names an action by tag
 * (`actions/checkout@v4`) runs whatever that tag points at *on the day the job
 * runs*. A tag is a movable pointer — its owner can move it, and whoever
 * moves it executes their code inside this repository's jobs. One of the
 * actions in `desktop.yml` (`tauri-apps/tauri-action`) runs in the release
 * job, the one that holds `GITHUB_TOKEN` and the Apple and Windows signing
 * secrets: a moved tag there is a moved signing key. The tools a workflow
 * installs are the same hole in another shape — `cargo install tauri-cli
 * --version "^2"` resolves to whatever the newest 2.x is when the job runs.
 *
 * The rules:
 *  · a `uses:` reference must name a commit SHA (40 hex characters). A tag, a
 *    branch or `main` is not a version, it is a promise;
 *  · the version goes behind the SHA as a trailing comment, so a reader — and
 *    the next bump — knows which release the SHA is;
 *  · a tool a workflow installs must be pinned to an exact version: no range,
 *    no "newest 2.x";
 *  · a tool that is cached must be cached under a key that carries its
 *    version. Otherwise the cache restores the *old* binary, the install step
 *    skips itself (the binary is already on the PATH) and the pin is a lie.
 *
 * There is no YAML parser in the dependency tree and this gate does not need
 * one: what it looks for is a literal on a line — the reference, the comment
 * behind it, the install command. So it reads the workflow line by line and
 * knows the two shapes that would hide a reference from it: a commented-out
 * step (not a step) and the body of a block scalar (`run: |` — text, not
 * keys).
 *
 * Scope: the workflows in `.github/workflows/`. A local action (`./…`,
 * `$/…`) is part of this repository and needs no SHA; a container action
 * (`docker://…`) is an image reference rather than a git ref, and is pinned
 * by digest (that is the container finding, not this one).
 *
 * The gate that runs in CI is the vitest file next to this one (`npm test`
 * picks it up); this script is the same rules, usable by hand:
 *
 *   node scripts/check-action-pins.mjs              # every workflow
 *   node scripts/check-action-pins.mjs <file>…      # the given workflows
 *
 * Paths are resolved against the repository root, so the command works from
 * any directory.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A commit SHA — 40 hex characters, the only immutable ref there is. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** `owner/repo@ref` — a reference to an action in another repository. */
const ACTION_REFERENCE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)@(.+)$/;

/** A version in a trailing comment: `v4.4.0`, `v4`, `stable`, `nightly`. */
const VERSION_MARKER = /\bv?\d+(?:\.\d+)*\b|\b(?:stable|nightly|beta)\b/;

/** An exact version — `2.12.3`, never a range like `^2` or `2.12`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** A `uses:` key, with or without the list dash in front of it. */
const USES_KEY = /^\s*(?:-\s+)?uses:\s*(.*)$/;

/** A cache key. */
const KEY = /^\s*key:\s*(.+)$/;

/** `cargo install <crate>`. */
const CARGO_INSTALL = /cargo\s+install\s+([A-Za-z0-9_-]+)/;

/** The version flag of an install command. */
const VERSION_FLAG = /--version[=\s]+("[^"]*"|'[^']*'|\S+)/;

/**
 * Split a line into its value and the comment that follows it. A `#` starts
 * a comment when it is outside quotes and follows a space.
 */
function splitComment(line) {
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
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return { value: line.slice(0, i), comment: line.slice(i + 1).trim() };
    }
  }
  return { value: line, comment: "" };
}

/** The value of a scalar, without the quotes YAML puts around it. */
const unquote = (text) =>
  (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
    ? text.slice(1, -1)
    : text;

/**
 * True for a reference that does not point at another repository: a local
 * action (part of this repository) or a container image.
 */
function isLocalReference(reference) {
  return (
    reference.startsWith("./") ||
    reference.startsWith("$/") ||
    reference.startsWith("docker://")
  );
}

/**
 * What a workflow names: the actions it runs, the tools it installs and the
 * cache keys it writes.
 *
 * @param {string} text the workflow source
 * @returns {{ references: { line: number, reference: string, comment: string }[],
 *             tools: { line: number, crate: string, version: string, exact: boolean }[],
 *             keys: { line: number, value: string }[] }}
 */
export function scanWorkflow(text) {
  const references = [];
  const tools = [];
  const keys = [];
  const lines = text.split(/\r?\n/);
  /** The indentation of the key that opened the block scalar being read. */
  let blockIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    // The body of a block scalar (`run: |`) is text, not YAML keys.
    const inBlock = blockIndent !== null && (trimmed === "" || indent > blockIndent);
    if (blockIndent !== null && !inBlock) blockIndent = null;

    // A commented-out step is not a step.
    if (trimmed.startsWith("#")) continue;

    if (!inBlock) {
      const uses = USES_KEY.exec(raw);
      if (uses) {
        const { value, comment } = splitComment(uses[1]);
        references.push({ line, reference: unquote(value.trim()), comment });
        continue;
      }

      const key = KEY.exec(raw);
      if (key) keys.push({ line, value: unquote(key[1].trim()) });

      // The start of a block scalar: its body is text, not keys.
      if (/^\s*(?:-\s+)?[A-Za-z0-9_.-]+:\s*[|>][-+]?\d*\s*$/.test(raw)) {
        blockIndent = indent;
        continue;
      }
    }

    const install = CARGO_INSTALL.exec(raw);
    if (!install) continue;
    const crate = install[1];
    const flag = VERSION_FLAG.exec(raw);
    const version = flag ? unquote(flag[1].trim()) : "";
    tools.push({ line, crate, version, exact: EXACT_VERSION.test(version) });
  }

  return { references, tools, keys };
}

/**
 * The pin holes of one workflow.
 *
 * @param {string} text the workflow source
 * @param {{ file?: string }} [options]
 * @returns {{ file: string, line: number, rule: string, message: string }[]}
 */
export function auditWorkflow(text, { file = "workflow" } = {}) {
  const violations = [];
  const { references, tools, keys } = scanWorkflow(text);

  for (const { line, reference, comment } of references) {
    if (reference === "") {
      violations.push({
        file,
        line,
        rule: "action-reference-unreadable",
        message: "the `uses:` step names no action — a step without a reference cannot be pinned",
      });
      continue;
    }
    if (isLocalReference(reference)) continue;
    const match = ACTION_REFERENCE.exec(reference);
    if (!match) {
      violations.push({
        file,
        line,
        rule: "action-not-pinned-by-sha",
        message: `the reference \`${reference}\` is not \`owner/repo@ref\` — pin it to a commit SHA`,
      });
      continue;
    }
    const [, owner, repo, ref] = match;
    if (!COMMIT_SHA.test(ref)) {
      violations.push({
        file,
        line,
        rule: "action-not-pinned-by-sha",
        message: `\`${owner}/${repo}@${ref}\` names a movable ref — a tag or a branch can be moved, so pin it to a commit SHA`,
      });
      continue;
    }
    if (!VERSION_MARKER.test(comment)) {
      violations.push({
        file,
        line,
        rule: "action-version-comment-missing",
        message: `\`${owner}/${repo}@${ref}\` carries no version — write it behind the SHA as a trailing comment (\`# v1.2.3\`)`,
      });
    }
  }

  for (const tool of tools) {
    if (!tool.version) {
      violations.push({
        file,
        line: tool.line,
        rule: "tool-version-not-exact",
        message: `\`${tool.crate}\` is installed without a version — pin it to an exact version (\`--version "1.2.3"\`)`,
      });
      continue;
    }
    if (!tool.exact) {
      violations.push({
        file,
        line: tool.line,
        rule: "tool-version-not-exact",
        message: `\`${tool.crate}\` is installed with the version \`${tool.version}\` — a range resolves to a different release over time, so pin it to an exact version`,
      });
    }
  }

  // A cached tool must be cached under a key that carries its version.
  for (const tool of tools) {
    if (!tool.exact) continue;
    for (const key of keys) {
      if (!key.value.includes(tool.crate)) continue;
      if (key.value.includes(tool.version)) continue;
      violations.push({
        file,
        line: key.line,
        rule: "tool-cache-key-misses-version",
        message: `the cache key \`${key.value}\` caches \`${tool.crate}\` without its pinned version ${tool.version} — the cache would restore the old binary and the pinned install would be skipped`,
      });
    }
  }

  return violations;
}

// --- the command line ------------------------------------------------------

/** Every workflow in the repository, as paths relative to the root. */
export function workflowFiles() {
  const dir = join(ROOT, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

const USAGE = `usage: check-action-pins.mjs [<file>…]

  (no arguments)  check every workflow in .github/workflows/
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
  const files = argv.length > 0 ? argv : workflowFiles();

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
    // One place, one problem: the same rule can be found twice for one line
    // (a cache key that misses the version of a tool that is installed twice
    // in the file), and the report says how many places there are.
    const seen = new Set();
    for (const violation of auditWorkflow(source, { file })) {
      const fingerprint = `${violation.file}:${violation.line}:${violation.rule}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.message}`);
      count += 1;
    }
  }
  if (count === 0) {
    console.log(`action pins — every action is pinned to a commit SHA (${files.join(", ")})`);
    return;
  }
  console.error(`\n${count} action pin problem(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2));
}
