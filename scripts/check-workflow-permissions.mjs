#!/usr/bin/env node
/**
 * Workflow-permission gate: pull-request code must never run with a token
 * that can publish.
 *
 * Why this exists: `.github/workflows/site.yml` ran the pull request's own
 * `Dockerfile` inside a job that held `packages: write` and `id-token: write`
 * — the scope that pushes an image to GHCR, and the scope that mints the
 * OIDC token cosign signs with. `actions/checkout` also left the token in
 * `.git/config`, where the code the pull request controls could read it.
 * The path from "a pull request" to "a tampered image in GHCR that every user
 * of the published container pulls" was open.
 *
 * The rules enforced here:
 *
 *   1. No workflow may grant a publishing scope — `packages: write` or
 *      `id-token: write` — in its **top-level** `permissions:` block. That
 *      block is inherited by every job, so it is the one that reaches
 *      pull-request code.
 *   2. A publishing scope may only appear in a job that **no pull-request
 *      event can reach**. The gate is *evaluated*, not matched: the job's
 *      `if:` expression has to be false for a `pull_request` event *and* for
 *      a `pull_request_target` event. So `github.event_name !=
 *      'pull_request'` is **not** such a gate — a `pull_request_target`
 *      event satisfies it, and that trigger runs with the base branch's code
 *      and a write token. A gate that only *mentions* a tag
 *      (`startsWith(github.ref, 'refs/tags/') || github.event_name ==
 *      'pull_request'`) is not one either.
 *   3. In a workflow that can publish, every `actions/checkout` step of a job
 *      a pull request can reach must set `persist-credentials: false`, so the
 *      token is not left in `.git/config` for the pull request's code to
 *      read.
 *   4. Every job a pull request can reach must declare its `permissions:`
 *      explicitly — at job level, or at workflow level, where it is
 *      inherited. A job without one runs with the repository's default
 *      token, whose scopes this gate cannot see, so it counts as "may
 *      publish".
 *
 * Scope: this gate knows two publishing scopes — `packages: write`, which
 * pushes an image to GHCR, and `id-token: write`, which mints the OIDC
 * token that cosign signs with. `contents: write` is out of scope here: it
 * is issue #65 (finding B50) and is fixed on its own branch. The success
 * message says exactly what was checked — nothing more.
 *
 * Limits of the YAML subset this reader understands. It is a scanner, not a
 * YAML parser, and the repository has no YAML dependency on purpose:
 *   · YAML anchors and aliases are not resolved. A `permissions:` block that
 *     uses one (`permissions: *perms`, or a `<<:` merge key) is reported
 *     instead of read — spell the scopes out.
 *   · Only `pull_request` and `pull_request_target` count as pull-request
 *     triggers. `workflow_run` and `pull_request_review` are not treated as
 *     one.
 *   · A `permissions:` value that is an expression (`permissions: ${{ … }}`)
 *     is not understood; it grants nothing as far as the gate can see.
 *
 *   npm run check:workflow-permissions
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

/* ------------------------------------------------------------------ *
 * A very small YAML reader
 *
 * The repository has no YAML dependency, and the rules above need to know
 * three things only: which block a publishing scope sits in, which steps
 * belong to which job, and what a job's `if:` says. So this is not a YAML
 * parser — it reads the block structure of the subset the workflow files
 * use: two-space indentation, `key: value` mappings, `- key: value` list
 * items, and blocks whose body is indented below them. Flow mappings
 * (`with: { a: b }`) and block scalars (`run: |`) are kept as raw values —
 * except for `if:`, whose block body *is* the gate and is kept as the value.
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Node
 * @property {string} key       The mapping key ("" for a bare list item).
 * @property {string} value     The scalar value, unquoted.
 * @property {number} line      1-based line number in the source file.
 * @property {number} indent    Indentation of the line, in columns.
 * @property {boolean} item     True for a `- ` list item.
 * @property {Node[]} children  The block below the node.
 */

