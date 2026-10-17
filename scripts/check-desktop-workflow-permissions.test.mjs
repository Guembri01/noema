// Regression test for the desktop workflow's token permissions (B50).
//
// The hole: `desktop.yml` declared `permissions: contents: write` at the
// *workflow* level, so every job — including the ones a pull request reaches
// — held a write-scoped token. `actions/checkout` persisted that token in
// `.git/config`, `npm ci` ran the repository's own `postinstall`, and the
// Apple/Windows signing secrets sat in the same job's environment.
//
// The gate: a workflow-level write scope, a secret in a job a pull request can
// reach, a write scope outside a tag-gated release job, and a checkout that
// keeps the token are all holes. The scanner lives in
// `scripts/check-desktop-workflow-permissions.mjs`; this file pins it against
// the workflow as it was (red) and as it is (green).
//
// Scope: the gate owns the *desktop* workflow. The repository-wide assertions
// are the ones that hold for the whole repository — the site workflow's own
// write scope is a separate finding with its own fix, so it is not asserted
// here.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OWNED_WORKFLOW,
  auditWorkflow,
  defaultFiles,
  isTagGated,
  parseWorkflow,
  persistCredentialsDisabled,
  referencesSecret,
  triggerNames,
  workflowFiles,
} from "./check-desktop-workflow-permissions.mjs";

const WORKFLOW_FILE = fileURLToPath(new URL("../.github/workflows/desktop.yml", import.meta.url));
const workflowSource = () => readFileSync(WORKFLOW_FILE, "utf8");

/** The workflow files in the repository, by name. */
const workflowFileNames = () => {
  const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
};

/**
 * The desktop workflow as it was before the fix, cut to the parts the rules
 * read: a workflow-level write scope, a checkout that keeps the token, and
 * the signing secrets in the environment of the job a pull request reaches.
 */
const VULNERABLE_WORKFLOW = `name: desktop

on:
  push:
    tags: ["v*"]
    branches: [main]
  pull_request:
    paths:
      - "src-tauri/**"

permissions:
  contents: write

jobs:
  build:
    name: \${{ matrix.name }}
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci

      - name: Build the app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
          WINDOWS_CERTIFICATE: \${{ secrets.WINDOWS_CERTIFICATE }}
        with:
          args: --target \${{ matrix.rust-target }} --bundles \${{ matrix.bundles }}
          tagName: \${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
`;

describe("the pre-fix desktop workflow", () => {
  const violations = auditWorkflow(VULNERABLE_WORKFLOW, { file: "desktop.yml" });
  const rules = violations.map((violation) => violation.rule);

  it("is flagged for the workflow-level write scope", () => {
    expect(rules).toContain("workflow-write-permission");
  });

  it("is flagged for the checkout that keeps the token", () => {
    expect(rules).toContain("checkout-persists-credentials");
  });

  it("is flagged for the secrets in a job a pull request reaches", () => {
    expect(rules).toContain("secret-in-pull-request-job");
  });

  it("has no release job that could hold the write scope", () => {
    // The pre-fix workflow had no release job at all: the write scope sat on
    // the workflow, so the job a pull request reaches held it.
    expect(rules).toContain("workflow-write-permission");
    expect(rules).not.toContain("write-permission-outside-release");
  });
});

