// Regression test for the CI permission hole: the site workflow built the
// pull request's own `Dockerfile` inside a job whose token could publish the
// result to GHCR and sign it.
//
// `PRE_FIX_SITE_WORKFLOW` below is `.github/workflows/site.yml` as it was
// before the fix — the vulnerable file, verbatim (`git show
// 051dcd6:.github/workflows/site.yml`). The gate must still recognise that
// shape, so it cannot come back unnoticed; and the workflow in the tree today
// must pass it.
//
// The other cases cover the shapes a one-token edit used to slip through: a
// gate that only *mentions* a non-pull-request event, a workflow without a
// `permissions:` block at all, and the `pull_request_target` trigger — the
// event that `github.event_name != 'pull_request'` does not rule out.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeWorkflow, analyzeWorkflowDirectory } from "./check-workflow-permissions.mjs";

const PRE_FIX_SITE_WORKFLOW = `# Site version: the hosted web app. Tests, a multi-arch container image, a
# vulnerability gate, keyless signing, and a real container smoke test.
#
# The image is a *standalone* Next.js build, staged by the project's own
# desktop packager (scripts/desktop/prepare.mjs) — see the Dockerfile for why.
# \`next start\` is deliberately not used: Next does not serve a standalone
# build that way.
#
# Publishing:
#   - pull requests  -> build linux/amd64, load it, scan it, smoke it. No push.
#   - main           -> push edge + latest + sha tags to GHCR.
#   - tags v*        -> push semver (+ latest) tags to GHCR.
# The image is signed with cosign keyless (GitHub OIDC) and carries SBOM and
# provenance attestations (docker/build-push-action).
name: site

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    paths:
      - "src/**"
      - "app/**"
      - "prisma/**"
      - "public/**"
      - "scripts/desktop/**"
      - "Dockerfile"
      - ".dockerignore"
      - "docker-compose.yml"
      - ".github/workflows/site.yml"
  workflow_dispatch:

concurrency:
  group: site-\${{ github.ref }}
  cancel-in-progress: true

# Least privilege by default; the image job requests the two extra scopes it
# needs (packages: write to push, id-token: write for cosign keyless signing).
permissions:
  contents: read

env:
  NEXT_TELEMETRY_DISABLED: "1"

jobs:
  build:
    name: build + test
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:16-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
        env:
          POSTGRES_USER: noema
          POSTGRES_PASSWORD: noema
          POSTGRES_DB: noema
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U noema" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://noema:noema@127.0.0.1:5432/noema?schema=public
      AUTH_SECRET: ci-only-secret-not-used-in-production-000000
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx prisma db push --skip-generate
      - run: npm run typecheck
      - run: npx eslint --quiet .
      - run: npx vitest run --maxWorkers=2
      - run: npm run check:coherence
      - run: npm run check:use-server
      # Client-bundle guard: a client component that reaches a \`node:\` built-in
      # passes tsc, passes tests, and works in \`next dev\` — and then fails
      # \`next build\` with UnhandledSchemeError. That happened once; never again.
      - run: npm run check:client
      # Every t(locale, "key") must exist in the catalogue. During a parallel
      # refactor this failed as 29 cryptic \`tsc\` "not assignable" errors; the
      # gate names the missing keys and the files that reference them.
      - run: npm run check:i18n
      # The migrations must describe the schema. A database built by \`migrate deploy\`
      # (which is what the desktop app runs) once had 17 of 45 tables and four
      # features silently broken.
      - run: npm run check:schema
      # Design-system + motion ratchets. Both are pure file scans (no DB, no
      # browser) and their baselines are 0, so any new raw hex, magic z-index,
      # ad-hoc duration, legacy palette class or literal easing fails the build.
      - run: npm run check:design
      - run: npm run check:motion
      # No credential shapes in the tree. It is value-shaped, not entropy-shaped:
      # it knows what a leaked key looks like (\`sk-…\`, an AWS id, a private-key
      # header, a connection string with a password) rather than guessing from
      # randomness, so it does not drown in false positives. A real key did once
      # reach \`.env\`; this is what stops the next one.
      - run: npm run check:secrets
      - name: Design report (informative)
        if: always()
        run: npm run design:report
      - run: npm run site:build
      - run: npm run setup:search || true

  image:
    name: container image
    needs: build
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    permissions:
      contents: read
      packages: write
      id-token: write
    services:
      postgres:
        image: postgres:16-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
        env:
          POSTGRES_USER: noema
          POSTGRES_PASSWORD: noema
          POSTGRES_DB: noema
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U noema" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      IMAGE_NAME: ghcr.io/\${{ github.repository }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Build metadata
        run: echo "BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "$GITHUB_ENV"

      - uses: docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
        with:
          images: \${{ env.IMAGE_NAME }}
          # latest=auto keeps \`latest\` on semver tags; the raw rule below adds
          # it on the default branch, where \`edge\` also points.
          flavor: |
            latest=auto
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha,format=short
            type=raw,value=edge,enable={{is_default_branch}}
            type=raw,value=latest,enable={{is_default_branch}}

      # PRs build amd64 and load it so the scan and smoke test run against the
      # exact bytes under review. Pushes build both architectures.
      - id: build
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          target: runner
          platforms: \${{ github.event_name == 'pull_request' && 'linux/amd64' || 'linux/amd64,linux/arm64' }}
          push: \${{ github.event_name != 'pull_request' }}
          load: \${{ github.event_name == 'pull_request' }}
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          build-args: |
            VERSION=\${{ steps.meta.outputs.version }}
            REVISION=\${{ github.sha }}
            BUILD_DATE=\${{ env.BUILD_DATE }}
          cache-from: type=gha,scope=noema
          cache-to: type=gha,mode=max,scope=noema
          provenance: \${{ github.event_name != 'pull_request' && 'mode=max' || 'false' }}
          sbom: \${{ github.event_name != 'pull_request' }}

      - name: Resolve image reference
        id: image
        run: |
          if [ "\${{ github.event_name }}" = "pull_request" ]; then
            echo "ref=\${IMAGE_NAME,,}:pr-\${{ github.event.number }}" >> "$GITHUB_OUTPUT"
          else
            echo "ref=\${IMAGE_NAME,,}@\${{ steps.build.outputs.digest }}" >> "$GITHUB_OUTPUT"
          fi

      # Fails the pipeline on fixable HIGH/CRITICAL findings. ignore-unfixed
      # keeps upstream base-image noise from blocking a release.
      - name: Scan image for vulnerabilities
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: \${{ steps.image.outputs.ref }}
          format: table
          exit-code: "1"
          ignore-unfixed: true
          vuln-type: os,library
          severity: CRITICAL,HIGH

      - name: Install cosign
        if: github.event_name != 'pull_request'
        uses: sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2

      # Keyless: the signature is bound to this workflow's identity through
      # GitHub OIDC, so there is no long-lived signing key to store.
      - name: Sign image (keyless)
        if: github.event_name != 'pull_request'
        run: cosign sign --yes "\${IMAGE_NAME,,}@\${{ steps.build.outputs.digest }}"

      - name: Start the image
        run: |
          docker run --detach --name noema-smoke \\
            --add-host=host.docker.internal:host-gateway \\
            --publish 3000:3000 \\
            --read-only \\
            --tmpfs /tmp \\
            --tmpfs /app/.next/cache \\
            --volume noema-smoke-data:/data \\
            --env DATABASE_URL='postgresql://noema:noema@host.docker.internal:5432/noema?schema=public' \\
            --env AUTH_SECRET='ci-only-secret-not-used-in-production-000000' \\
            --env APP_ORIGINS='http://localhost:3000' \\
            "\${{ steps.image.outputs.ref }}"

      - name: Wait for readiness
        run: |
          for attempt in $(seq 1 90); do
            code=$(curl -sS -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
            if [ "$code" = "200" ]; then
              echo "healthy after \${attempt} attempt(s)"
              cat /tmp/health.json
              exit 0
            fi
            sleep 2
          done
          echo "::error::/api/health did not return 200 (last: \${code:-no response})"
          docker logs --tail=200 noema-smoke
          exit 1

      - name: Smoke pages
        run: |
          curl -fsS http://127.0.0.1:3000/ > /dev/null
          curl -fsS http://127.0.0.1:3000/login > /dev/null

      - name: Container logs
        if: always()
        run: docker logs --tail=200 noema-smoke || true

      - name: Stop the container
        if: always()
        run: |
          docker rm --force noema-smoke || true
          docker volume rm noema-smoke-data || true

  compose-smoke:
    name: docker compose smoke
    needs: build
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    if: github.event_name != 'pull_request'
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Prepare environment
        run: cp .env.example .env

      - name: Start the stack
        run: docker compose --profile app up -d --build

      - name: Wait for readiness
        run: |
          for i in $(seq 1 90); do
            if curl -fsS http://127.0.0.1:3202/api/health >/dev/null 2>&1; then
              echo "ready after \${i} attempt(s)"
              exit 0
            fi
            sleep 2
          done
          echo "::error::the app never became ready"
          docker compose --profile app logs --tail=120
          exit 1

      - name: Tear down
        if: always()
        run: docker compose --profile app down -v
`;