/** Remove a trailing `#` comment that is not inside a quoted string. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Index of the `:` that separates a key from a value, or -1. */
function findKeySeparator(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ":" && !inSingle && !inDouble) {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

/** Drop the quotes YAML puts around a scalar. */
function unquote(value) {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/**
 * Read the block structure of a workflow file.
 *
 * @param {string} text
 * @returns {Node} The root node; its children are the top-level keys.
 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const root = { key: "", value: "", line: 0, indent: -1, item: false, children: [] };
  /** @type {Node[]} */
  const stack = [root];

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripComment(lines[index]);
    if (stripped.trim() === "") continue;

    const indent = stripped.length - stripped.trimStart().length;
    let content = stripped.trim();

    const isItem = content === "-" || content.startsWith("- ");
    if (isItem) content = content === "-" ? "" : content.slice(2).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    if (isItem) {
      // A list item holds its own mapping entry as a child, so that the block
      // below it (`with:`, `run:` …) belongs to the item and not to the
      // entry.
      const item = { key: "", value: "", line: index + 1, indent, item: true, children: [] };
      parent.children.push(item);
      stack.push(item);
      if (content === "") continue;
      const separator = findKeySeparator(content);
      if (separator === -1) continue; // not a mapping entry
      item.children.push({
        key: unquote(content.slice(0, separator).trim()),
        value: unquote(content.slice(separator + 1).trim()),
        line: index + 1,
        indent: indent + 2,
        item: false,
        children: [],
      });
      continue;
    }

    const separator = findKeySeparator(content);
    if (separator === -1) continue; // not a mapping entry
    const node = {
      key: unquote(content.slice(0, separator).trim()),
      value: unquote(content.slice(separator + 1).trim()),
      line: index + 1,
      indent,
      item: false,
      children: [],
    };
    parent.children.push(node);

    // A block scalar (`run: |`) owns the lines below it; they are program
    // text, not structure. The body of an `if:` is the opposite: it is the
    // gate itself, so it becomes the node's value.
    if (/^[|>][-+]?\d*$/.test(node.value)) {
      const body = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() === "") {
          index += 1;
          continue;
        }
        if (next.length - next.trimStart().length <= indent) break;
        index += 1;
        body.push(next.trim());
      }
      if (node.key === "if") node.value = body.join(" ").trim();
      continue;
    }

    stack.push(node);
  }

  return root;
}

/* ------------------------------------------------------------------ *
 * The GitHub expression subset
 *
 * The gate does not evaluate an expression against a concrete context. It
 * asks two structural questions about it:
 *
 *   · can a pull-request event satisfy it? (rules 2 and 3)
 *   · can a pull-request event of *either* kind satisfy it? (rule 2: the
 *     publishing job must be out of reach of both)
 *
 * Both are answered from the shape of the expression (`&&`, `||`, `!`,
 * parentheses) and from the class of every atomic term, so no context is
 * needed — and no expression is ever accepted because it *mentions* an event
 * name or a tag.
 * ------------------------------------------------------------------ */

/** The pull-request events this gate knows. They are not the same. */
const PR_KINDS = ["pull_request", "pull_request_target"];

