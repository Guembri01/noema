// Regression test for the CSP gate (B82).
//
// The hole: `scripts/check-csp.mjs` asserts against a running production
// server that every inline script is nonced or hash-pinned — a very good
// gate — and it ran in no workflow at all, so a CSP regression was only ever
// noticed by hand.
//
// The gate: `scripts/check-csp-gate.mjs` reads the CI workflow and checks
// *mechanically* that a job really runs the check, that neither the step nor
// the job can be skipped, that a pull request reaches the workflow, and that
// the job gives the check what it needs to run (a database, an AUTH_SECRET,
// the Playwright Chromium, a production build, a running server, and a
// `--base` URL on the port that server listens on). This file pins it
// against the workflow as it was (red) and as it is (green).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNED_WORKFLOW, auditCspGate } from "./check-csp-gate.mjs";

const WORKFLOW_FILE = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const workflowSource = () => readFileSync(WORKFLOW_FILE, "utf8");

/** The rules a workflow trips. */
const rulesOf = (source, file = "workflow.yml") =>
  auditCspGate(source, { file }).map((violation) => violation.rule);

/**
 * The CI workflow as it was before the fix: the `check` job, and no job that
 * runs the CSP check.
 */
const PRE_FIX_WORKFLOW = `name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    name: check:fast + static gates
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: Secret gate
        run: node scripts/check-secrets.mjs
`;

/**
 * The CSP job as it has to be: a database, a secret, the bundled Chromium, a
 * production build, a server on a known port, and a check that names that
 * port and that browser.
 */
const COMPLETE_WORKFLOW = `name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  csp:
    name: CSP gate
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine3.24
        env:
          POSTGRES_USER: noema
          POSTGRES_PASSWORD: noema
          POSTGRES_DB: noema
        ports: ["5432:5432"]
    env:
      DATABASE_URL: postgresql://noema:noema@127.0.0.1:5432/noema?schema=public
      AUTH_SECRET: ci-only-secret-not-used-in-production-000000
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx prisma db push --skip-generate
      - run: npm run db:seed
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      - name: Start the production server
        run: |
          nohup npm run start -- --port 3210 > /tmp/noema-csp-server.log 2>&1 &
      - name: CSP check
        run: npm run check:csp -- --base http://127.0.0.1:3210 --browser chromium
`;

describe("the pre-fix CI workflow", () => {
  const rules = rulesOf(PRE_FIX_WORKFLOW);

  it("is flagged: no job runs the CSP check", () => {
    expect(rules).toContain("csp-check-missing");
  });

  it("reports the missing check and nothing else", () => {
    // The workflow is reached by a pull request and skips nothing — the only
    // hole is the check that is not there.
    expect(rules).toEqual(["csp-check-missing"]);
  });
});

describe("the CI workflow", () => {
  it("has no hole", () => {
    expect(auditCspGate(workflowSource(), { file: OWNED_WORKFLOW })).toEqual([]);
  });

  it("runs the CSP check in a job of its own", () => {
    const source = workflowSource();
    expect(source).toContain("scripts/check-csp.mjs");
    expect(source).toContain("scripts/check-csp-gate.mjs");
    // The job that runs the check is a job of its own — the fast `check` job
    // stays free of the build and the browser.
    expect(source).toContain("npm run check:csp -- --base");
  });

  it("names the port the server listens on", () => {
    const source = workflowSource();
    expect(source).toContain("--port 3210");
    expect(source).toContain("--base http://127.0.0.1:3210");
  });

  it("asks for the bundled Chromium, not Edge", () => {
    expect(workflowSource()).toContain("--browser chromium");
  });
});

describe("the scanner", () => {
  it("flags a workflow that does not run the check", () => {
    expect(rulesOf(PRE_FIX_WORKFLOW)).toContain("csp-check-missing");
  });

  it("flags a step that swallows its failure", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "run: npm run check:csp -- --base http://127.0.0.1:3210 --browser chromium",
        "run: npm run check:csp -- --base http://127.0.0.1:3210 --browser chromium || true",
      ),
    );
    expect(rules).toContain("csp-step-swallowed");
  });

  it("flags a step marked continue-on-error", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "      - name: CSP check\n",
        "      - name: CSP check\n        continue-on-error: true\n",
      ),
    );
    expect(rules).toContain("csp-step-swallowed");
  });

  it("flags a step that carries a condition", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "      - name: CSP check\n",
        "      - name: CSP check\n        if: github.event_name == 'push'\n",
      ),
    );
    expect(rules).toContain("csp-step-conditional");
  });

  it("flags a job that carries a condition", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "  csp:\n    name: CSP gate\n",
        "  csp:\n    name: CSP gate\n    if: github.event_name != 'pull_request'\n",
      ),
    );
    expect(rules).toContain("csp-job-conditional");
  });

  it("flags a job marked continue-on-error", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "  csp:\n    name: CSP gate\n",
        "  csp:\n    name: CSP gate\n    continue-on-error: true\n",
      ),
    );
    expect(rules).toContain("csp-job-allow-failure");
  });

  it("flags a workflow no pull request reaches", () => {
    const rules = rulesOf(COMPLETE_WORKFLOW.replace("  pull_request:\n", ""));
    expect(rules).toContain("csp-no-pull-request");
  });

  it("flags a job without a database", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        `    services:
      postgres:
        image: postgres:16-alpine3.24
        env:
          POSTGRES_USER: noema
          POSTGRES_PASSWORD: noema
          POSTGRES_DB: noema
        ports: ["5432:5432"]
`,
        "",
      ),
    );
    expect(rules).toContain("csp-missing-database");
  });

  it("flags a job without an AUTH_SECRET", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "      AUTH_SECRET: ci-only-secret-not-used-in-production-000000\n",
        "",
      ),
    );
    expect(rules).toContain("csp-missing-auth-secret");
  });

  it("flags a job without the Playwright Chromium", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace("      - run: npx playwright install --with-deps chromium\n", ""),
    );
    expect(rules).toContain("csp-missing-browser");
  });

  it("flags a job that builds nothing", () => {
    const rules = rulesOf(COMPLETE_WORKFLOW.replace("      - run: npm run build\n", ""));
    expect(rules).toContain("csp-missing-build");
  });

  it("flags a job that starts no server", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        `      - name: Start the production server
        run: |
          nohup npm run start -- --port 3210 > /tmp/noema-csp-server.log 2>&1 &
`,
        "",
      ),
    );
    expect(rules).toContain("csp-missing-server");
  });

  it("flags a check that names no URL", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "run: npm run check:csp -- --base http://127.0.0.1:3210 --browser chromium",
        "run: npm run check:csp -- --browser chromium",
      ),
    );
    expect(rules).toContain("csp-missing-base-url");
  });

  it("flags a check that probes another port than the server listens on", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace("--base http://127.0.0.1:3210", "--base http://127.0.0.1:3000"),
    );
    expect(rules).toContain("csp-port-mismatch");
  });

  it("flags a check that asks for Edge", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace("--browser chromium", "--browser msedge"),
    );
    expect(rules).toContain("csp-edge-browser");
  });

  it("accepts the complete workflow", () => {
    expect(rulesOf(COMPLETE_WORKFLOW)).toEqual([]);
  });

  it("accepts a check that runs the script directly", () => {
    const rules = rulesOf(
      COMPLETE_WORKFLOW.replace(
        "run: npm run check:csp -- --base http://127.0.0.1:3210 --browser chromium",
        "run: node scripts/check-csp.mjs --base http://127.0.0.1:3210 --browser chromium",
      ),
    );
    expect(rules).toEqual([]);
  });
});
