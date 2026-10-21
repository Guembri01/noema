// Regression test for the hook gate (B80).
//
// The hole: `.githooks/pre-commit` is off in a fresh clone — `core.hooksPath`
// is a setting of the clone, and a repository cannot version it — and
// `git commit --no-verify` skips it. The hook was never the check, but the
// documentation called it a "gate" and left the activation step out of
// CONTRIBUTING.md, so a contributor had no way to tell an opt-in from a
// boundary.
//
// The gate: `scripts/check-hook-gate.mjs`. It asserts that CI enforces the
// two checks the hook runs, that the hook stays an opt-in convenience that
// fails the commit when a check fails, and that CONTRIBUTING.md carries the
// activation command and names the workflow that enforces the check. This
// file pins the scanner against the workflow and the hook as they are (green)
// and against the shapes that would make the documentation a lie (red).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENABLE_COMMAND,
  GATE_SCRIPTS,
  HOOK_PATH,
  OWNED_WORKFLOW,
  auditDocs,
  auditHook,
  auditWorkflow,
} from "./check-hook-gate.mjs";

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

/** A workflow that enforces both checks, cut to the parts the rules read. */
const WORKING = `name: CI

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
      - name: Secret gate
        run: node scripts/check-secrets.mjs
      - name: Authoring windows
        run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-commit-dates.mjs
`;

/** The hook as it is in the repository, cut to the parts the rules read. */
const HOOK = `#!/bin/sh
# Noema pre-commit hook — an opt-in convenience, NOT the check.
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-commit-dates.mjs --pending || exit 1
node scripts/check-secrets.mjs || exit 1
`;

/** The documentation as it has to be. */
const DOCS = `Enable it once per clone:

\`\`\`bash
${ENABLE_COMMAND}
\`\`\`

The \`check\` job in [${OWNED_WORKFLOW}](./${OWNED_WORKFLOW}) runs the same checks.
`;

describe("the CI workflow enforces the checks the hook runs", () => {
  it("passes on the workflow in the repository", () => {
    expect(auditWorkflow(read(OWNED_WORKFLOW), { file: OWNED_WORKFLOW })).toEqual([]);
  });

  it("passes on a workflow that runs both checks", () => {
    expect(auditWorkflow(WORKING)).toEqual([]);
  });

  it("fails when the secret gate is not run at all", () => {
    const withoutSecretGate = WORKING.replace("      - name: Secret gate\n        run: node scripts/check-secrets.mjs\n", "");
    const problems = auditWorkflow(withoutSecretGate);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("never runs scripts/check-secrets.mjs");
  });

  it("fails when the authoring-window gate is not run at all", () => {
    const withoutWindows = WORKING.replace(
      "      - name: Authoring windows\n        run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-commit-dates.mjs\n",
      "",
    );
    const problems = auditWorkflow(withoutWindows);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("never runs scripts/check-commit-dates.mjs");
  });

  it("fails when the step is allowed to fail", () => {
    const continueOnError = WORKING.replace(
      "      - name: Secret gate\n        run:",
      "      - name: Secret gate\n        continue-on-error: true\n        run:",
    );
    const problems = auditWorkflow(continueOnError);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("continue-on-error: true");
  });

  it("fails when the exit code is swallowed", () => {
    const swallowed = WORKING.replace("run: node scripts/check-secrets.mjs", "run: node scripts/check-secrets.mjs || true");
    const problems = auditWorkflow(swallowed);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("swallows the exit code");
  });

  it("fails when the step is conditional", () => {
    const conditional = WORKING.replace(
      "      - name: Secret gate\n        run:",
      "      - name: Secret gate\n        if: github.event_name == 'push'\n        run:",
    );
    const problems = auditWorkflow(conditional);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("under an if: condition");
  });

  it("fails when the job is conditional", () => {
    const conditional = WORKING.replace(
      "  check:\n    name:",
      "  check:\n    if: github.event_name == 'push'\n    name:",
    );
    const problems = auditWorkflow(conditional);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("job with an if: condition");
  });

  it("fails when the workflow does not run on a pull request", () => {
    const pushOnly = WORKING.replace("  pull_request:\n", "");
    const problems = auditWorkflow(pushOnly);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("no pull_request trigger");
  });
});

describe("the hook stays an opt-in convenience that fails the commit", () => {
  it("passes on the hook in the repository", () => {
    expect(auditHook(read(HOOK_PATH))).toEqual([]);
  });

  it("passes on a hook that runs both checks", () => {
    expect(auditHook(HOOK)).toEqual([]);
  });

  it("fails when a check is missing", () => {
    const problems = auditHook(HOOK.replace("node scripts/check-secrets.mjs || exit 1\n", ""));
    expect(problems).toEqual(["does not run scripts/check-secrets.mjs"]);
  });

  it("fails when the hook does not fail the commit", () => {
    const problems = auditHook(HOOK.replace("node scripts/check-secrets.mjs || exit 1", "node scripts/check-secrets.mjs"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not fail the commit");
  });
});

describe("the activation is documented where a contributor looks", () => {
  it("passes on the documentation in the repository", () => {
    expect(auditDocs(read("CONTRIBUTING.md"))).toEqual([]);
  });

  it("passes on a documentation that carries the command and the workflow", () => {
    expect(auditDocs(DOCS)).toEqual([]);
  });

  it("fails when the command is missing", () => {
    const problems = auditDocs(DOCS.replace(ENABLE_COMMAND, "enable the hook"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not carry the activation command");
  });

  it("fails when the document names a different hooks path", () => {
    const problems = auditDocs(DOCS.replace(ENABLE_COMMAND, "git config core.hooksPath .githooks-disabled"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not carry the activation command");
  });

  it("fails when the workflow that enforces the check is missing", () => {
    const problems = auditDocs(DOCS.replaceAll(OWNED_WORKFLOW, "the CI workflow"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not name .github/workflows/ci.yml");
  });
});

describe("the gate names the artefacts it protects", () => {
  it("covers exactly the two checks the hook runs", () => {
    expect(GATE_SCRIPTS).toEqual(["scripts/check-secrets.mjs", "scripts/check-commit-dates.mjs"]);
  });
});