const CURRENT_SITE_WORKFLOW = readFileSync(
  new URL("../.github/workflows/site.yml", import.meta.url),
  "utf8",
);

/** The rules a file breaks, without the message noise. */
const rules = (findings) => findings.map((finding) => finding.rule);

/** The messages of the findings of one rule, without the file and the line. */
const messages = (findings, rule) =>
  findings.filter((finding) => finding.rule === rule).map((finding) => finding.message);

describe("analyzeWorkflow", () => {
  it("keeps the pre-fix workflow as the vulnerable fixture", () => {
    // The fixture must stay the *old* file. If it is ever "fixed" in place,
    // the test below would pass for the wrong reason.
    expect(PRE_FIX_SITE_WORKFLOW).toContain("packages: write");
    expect(PRE_FIX_SITE_WORKFLOW).toContain("id-token: write");
    expect(PRE_FIX_SITE_WORKFLOW).not.toContain("persist-credentials: false");
  });

  it("flags the publishing scope of the pre-fix site workflow", () => {
    const findings = analyzeWorkflow(PRE_FIX_SITE_WORKFLOW, "site.yml");

    // The `image` job built the pull request's own Dockerfile with a token
    // that could push to GHCR (`packages: write`) and sign it
    // (`id-token: write`) — and no gate kept a pull request out of it.
    expect(rules(findings)).toContain("publishing-scope-in-pull-request-job");
    expect(messages(findings, "publishing-scope-in-pull-request-job")[0]).toContain(
      "`image`",
    );
  });

  it("flags the checkouts that leave the token in .git/config", () => {
    const findings = analyzeWorkflow(PRE_FIX_SITE_WORKFLOW, "site.yml").filter(
      (finding) => finding.rule === "persisted-credentials",
    );

    // The build job runs the pull request's code, and the image job publishes
    // what that code built.
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`build`"),
      expect.stringContaining("`image`"),
      expect.stringContaining("`compose-smoke`"),
    ]);
  });

  it("flags a workflow that hands out every scope at once", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "permissions: write-all",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "workflow-level-publishing-scope",
    );
  });

  it("flags a flow mapping with a quoted value", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "permissions: { packages: 'write' }",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "workflow-level-publishing-scope",
    );
  });

  it("flags a publishing scope in a job a pull request can reach", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  image:",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "publishing-scope-in-pull-request-job",
    );
  });

  it("flags `id-token: write` in a job a pull request can reach", () => {
    // The OIDC scope is a publishing scope too: it mints the token cosign
    // signs the image with.
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "publishing-scope-in-pull-request-job",
    );
  });

  it("accepts a publishing scope behind a gate that rules pull requests out", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  publish:",
      "    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
      "    permissions:",
      "      contents: read",
      "      packages: write",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          persist-credentials: false",
      "",
    ].join("\n");

    expect(analyzeWorkflow(workflow, "site.yml")).toEqual([]);
  });

  it("accepts a tag gate that also rules pull requests out", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  image:",
      "    if: startsWith(github.ref, 'refs/tags/') && github.event_name != 'pull_request'",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(analyzeWorkflow(workflow, "site.yml")).toEqual([]);
  });

  it("accepts a tag gate written as a block scalar", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  image:",
      "    if: |",
      "      startsWith(github.ref, 'refs/tags/')",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(analyzeWorkflow(workflow, "site.yml")).toEqual([]);
  });

  it("flags `github.event_name != 'pull_request'` as a publishing gate", () => {
    // The gate is evaluated, not matched: a `pull_request_target` event
    // satisfies this expression, and that trigger runs with the base
    // branch's code and this repository's write token. So the job is still
    // reachable for a pull request.
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  publish:",
      "    if: github.event_name != 'pull_request'",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "publishing-scope-in-pull-request-job",
    );
  });

  it("flags a gate that only mentions a tag", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  publish:",
      "    if: startsWith(github.ref, 'refs/tags/') || github.event_name == 'pull_request'",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "publishing-scope-in-pull-request-job",
    );
  });

  it("flags a negated tag gate", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  publish:",
      "    if: !startsWith(github.ref, 'refs/tags/')",
      "    permissions:",
      "      packages: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "publishing-scope-in-pull-request-job",
    );
  });

  it("flags a job that runs with the repository default token", () => {
    // No `permissions:` block anywhere: the job inherits the repository
    // default, whose scopes the gate cannot see — so it is examined as if it
    // could publish.
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    const found = rules(analyzeWorkflow(workflow, "site.yml"));

    expect(found).toContain("missing-permissions");
    expect(found).toContain("persisted-credentials");
  });

  it("treats `pull_request_target` as a pull-request trigger", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "  packages: write",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    const found = rules(analyzeWorkflow(workflow, "site.yml"));

    expect(found).toContain("workflow-level-publishing-scope");
    expect(found).toContain("persisted-credentials");
  });

  it("reports a `permissions:` block it cannot resolve", () => {
    const workflow = [
      "name: site",
      "on:",
      "  pull_request:",
      "x-perms: &perms",
      "  packages: write",
      "jobs:",
      "  image:",
      "    permissions: *perms",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n");

    expect(rules(analyzeWorkflow(workflow, "site.yml"))).toContain(
      "unsupported-permissions-alias",
    );
  });

  it("accepts the site workflow in the tree", () => {
    // Red-first: this test fails when the pre-fix workflow is restored.
    expect(analyzeWorkflow(CURRENT_SITE_WORKFLOW, ".github/workflows/site.yml")).toEqual([]);
  });
});

describe("the workflows in the repository", () => {
  it("satisfy the gate", () => {
    expect(analyzeWorkflowDirectory()).toEqual([]);
  });
});