describe("the desktop workflow", () => {
  it("has no write scope at the workflow level", () => {
    const permissions = parseWorkflow(workflowSource()).get("permissions");
    expect(permissions.get("contents")).toBe("read");
    expect(auditWorkflow(workflowSource(), { file: "desktop.yml" })).toEqual([]);
  });

  it("never persists the token in a checkout", () => {
    const jobs = parseWorkflow(workflowSource()).get("jobs");
    const checkouts = [];
    for (const job of jobs.values()) {
      for (const step of job.get("steps") ?? []) {
        if (typeof step.get("uses") === "string" && step.get("uses").startsWith("actions/checkout")) {
          checkouts.push(step);
        }
      }
    }
    // The workflow checks out three times (build, release, payload smoke).
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(persistCredentialsDisabled(step)).toBe(true);
    }
    // The exact count is deliberate: a fourth checkout has to be a conscious
    // decision, not a copy-paste that hands the token to a new job.
    expect(checkouts).toHaveLength(3);
  });

  it("names a secret only in the tag-gated release job", () => {
    const jobs = parseWorkflow(workflowSource()).get("jobs");
    for (const [name, job] of jobs) {
      if (name === "release") continue;
      expect(referencesSecret(job)).toBe(false);
    }
  });

  it("keeps the write scope and the signing secrets in the release job", () => {
    const jobs = parseWorkflow(workflowSource()).get("jobs");
    const release = jobs.get("release");
    expect(release).toBeDefined();
    expect(release.get("permissions").get("contents")).toBe("write");
    expect(isTagGated(release.get("if"))).toBe(true);
    expect(referencesSecret(release)).toBe(true);

    // The release job is the only one that may hold a write scope, and it may
    // only hold it because a tag push alone reaches it.
    for (const [name, job] of jobs) {
      if (name === "release") continue;
      expect(job.get("permissions")?.get("contents") ?? "read").not.toBe("write");
    }
  });

  it("is reached by a pull request — the case the fix has to survive", () => {
    const workflow = parseWorkflow(workflowSource());
    expect(triggerNames(workflow.get("on"))).toContain("pull_request");
    // The exact job list is deliberate: a new job that a pull request can
    // reach has to be reviewed, not inherited by accident.
    expect([...workflow.get("jobs").keys()]).toEqual(["build", "release", "payload-smoke"]);
  });

  it("gives no workflow a `contents: write` at the workflow level", () => {
    // The site workflow's workflow-level `packages: write` is a separate
    // finding with its own fix; this gate owns the desktop workflow, so the
    // repository-wide rule is asserted for `contents` and the desktop rule for
    // both scopes.
    for (const name of workflowFileNames()) {
      const workflow = parseWorkflow(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
      const permissions = workflow.get("permissions");
      expect(permissions?.get("contents") ?? "none").not.toBe("write");
    }
  });
});

