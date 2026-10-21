// Regression test for the compose smoke gate: the compose smoke test in
// `.github/workflows/site.yml` must describe the stack it actually starts.
//
// The fixture below is the `compose-smoke` job of `.github/workflows/site.yml`
// as it was before the fix — the vulnerable job, verbatim (`git show
// 4531254:.github/workflows/site.yml`). It could not succeed: the stack was
// started without the `app` profile, so the app service never started, and the
// probe asked for port 3200 while the compose file publishes 3202. The gate
// must still recognise that shape, so it cannot come back unnoticed; and the
// workflow in the tree today must pass it.
//
// The other cases cover the shapes a one-line edit slips through: a job that
// starts the stack without the profile, a probe on the wrong port, an image
// that boots without the boot wrapper (and therefore without the migration),
// a compose service that overrides the image's command, and a stack that
// would run the published image instead of the code under review.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeComposeSmoke, analyzeRepository } from "./check-compose-smoke.mjs";

const PRE_FIX_COMPOSE_SMOKE_JOB = `  compose-smoke:
    name: docker compose smoke
    needs: build
    runs-on: ubuntu-22.04
    if: github.event_name != 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - name: Start the stack
        run: |
          cp .env.example .env 2>/dev/null || true
          docker compose up -d --build
      - name: Wait for readiness
        run: |
          for i in $(seq 1 60); do
            if curl -fsS http://127.0.0.1:3200/api/health >/dev/null 2>&1; then
              echo "ready after \${i}s"; exit 0
            fi
            sleep 1
          done
          echo "::error::the site never became ready"; docker compose logs --tail=80; exit 1
      - name: Tear down
        if: always()
        run: docker compose down -v
`;

/** The pre-fix job inside a minimal workflow, so only the job differs. */
const PRE_FIX_WORKFLOW = `name: site

on:
  push:
  pull_request:

jobs:
${PRE_FIX_COMPOSE_SMOKE_JOB}`;

const CURRENT_WORKFLOW = readFileSync(
  new URL("../.github/workflows/site.yml", import.meta.url),
  "utf8",
);
const CURRENT_COMPOSE = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const CURRENT_DOCKERFILE = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const CURRENT_BOOT_WRAPPER = readFileSync(
  new URL("../scripts/desktop/boot-wrapper.cjs", import.meta.url),
  "utf8",
);
const CURRENT_CI_WORKFLOW = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

/** The files of the repository, with the parts a case changes replaced. */
const files = (overrides = {}) => ({
  workflow: CURRENT_WORKFLOW,
  compose: CURRENT_COMPOSE,
  dockerfile: CURRENT_DOCKERFILE,
  bootWrapper: CURRENT_BOOT_WRAPPER,
  ...overrides,
});

/** The rules a set of findings breaks, without the message noise. */
const rules = (findings) => findings.map((finding) => finding.rule);

/** The messages of the findings of one rule. */
const messages = (findings, rule) =>
  findings.filter((finding) => finding.rule === rule).map((finding) => finding.message);

