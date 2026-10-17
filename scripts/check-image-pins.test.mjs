// B65 — the image-pin gate (scripts/check-image-pins.mjs).
//
// The finding: the container base images were pulled by tag. `FROM
// node:${NODE_VERSION}-alpine` and `image: postgres:16-alpine` name a tag, not
// a version — the registry decides which bits the build gets, so the same
// commit can produce an image nobody reviewed.
//
// The gate is a safety net over that: it fails when an image is not pinned by
// digest. A safety net is only as good as the holes it is pinned against, so
// the shapes below live here as fixtures — the pre-fix files verbatim, the
// shapes a one-token edit slips through, and the clean cases that have to stay
// green, because a gate that fails everything is no gate.
//
// The gate runs over a throwaway tree, so the test needs no registry, no
// network and no build. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node scripts/check-image-pins.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeDockerfile,
  analyzeServiceImages,
  collectFroms,
  collectServiceImages,
  resolveReference,
} from "./check-image-pins.mjs";

const GATE = fileURLToPath(new URL("./check-image-pins.mjs", import.meta.url));

/** The repository the gate reads. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The digest of `postgres:16-alpine` — the one the compose file uses. */
const POSTGRES_DIGEST =
  "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";

/**
 * The `Dockerfile` as it was before the fix — the vulnerable file, verbatim
 * (`git show 4531254:Dockerfile`). The gate has to recognise that shape, so
 * it cannot come back unnoticed.
 */
const PRE_FIX_DOCKERFILE = `# syntax=docker/dockerfile:1
# =============================================================================
# B62 — Noema app image (spec R28.22): deps -> builder -> minimal runner.
# =============================================================================
ARG NODE_VERSION=24

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:\${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN export DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \\
      AUTH_SECRET="b74-build-time-dummy-secret-not-a-real-key" \\
  && npx prisma generate \\
  && npm run build \\
  && rm -rf .next/cache

# --- Stage 2: builder -------------------------------------------------------
FROM node:\${NODE_VERSION}-alpine AS builder
WORKDIR /app

# --- Stage 3: runner --------------------------------------------------------
FROM node:\${NODE_VERSION}-alpine AS runner
WORKDIR /app
`;

/**
 * The compose file as it was before the fix — verbatim
 * (`git show 4531254:docker-compose.yml`).
 */
const PRE_FIX_COMPOSE = `services:
  db:
    image: postgres:16-alpine
    container_name: noema-db
    environment:
      POSTGRES_USER: noema
      POSTGRES_PASSWORD: noema
      POSTGRES_DB: noema
    ports:
      - "5433:5432"

  app:
    image: noema-app:local
    build:
      context: .
`;

/** A `FROM` that is pinned by digest. */
const PINNED_FROM = "FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base";

/* ------------------------------------------------------------------ *
 * The fixtures
 * ------------------------------------------------------------------ */

/**
 * The shapes that have to be reported, and the message the gate has to print
 * for them.
 */
const REPORTED = [
  {
    name: "the pre-fix Dockerfile is reported — every base image by tag",
    kind: "dockerfile",
    source: PRE_FIX_DOCKERFILE,
    expect: "the base image is pulled by tag",
    count: 3,
  },
  {
    name: "a base image without a tag and without a digest is reported",
    kind: "dockerfile",
    source: "FROM alpine AS base\n",
    expect: "the base image is pulled without a tag and without a digest",
    count: 1,
  },
  {
    name: "a base image with a variable tag is reported",
    kind: "dockerfile",
    source: "ARG NODE_VERSION=24\nFROM node:${NODE_VERSION}-alpine AS base\n",
    expect: "the base image is pulled by tag",
    count: 1,
  },
  {
    name: "a truncated digest is reported",
    kind: "dockerfile",
    source: "FROM node:24-alpine@sha256:ebfe2f904627 AS base\n",
    expect: "the digest behind the image is not a sha256 digest",
    count: 1,
  },
  {
    name: "the pre-fix compose file is reported — the database by tag",
    kind: "compose",
    source: PRE_FIX_COMPOSE,
    expect: "the service image is pulled by tag",
    count: 2,
  },
  {
    name: "a service image by tag is reported",
    kind: "compose",
    source: "services:\n  db:\n    image: postgres:16-alpine\n",
    expect: "the service image is pulled by tag",
    count: 1,
  },
  {
    name: "a service image behind a variable without a default is reported",
    kind: "compose",
    source: "services:\n  db:\n    image: ${POSTGRES_IMAGE}\n",
    expect: "the gate cannot see which image it is",
    count: 1,
  },
  {
    name: "a service image with a truncated digest is reported",
    kind: "compose",
    source: `services:\n  db:\n    image: postgres:16-alpine@sha256:721873\n`,
    expect: "the digest behind the image is not a sha256 digest",
    count: 1,
  },
];

/**
 * The shapes that have to stay green — a gate that fails everything is no
 * gate.
 */