describe("the scanner", () => {
  it("flags a workflow-level write scope in any workflow", () => {
    const rules = auditWorkflow(
      `on:\n  pull_request:\npermissions:\n  contents: write\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("workflow-write-permission");
  });

  it("flags a job-level write scope that a pull request can reach", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  pull_request:",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: write",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("write-permission-outside-release");
  });

  it("accepts a write scope in a tag-gated release job", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  push:",
        "    tags: ['v*']",
        "  pull_request:",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  release:",
        "    if: ${{ startsWith(github.ref, 'refs/tags/') }}",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: write",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "        with:",
        "          persist-credentials: false",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual([]);
  });

  it("reads the YAML the workflows use — flow values, block scalars, comments", () => {
    const workflow = parseWorkflow(
      [
        "# a comment",
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"src/**\"",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    services:",
        "      postgres:",
        "        image: postgres:16-alpine",
        "        options: >-",
        "          --health-cmd \"pg_isready -U noema\"",
        "    steps:",
        "      - uses: actions/setup-node@v4",
        "        with: { node-version: 22, cache: npm }",
        "      - run: npm ci # installs the tree",
        "",
      ].join("\n"),
    );
    expect(triggerNames(workflow.get("on"))).toEqual(["pull_request"]);
    const job = workflow.get("jobs").get("check");
    expect(job.get("runs-on")).toBe("ubuntu-latest");
    expect(job.get("services").get("postgres").get("image")).toBe("postgres:16-alpine");
    expect(job.get("steps")).toHaveLength(2);
    expect(job.get("steps")[0].get("with")).toBe("{ node-version: 22, cache: npm }");
    expect(job.get("steps")[1].get("run")).toBe("npm ci");
  });

  it("flags a workflow-level `write-all`", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  pull_request:",
        "permissions: write-all",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("workflow-write-permission");
  });

  it("flags a workflow-level write scope written as a flow mapping", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  pull_request:",
        "permissions: { contents: write, packages: read }",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("workflow-write-permission");
  });

  it("flags a job-level `write-all` a pull request can reach", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  pull_request:",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    permissions: write-all",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("write-permission-outside-release");
  });

  it("reads a tag gate only when it demands a tag of the commit", () => {
    // `github.ref` is the ref the workflow runs for — a pull request runs it
    // for `refs/pull/<n>/merge`. `github.head_ref` is the pull request's head
    // *branch*, and a branch may be named `refs/tags/…`, so a condition on it
    // says nothing about a tag push.
    expect(isTagGated("${{ startsWith(github.ref, 'refs/tags/') }}")).toBe(true);
    expect(isTagGated("${{ github.ref_type == 'tag' }}")).toBe(true);
    expect(isTagGated("${{ !startsWith(github.ref, 'refs/tags/') }}")).toBe(false);
    expect(isTagGated("${{ startsWith(github.head_ref, 'refs/tags/') }}")).toBe(false);
    expect(isTagGated("${{ github.ref == 'refs/heads/main' }}")).toBe(false);
    expect(isTagGated(undefined)).toBe(false);
  });

  it("flags a write scope and a secret in a job a branch name gates", () => {
    const rules = auditWorkflow(
      [
        "on:",
        "  pull_request:",
        "jobs:",
        "  build:",
        "    if: ${{ startsWith(github.head_ref, 'refs/tags/') }}",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: write",
        "    env:",
        "      APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toContain("write-permission-outside-release");
    expect(rules).toContain("secret-in-pull-request-job");
  });

  it("reads the trigger block in all three of its shapes", () => {
    expect(triggerNames("pull_request")).toEqual(["pull_request"]);
    expect(triggerNames("{ pull_request: { types: [opened] } }")).toEqual(["pull_request"]);
    expect(triggerNames("{ push: { branches: [main] }, pull_request: {} }")).toEqual([
      "push",
      "pull_request",
    ]);
  });

  it("keeps the pull-request rules awake for the scalar and flow trigger forms", () => {
    for (const on of ["pull_request", "{ pull_request: { types: [opened] } }"]) {
      const rules = auditWorkflow(
        [
          `on: ${on}`,
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    env:",
          "      TOKEN: ${{ secrets.GITHUB_TOKEN }}",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "",
        ].join("\n"),
        { file: "other.yml" },
      ).map((violation) => violation.rule);
      expect(rules).toContain("secret-in-pull-request-job");
      expect(rules).toContain("checkout-persists-credentials");
    }
  });

  it("reads a secret reference in both syntaxes — and nothing else", () => {
    const jobWith = (text) => new Map([["steps", [new Map([["run", text]])]]]);
    expect(referencesSecret(jobWith("${{ secrets.APPLE_CERTIFICATE }}"))).toBe(true);
    expect(referencesSecret(jobWith("${{ secrets['APPLE_CERTIFICATE'] }}"))).toBe(true);
    // A file name that ends in `secrets.` is not a secret.
    expect(referencesSecret(jobWith("node scripts/check-secrets.mjs"))).toBe(false);
    // Outside an expression there is no secret to see.
    expect(referencesSecret(jobWith("echo secrets.APPLE_CERTIFICATE"))).toBe(false);
  });
});

describe("the command line's scope", () => {
  it("checks the workflow this gate owns by default", () => {
    expect(OWNED_WORKFLOW).toBe(".github/workflows/desktop.yml");
    expect(defaultFiles()).toEqual([OWNED_WORKFLOW]);
  });

  it("audits the workflow it owns clean", () => {
    for (const file of defaultFiles()) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(auditWorkflow(source, { file })).toEqual([]);
    }
  });

  it("knows every workflow in the repository for `--all`", () => {
    expect(workflowFiles()).toContain(OWNED_WORKFLOW);
    expect(workflowFiles().length).toBeGreaterThan(1);
  });
});