describe("analyzeComposeSmoke", () => {
  it("keeps the pre-fix job as the vulnerable fixture", () => {
    // The fixture must stay the *old* job. If it is ever "fixed" in place,
    // the test below would pass for the wrong reason.
    expect(PRE_FIX_COMPOSE_SMOKE_JOB).toContain("docker compose up -d --build");
    expect(PRE_FIX_COMPOSE_SMOKE_JOB).not.toContain("--profile");
    expect(PRE_FIX_COMPOSE_SMOKE_JOB).toContain("http://127.0.0.1:3200/api/health");
  });

  it("flags the pre-fix job", () => {
    const findings = analyzeComposeSmoke(files({ workflow: PRE_FIX_WORKFLOW }));

    // The app service sits behind the `app` profile: without it the app is
    // never started.
    expect(rules(findings)).toContain("profile-not-activated");
    // The compose file publishes 3202, the probe asked for 3200.
    expect(rules(findings)).toContain("probe-port-mismatch");
  });

  it("names the profile and the port it found", () => {
    const findings = analyzeComposeSmoke(files({ workflow: PRE_FIX_WORKFLOW }));

    expect(messages(findings, "profile-not-activated")[0]).toContain("--profile app");
    expect(messages(findings, "probe-port-mismatch")[0]).toContain("port 3200");
    expect(messages(findings, "probe-port-mismatch")[0]).toContain("3202");
  });

  it("flags a stack that is started without the profile", () => {
    const workflow = CURRENT_WORKFLOW.replace(
      "docker compose --profile app up -d --build",
      "docker compose up -d --build",
    );
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).toContain("profile-not-activated");
    expect(rules(findings)).not.toContain("probe-port-mismatch");
  });

  it("flags a probe on a port the compose file does not publish", () => {
    const workflow = CURRENT_WORKFLOW.replace(
      "http://127.0.0.1:3202/api/health",
      "http://127.0.0.1:3200/api/health",
    );
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).toContain("probe-port-mismatch");
    expect(messages(findings, "probe-port-mismatch")[0]).toContain("port 3200");
  });

  it("flags an image that boots without the boot wrapper", () => {
    // `next start` serves the app but never applies the migrations: the
    // database stays empty.
    const dockerfile = CURRENT_DOCKERFILE.replace(
      'CMD ["node", "start.cjs"]',
      'CMD ["node_modules/.bin/next", "start"]',
    );
    const findings = analyzeComposeSmoke(files({ dockerfile }));

    expect(rules(findings)).toContain("migration-not-applied");
    expect(messages(findings, "migration-not-applied")[0]).toContain("prisma migrate deploy");
  });

  it("flags a boot wrapper that serves before it migrates", () => {
    const bootWrapper = CURRENT_BOOT_WRAPPER.replace(
      /await migrate\(\);\r?\n      startServer\(\);/,
      "startServer();\n      await migrate();",
    );
    const findings = analyzeComposeSmoke(files({ bootWrapper }));

    expect(rules(findings)).toContain("migration-not-applied");
  });

  it("accepts a job that applies the migrations itself", () => {
    // The migration may live in the job instead of in the image — the
    // database is then migrated before the probe either way.
    const workflow = CURRENT_WORKFLOW.replace(
      "      - name: Wait for readiness",
      [
        "      - name: Migrate",
        "        run: docker compose --profile app exec app node node_modules/prisma/build/index.js migrate deploy",
        "",
        "      - name: Wait for readiness",
      ].join("\n"),
    );
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).not.toContain("migration-not-applied");
  });

  it("flags a compose service that overrides the image's command", () => {
    const compose = CURRENT_COMPOSE.replace(
      '    container_name: noema-app',
      '    container_name: noema-app\n    command: ["node_modules/.bin/next", "start"]',
    );
    const findings = analyzeComposeSmoke(files({ compose }));

    expect(rules(findings)).toContain("migration-not-applied");
  });

  it("flags a stack that would run the published image", () => {
    const compose = CURRENT_COMPOSE.replace(
      "    build:\n      context: .\n      target: runner",
      "    # no build section: the published image would be tested",
    );
    const findings = analyzeComposeSmoke(files({ compose }));

    expect(rules(findings)).toContain("image-not-built-from-repository");
  });

  it("flags a workflow without a compose smoke job", () => {
    const workflow = CURRENT_WORKFLOW.replace(/  compose-smoke:\n[\s\S]*$/, "");
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).toContain("compose-smoke-job-missing");
  });

  it("flags a job that never probes the health endpoint", () => {
    const workflow = CURRENT_WORKFLOW.replace(
      "http://127.0.0.1:3202/api/health",
      "http://127.0.0.1:3202/",
    );
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).toContain("no-health-probe");
  });

  it("flags a job that never talks to the app at all", () => {
    const workflow = CURRENT_WORKFLOW.replace(
      "http://127.0.0.1:3202/api/health",
      "http://noema.invalid/api/health",
    );
    const findings = analyzeComposeSmoke(files({ workflow }));

    expect(rules(findings)).toContain("no-health-probe");
  });

  it("accepts the files in the tree", () => {
    // Red-first: this test fails when the pre-fix job is restored.
    expect(analyzeRepository()).toEqual([]);
  });
});

describe("the gate in CI", () => {
  it("runs in the CI workflow", () => {
    // The compose job itself only runs on a push to `main`, so the gate is
    // what keeps a pull request from breaking the container path unseen. If
    // the step is removed from the workflow, this test fails.
    expect(CURRENT_CI_WORKFLOW).toMatch(/run:.*(check-compose-smoke|check:compose-smoke)/);
  });

  it("runs in the site workflow", () => {
    // The workflow that owns the compose smoke job checks itself.
    expect(CURRENT_WORKFLOW).toMatch(/run:.*(check-compose-smoke|check:compose-smoke)/);
  });
});