/** Terms that hold only for a tag push. */
const TAG_TERMS = [
  /^startsWith\s*\(\s*github\.ref\s*,\s*['"]refs\/tags\//i,
  /^github\.ref\s*==\s*['"]refs\/tags\//i,
  /^github\.ref_type\s*==\s*['"]tag['"]/i,
];

/** The three values a term can have in the pull-request world. */
const TRUE = "true";
const FALSE = "false";
const UNKNOWN = "unknown";

/** Remove the `${{ … }}` wrapper GitHub allows around an expression. */
function stripExpressionWrapper(expression) {
  const text = expression.trim();
  if (text.startsWith("${{") && text.endsWith("}}")) return text.slice(3, -2).trim();
  return text;
}

/**
 * Split an expression into tokens: `&&`, `||`, `!`, `(`, `)` and terms.
 *
 * A term is a run of characters that contains no boolean operator — it may
 * hold a comparison (`github.event_name == 'pull_request'`) or a call
 * (`startsWith(github.ref, 'refs/tags/')`), and it is read as a whole.
 *
 * @param {string} text
 * @returns {{type: string, text?: string}[]}
 */
function tokenize(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (text.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (text.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "open" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "close" });
      index += 1;
      continue;
    }
    if (char === "!" && text[index + 1] !== "=") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }

    // A term runs until the next operator. Quotes are honoured, so a string
    // that holds a parenthesis does not end the term.
    let end = index;
    let inSingle = false;
    let inDouble = false;
    while (end < text.length) {
      const current = text[end];
      if (current === "'" && !inDouble) inSingle = !inSingle;
      else if (current === '"' && !inSingle) inDouble = !inDouble;
      if (!inSingle && !inDouble) {
        if (current === "(" || current === ")") break;
        if (text.startsWith("&&", end) || text.startsWith("||", end)) break;
        // A `!` that is not part of `!=` and stands on its own negates the
        // term that follows it.
        if (current === "!" && text[end + 1] !== "=" && (end === index || /\s/.test(text[end - 1]))) {
          break;
        }
      }
      end += 1;
    }

    let term = text.slice(index, end).trim();
    if (text[end] === "(") {
      // A call: take the balanced argument list with it.
      let depth = 0;
      let cursor = end;
      let callInSingle = false;
      let callInDouble = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === "'" && !callInDouble) callInSingle = !callInSingle;
        else if (current === '"' && !callInSingle) callInDouble = !callInDouble;
        if (!callInSingle && !callInDouble) {
          if (current === "(") depth += 1;
          else if (current === ")") {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
        }
        cursor += 1;
      }
      term = text.slice(index, cursor).trim();
      end = cursor;
    }

    if (term !== "") tokens.push({ type: "term", text: term });
    index = end;
  }

  return tokens;
}

/**
 * Parse an expression into a small AST.
 *
 * @param {string} text
 * @returns {object|null} The AST, or null when the expression cannot be read.
 */
function parseExpression(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  let position = 0;

  /** @returns {object|null} */
  const parseOr = () => {
    let left = parseAnd();
    if (!left) return null;
    while (tokens[position] && tokens[position].type === "or") {
      position += 1;
      const right = parseAnd();
      if (!right) return null;
      left = { type: "or", left, right };
    }
    return left;
  };

  /** @returns {object|null} */
  const parseAnd = () => {
    let left = parseUnary();
    if (!left) return null;
    while (tokens[position] && tokens[position].type === "and") {
      position += 1;
      const right = parseUnary();
      if (!right) return null;
      left = { type: "and", left, right };
    }
    return left;
  };

  /** @returns {object|null} */
  const parseUnary = () => {
    const token = tokens[position];
    if (!token) return null;
    if (token.type === "not") {
      position += 1;
      const operand = parseUnary();
      return operand ? { type: "not", operand } : null;
    }
    if (token.type === "open") {
      position += 1;
      const inner = parseOr();
      if (!inner) return null;
      if (tokens[position] && tokens[position].type === "close") position += 1;
      return inner;
    }
    if (token.type === "close") return null;
    position += 1;
    return { type: "term", text: token.text };
  };

  const ast = parseOr();
  if (!ast) return null;
  // Tokens left over mean the expression is not the one the parser read.
  if (position !== tokens.length) return null;
  return ast;
}

/** Does this term hold only for a tag push? */
function isTagTerm(text) {
  return TAG_TERMS.some((pattern) => pattern.test(text));
}

/**
 * The value of a comparison with `github.event_name` during a pull-request
 * event of the given kind.
 *
 * During a `pull_request` event the name is `pull_request`, during a
 * `pull_request_target` event it is `pull_request_target` — and nothing
 * else. So `github.event_name == 'push'` is false for both, while
 * `github.event_name != 'pull_request'` is false for the first and true for
 * the second: it rules one kind of pull request out, not both.
 *
 * @param {string} text
 * @param {string} kind  `pull_request` or `pull_request_target`.
 * @returns {string|null} TRUE, FALSE, or null when the term says nothing.
 */