const ACCEPTED = [
  {
    name: "a base image pinned by digest passes",
    kind: "dockerfile",
    source: `${PINNED_FROM}\nFROM base AS deps\nFROM base AS runner\n`,
    expect: 0,
  },
  {
    name: "the empty base image passes — it is a constant, not a pull",
    kind: "dockerfile",
    source: "FROM scratch\nCOPY payload /app\n",
    expect: 0,
  },
  {
    name: "a stage of the same Dockerfile is not an image",
    kind: "dockerfile",
    source: `${PINNED_FROM}\nFROM base AS deps\n`,
    expect: 0,
  },
  {
    name: "a service image pinned by digest passes",
    kind: "compose",
    source: `services:\n  db:\n    image: postgres:16-alpine3.24@${POSTGRES_DIGEST}\n`,
    expect: 0,
  },
  {
    name: "the image this repository publishes itself is exempt",
    kind: "compose",
    source: "services:\n  app:\n    image: ${NOEMA_IMAGE:-ghcr.io/guembri01/noema:latest}\n",
    expect: 0,
  },
  {
    name: "a comment that names an image is not an image",
    kind: "compose",
    source: "services:\n  db:\n    # image: postgres:16-alpine\n    image: postgres:16-alpine3.24@" + POSTGRES_DIGEST + "\n",
    expect: 0,
  },
];

/* ------------------------------------------------------------------ *
 * The runners
 * ------------------------------------------------------------------ */

/**
 * Run the gate over a throwaway tree that holds the given files.
 *
 * @param {Record<string, string>} files
 * @returns {{code: number, output: string}}
 */
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "noema-image-pins-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const tree = {
      "Dockerfile": "FROM scratch\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16-alpine3.24@" + POSTGRES_DIGEST + "\n",
      ".github/workflows/ci.yml": "name: CI\non: push\n",
      ...files,
    };
    for (const [name, source] of Object.entries(tree)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source, "utf8");
    }

    try {
      const output = execFileSync("node", [GATE, "--root", dir], {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
      });
      return { code: 0, output };
    } catch (error) {
      return {
        code: error.status ?? 1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The gate has to report the fixture.
 *
 * @param {{name: string, kind: string, source: string, expect: string, count: number}} testCase
 */
function assertReported(testCase) {
  const result = gateOver({ [testCase.kind === "dockerfile" ? "Dockerfile" : "docker-compose.yml"]: testCase.source });
  assert.equal(result.code, 1, `${testCase.name}: the gate must fail\n${result.output}`);
  assert.ok(
    result.output.includes(testCase.expect),
    `${testCase.name}: the gate must say "${testCase.expect}"\n${result.output}`,
  );
  const holes = result.output.split("\n").filter((line) => line.includes("HOLE")).length;
  assert.equal(holes, testCase.count, `${testCase.name}: the gate must report ${testCase.count} hole(s)\n${result.output}`);
}

/**
 * The gate has to accept the fixture.
 *
 * @param {{name: string, kind: string, source: string, expect: number}} testCase
 */
function assertAccepted(testCase) {
  const result = gateOver({ [testCase.kind === "dockerfile" ? "Dockerfile" : "docker-compose.yml"]: testCase.source });
  assert.equal(result.code, 0, `${testCase.name}: the gate must pass\n${result.output}`);
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

/** The files of this repository have to pass the gate. */
function assertRepositoryIsGreen() {
  let output = "";
  let code = 0;
  try {
    output = execFileSync("node", [GATE], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.equal(code, 0, `the repository must pass the gate\n${output}`);
}

/** The readers have to see what they are supposed to see. */
function assertReaders() {
  const froms = collectFroms(PRE_FIX_DOCKERFILE);
  assert.equal(froms.length, 3, "the pre-fix Dockerfile has three stages");
  assert.equal(froms[0].reference, "node:${NODE_VERSION}-alpine");
  assert.equal(froms[0].stage, "deps");

  const images = collectServiceImages(PRE_FIX_COMPOSE);
  assert.equal(images.length, 2, "the pre-fix compose file names two images");
  assert.equal(images[0].value, "postgres:16-alpine");
  assert.equal(images[0].line, 3);

  // A variable with a default resolves to the default; a variable without one
  // does not resolve at all.
  assert.deepEqual(resolveReference("${NOEMA_IMAGE:-ghcr.io/guembri01/noema:latest}"), {
    resolved: true,
    reference: "ghcr.io/guembri01/noema:latest",
  });
  assert.deepEqual(resolveReference("${NOEMA_IMAGE}"), { resolved: false, reference: "" });
}

/** The pinned digest has to be a digest and not a name. */
function assertDigestShape() {
  const findings = analyzeDockerfile(
    `FROM node:24.21.0-alpine3.24@${POSTGRES_DIGEST} AS base\n`,
    "Dockerfile",
  );
  assert.deepEqual(findings, [], "a pinned base image is not a finding");

  const service = analyzeServiceImages(
    `services:\n  db:\n    image: postgres:16-alpine3.24@${POSTGRES_DIGEST}\n`,
    "docker-compose.yml",
  );
  assert.deepEqual(service, [], "a pinned service image is not a finding");
}

const CASES = [
  { name: "the repository passes the gate", run: assertRepositoryIsGreen },
  { name: "the readers see the shapes they are supposed to see", run: assertReaders },
  { name: "a digest is a digest", run: assertDigestShape },
  ...REPORTED.map((testCase) => ({ name: testCase.name, run: () => assertReported(testCase) })),
  ...ACCEPTED.map((testCase) => ({ name: testCase.name, run: () => assertAccepted(testCase) })),
];

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  describe("the image-pin gate (B65)", () => {
    for (const testCase of CASES) {
      it(testCase.name, () => testCase.run());
    }
  });
} else {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      testCase.run();
      console.log(`ok — ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${testCase.name}\n  ${error.message}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