function eventNameTerm(text, kind) {
  const match = /^github\.event_name\s*(==|!=)\s*['"]([^'"]+)['"]/i.exec(text);
  if (!match) return null;
  const operator = match[1];
  const value = match[2];
  return operator === "==" ? (value === kind ? TRUE : FALSE) : value === kind ? FALSE : TRUE;
}

/**
 * The value of the expression during a pull-request event of the given kind.
 *
 * A tag term is false there — a pull request's ref is never a tag, and a
 * `pull_request_target` event runs on the base branch — `github.event_name
 * == 'pull_request'` is true, and every other term is unknown: the gate
 * cannot tell, so it assumes the job may run.
 */
function duringPullRequest(node, kind) {
  switch (node.type) {
    case "term": {
      const eventName = eventNameTerm(node.text, kind);
      if (eventName) return eventName;
      if (isTagTerm(node.text)) return FALSE;
      return UNKNOWN;
    }
    case "not": {
      const inner = duringPullRequest(node.operand, kind);
      if (inner === TRUE) return FALSE;
      if (inner === FALSE) return TRUE;
      return UNKNOWN;
    }
    case "and": {
      const left = duringPullRequest(node.left, kind);
      const right = duringPullRequest(node.right, kind);
      if (left === FALSE || right === FALSE) return FALSE;
      if (left === TRUE && right === TRUE) return TRUE;
      return UNKNOWN;
    }
    case "or": {
      const left = duringPullRequest(node.left, kind);
      const right = duringPullRequest(node.right, kind);
      if (left === TRUE || right === TRUE) return TRUE;
      if (left === FALSE && right === FALSE) return FALSE;
      return UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

/**
 * Can a pull-request event of any kind reach a job with this `if:`?
 *
 * A job without a gate is reachable — that is the default.
 */
export function isPullRequestReachable(expression) {
  if (expression.trim() === "") return true;
  const ast = parseExpression(stripExpressionWrapper(expression));
  if (!ast) return true;
  return PR_KINDS.some((kind) => duringPullRequest(ast, kind) !== FALSE);
}

/**
 * Does the expression rule *every* pull-request event out?
 *
 * This is the gate a publishing job has to carry: it has to be false for a
 * `pull_request` event and for a `pull_request_target` event. An expression
 * the gate cannot read is not accepted — it is not proof that no pull
 * request reaches the job.
 */
export function excludesPullRequests(expression) {
  if (expression.trim() === "") return false;
  const ast = parseExpression(stripExpressionWrapper(expression));
  if (!ast) return false;
  return PR_KINDS.every((kind) => duringPullRequest(ast, kind) === FALSE);
}

/** Does the workflow listen to a pull request at all? */
export function hasPullRequestTrigger(top) {
  const on = top.find((node) => node.key === "on");
  if (!on) return false;
  // `pull_request_target` is the highest-risk trigger there is: it runs with
  // the base branch's code and a read/write token, even for a public fork.
  if (on.children.some((child) => child.key === "pull_request" || child.key === "pull_request_target")) {
    return true;
  }
  return /(?<![\w-])pull_request(_target)?(?![\w-])/.test(on.value);
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * The scopes this gate calls publishing.
 *
 * `packages: write` pushes an image to GHCR. `id-token: write` mints the
 * OIDC token that cosign signs with — the other half of "this job can put
 * something in front of a user". `contents: write` is *not* in this list:
 * it is issue #65 (finding B50) and lives in its own gate.
 */
const PUBLISHING_SCOPES = ["packages", "id-token"];

/** Does this `permissions:` block grant a publishing scope? */
function grantsPublishingScope(node) {
  if (node.value === "write-all") return true;
  if (
    node.children.some(
      (child) => PUBLISHING_SCOPES.includes(child.key) && child.value === "write",
    )
  ) {
    return true;
  }
  // A flow mapping on one line: `permissions: { packages: write }` — with or
  // without quotes around the value.
  return PUBLISHING_SCOPES.some((scope) =>
    new RegExp(`\\b${scope}\\s*:\\s*['"]?write['"]?(?![\\w-])`).test(node.value),
  );
}

/**
 * Is this `permissions:` block written with a YAML anchor or alias?
 *
 * The reader does not resolve anchors, so such a block is reported instead
 * of read: it is the one shape that could hide a scope from the gate.
 */
function usesAlias(node) {
  if (node.value.includes("*")) return true;
  return node.children.some((child) => child.key === "<<");
}

/**
 * The token a job runs with.
 *
 * A job's own `permissions:` block replaces the workflow-level one; without
 * either, the job runs with the repository's default token, whose scopes the
 * gate cannot see — so it is treated as a token that can publish.
 *
 * @returns {{explicit: boolean, mayPublish: boolean}}
 */
function effectiveToken(job, workflowPermissions) {
  const jobPermissions = job.children.find((node) => node.key === "permissions");
  if (jobPermissions) {
    return { explicit: true, mayPublish: grantsPublishingScope(jobPermissions) };
  }
  if (workflowPermissions) {
    return { explicit: true, mayPublish: grantsPublishingScope(workflowPermissions) };
  }
  return { explicit: false, mayPublish: true };
}

/**
 * Can this workflow publish at all?
 *
 * True when a publishing scope is granted anywhere — at workflow level, in a
 * job, or implicitly by a job that runs with the repository's default token,
 * whose scopes this gate cannot see.
 */
function workflowMayPublish(jobNodes, workflowPermissions) {
  if (workflowPermissions && grantsPublishingScope(workflowPermissions)) return true;
  for (const job of jobNodes) {
    const jobPermissions = job.children.find((node) => node.key === "permissions");
    if (jobPermissions) {
      if (grantsPublishingScope(jobPermissions)) return true;
      continue;
    }
    if (!workflowPermissions) return true; // the repository's default token
  }
  return false;
}

/**
 * Check one workflow file.
 *
 * @param {string} text     The file contents.
 * @param {string} [file]   The path used in the findings.
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function analyzeWorkflow(text, file = "workflow.yml") {
  /** @type {{file: string, line: number, rule: string, message: string}[]} */
  const findings = [];
  const top = parseWorkflow(text).children;

  const permissions = top.find((node) => node.key === "permissions");
  const jobs = top.find((node) => node.key === "jobs");
  const jobNodes = jobs ? jobs.children.filter((node) => !node.item) : [];
  const pullRequestTrigger = hasPullRequestTrigger(top);

  // Rule 1 — no publishing scope at workflow level.
  if (permissions && grantsPublishingScope(permissions)) {
    findings.push({
      file,
      line: permissions.line,
      rule: "workflow-level-publishing-scope",
      message:
        "the workflow-level `permissions:` block grants a publishing scope (`packages: write`, `id-token: write`); it applies to every job, including the ones that run pull-request code",
    });
  }

  // Rule 2 — a publishing scope only in a job no pull-request event reaches.
  for (const job of jobNodes) {
    const jobPermissions = job.children.find((node) => node.key === "permissions");
    if (!jobPermissions || !grantsPublishingScope(jobPermissions)) continue;
    const gate = job.children.find((node) => node.key === "if");
    const expression = gate ? gate.value : "";
    if (excludesPullRequests(expression)) continue;
    findings.push({
      file,
      line: jobPermissions.line,
      rule: "publishing-scope-in-pull-request-job",
      message: `the job \`${job.key}\` grants a publishing scope, but a pull-request event can reach it (if: ${expression || "none"})`,
    });
  }

  // Rule 3 — no persisted credentials in the jobs a pull request can reach.
  // The rule is scoped to the workflows that can publish at all: in such a
  // workflow the token on disk is a publishing token the moment a scope is
  // added, and the code that a pull request controls reads `.git/config`
  // before it does anything else. `contents: write` is out of scope for this
  // gate — that is issue #65 (finding B50).
  if (pullRequestTrigger && workflowMayPublish(jobNodes, permissions)) {
    for (const job of jobNodes) {
      const gate = job.children.find((node) => node.key === "if");
      if (!isPullRequestReachable(gate ? gate.value : "")) continue;
      const steps = job.children.find((node) => node.key === "steps");
      if (!steps) continue;
      for (const step of steps.children.filter((node) => node.item)) {
        const uses = step.children.find((child) => child.key === "uses");
        if (!uses || !/^actions\/checkout(@|$)/.test(uses.value)) continue;
        const withBlock = step.children.find((child) => child.key === "with");
        const persist = withBlock
          ? withBlock.children.find((child) => child.key === "persist-credentials")
          : undefined;
        const persistsNone =
          (persist && persist.value.trim().toLowerCase() === "false") ||
          // A flow mapping on one line: `with: { persist-credentials: false }`.
          (withBlock ? /\bpersist-credentials\s*:\s*false\b/.test(withBlock.value) : false);
        if (persistsNone) continue;
        findings.push({
          file,
          line: uses.line,
          rule: "persisted-credentials",
          message: `the checkout in the job \`${job.key}\` leaves the token in .git/config; a pull request can read it`,
        });
      }
    }
  }

  // Rule 4 — an explicit `permissions:` block for every job a pull request
  // can reach. Without one the job runs with the repository's default token,
  // whose scopes this gate cannot see — which is why such a job counts as
  // "may publish" above.
  if (pullRequestTrigger) {
    for (const job of jobNodes) {
      const gate = job.children.find((node) => node.key === "if");
      if (!isPullRequestReachable(gate ? gate.value : "")) continue;
      if (effectiveToken(job, permissions).explicit) continue;
      findings.push({
        file,
        line: job.line,
        rule: "missing-permissions",
        message: `the job \`${job.key}\` declares no \`permissions:\` block; it runs with the repository's default token, whose scopes this gate cannot see`,
      });
    }
  }

  // A `permissions:` block the reader cannot resolve is reported instead of
  // read — a scope hidden behind an anchor is a scope the gate cannot see.
  for (const node of [permissions, ...jobNodes.map((job) => job.children.find((child) => child.key === "permissions"))]) {
    if (!node || !usesAlias(node)) continue;
    findings.push({
      file,
      line: node.line,
      rule: "unsupported-permissions-alias",
      message:
        "the `permissions:` block uses a YAML anchor or alias; this gate cannot resolve it — spell the scopes out",
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Check every workflow file in `.github/workflows/`.
 *
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function analyzeWorkflowDirectory(directory = WORKFLOW_DIR) {
  const findings = [];
  const names = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const name of names) {
    const path = join(directory, name);
    findings.push(...analyzeWorkflow(readFileSync(path, "utf8"), relative(ROOT, path).replace(/\\/g, "/")));
  }
  return findings;
}

function main() {
  const findings = analyzeWorkflowDirectory();
  const count = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name)).length;

  console.log(`workflow-permission gate — ${count} workflow(s) scanned\n`);

  for (const finding of findings) {
    console.log(`  HOLE    ${finding.file}:${finding.line} — ${finding.message}`);
  }

  if (findings.length === 0) {
    console.log(
      "  ok      no workflow grants a publishing scope outside a job that no pull-request event can reach",
    );
    console.log(
      "          (this gate does not look at `contents: write` — that is issue #65 / B50)",
    );
    console.log("\n0 finding(s).");
    process.exit(0);
  }

  console.error(
    [
      "",
      `${findings.length} finding(s).`,
      "",
      "Grant `packages: write` and `id-token: write` in the job that publishes",
      "the image only, and gate that job so that no pull-request event can",
      "reach it — the gate has to be false for `pull_request` *and* for",
      "`pull_request_target`. Set `persist-credentials: false` on the checkout",
      "of every job a pull request can reach, and give every such job an",
      "explicit `permissions:` block — an absent block means the repository",
      "default token.",
    ].join("\n"),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
