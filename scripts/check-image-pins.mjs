#!/usr/bin/env node
/**
 * Image-pin gate: every image the repository pulls has to be pinned by digest.
 *
 * Why this exists: a tag is a name, not a version. `FROM node:24-alpine`
 * resolves to whatever the registry serves at build time, so the same commit
 * can produce two different images — one of them the bits that were reviewed,
 * one of them whatever was pushed to the tag in the meantime. Nothing in the
 * repository changes when that happens, so the review cannot see it either.
 * The digest fixes the content: `FROM node:24-alpine@sha256:…` pulls the same
 * bits tomorrow, on another machine, in another build.
 *
 * The rules:
 *
 *   1. Every `FROM` of the `Dockerfile` names either a build stage of the same
 *      file (`FROM base AS deps`, where `base` is a stage of this Dockerfile) or
 *      an image with a digest (`image:tag@sha256:…`). `scratch` is the one
 *      reference without a digest: it is the empty base image, not a pull.
 *   2. Every `image:` under a `services:` block — in `docker-compose.yml` and
 *      in the CI workflows — names an image with a digest.
 *
 * One reference is exempt, and the file it lives in says so: the image this
 * repository publishes itself (`ghcr.io/guembri01/noema`). Its digest changes
 * with every release, so a digest in the repository would freeze every
 * installation on the release the file was written for. The release workflow
 * scans and signs the image before it promotes the tag, and an operator who
 * wants a fixed image sets `NOEMA_IMAGE` to a digest — `docker-compose.yml`
 * documents that.
 *
 * Limits:
 *   · The gate reads the *shape* of a pin, not the registry: it cannot tell
 *     whether a digest exists, and it does not check that a digest still
 *     points at the tag next to it. A digest that was measured once stays
 *     valid until it is bumped on purpose.
 *   · Only the `image:` keys below a `services:` key are read. An image that
 *     is pulled by a shell command (`docker run postgres:16-alpine …`) is
 *     outside the gate.
 *   · A `FROM` split over several lines with a `\` continuation is not read.
 *
 *   npm run check:image-pins
 *   node scripts/check-image-pins.mjs --root <dir>   # another tree
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The image this repository publishes itself. */
const FIRST_PARTY_IMAGE = "ghcr.io/guembri01/noema";

/** The empty base image: a constant, not a pull. */
const SCRATCH = "scratch";

/** `image@sha256:<64 hex characters>` — the shape of a digest pin. */
const DIGEST_PIN = /@sha256:[0-9a-f]{64}$/;

/** A digest that is present but not a sha256 digest. */
const SOME_DIGEST = /@sha256:[^@]*$/;

/* ------------------------------------------------------------------ *
 * The readers
 * ------------------------------------------------------------------ */

/**
 * Remove a trailing `#` comment that is not inside a quoted string.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * The `image:` keys that sit inside a `services:` block.
 *
 * Both kinds of file put the images of a service under `services:` — the
 * compose file at the top level, a workflow inside a job. The scan reads the
 * block below a `services:` key, so a key named `image:` anywhere else (a job
 * called `image`, for instance) is not mistaken for an image reference.
 *
 * @param {string} text
 * @returns {{line: number, value: string}[]}
 */
export function collectServiceImages(text) {
  const lines = text.split(/\r?\n/);
  const images = [];
  let servicesIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.length - line.trimStart().length;

    if (servicesIndent >= 0) {
      // The block ends at the first line that is not indented below it.
      if (line.trim() !== "" && indent <= servicesIndent) {
        servicesIndent = -1;
        continue;
      }
      const match = /^(\s*)image:\s*(.+?)\s*$/.exec(line);
      if (match) images.push({ line: index + 1, value: stripComment(match[2]).trim() });
      continue;
    }

    const match = /^(\s*)services:\s*$/.exec(line);
    if (match) servicesIndent = match[1].length;
  }

  return images;
}

/**
 * The `FROM` instructions of a Dockerfile.
 *
 * @param {string} text
 * @returns {{line: number, reference: string, stage: string|null}[]}
 */
export function collectFroms(text) {
  const lines = text.split(/\r?\n/);
  const froms = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*FROM\s+(.+?)\s*$/i.exec(lines[index]);
    if (!match) continue;

    let rest = match[1];
    let stage = null;

    const asMatch = /\s+AS\s+(\S+)\s*$/i.exec(rest);
    if (asMatch) {
      stage = asMatch[1];
      rest = rest.slice(0, asMatch.index);
    }

    // A `--platform=` flag belongs to the instruction, not to the image.
    const platformMatch = /^--platform=\S+\s+(.*)$/.exec(rest.trim());
    if (platformMatch) rest = platformMatch[1];

    froms.push({ line: index + 1, reference: rest.trim(), stage });
  }

  return froms;
}

/**
 * The image a reference resolves to.
 *
 * Compose and the workflows interpolate variables. `${VAR:-default}` and
 * `${VAR-default}` carry the value the reference falls back to; `${VAR}` alone
 * does not — the gate cannot see what it points at, and says so instead of
 * waving it through.
 *
 * @param {string} value
 * @returns {{resolved: boolean, reference: string}}
 */
export function resolveReference(value) {
  let unknown = false;
  const reference = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g,
    (match, name, fallback) => {
      if (fallback === undefined) {
        unknown = true;
        return "";
      }
      return fallback;
    },
  );
  return { resolved: !unknown, reference: reference.trim() };
}

/**
 * Is this the image this repository publishes itself?
 *
 * @param {string} reference
 * @returns {boolean}
 */
function isFirstParty(reference) {
  const name = reference.split("@")[0];
  return name === FIRST_PARTY_IMAGE || name.startsWith(`${FIRST_PARTY_IMAGE}:`);
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Finding
 * @property {string} file
 * @property {number} line
 * @property {string} rule
 * @property {string} message
 */

/**
 * Check the `FROM` instructions of a Dockerfile.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Finding[]}
 */
export function analyzeDockerfile(text, file = "Dockerfile") {
  /** @type {Finding[]} */
  const findings = [];
  const stages = new Set();

  for (const from of collectFroms(text)) {
    const reference = from.reference;

    // The stage this instruction defines — a later `FROM` may name it.
    if (from.stage) stages.add(from.stage);

    if (reference === SCRATCH) continue;

    // A bare word is a stage of this Dockerfile — or an image without a tag,
    // which Docker pulls as `:latest`.
    if (!reference.includes("/") && !reference.includes(":") && !reference.includes("@")) {
      if (stages.has(reference)) continue;
      findings.push({
        file,
        line: from.line,
        rule: "unpinned-base-image",
        message:
          "the base image is pulled without a tag and without a digest, so the build gets whatever `:latest` points at — pin it: `FROM image:tag@sha256:…`",
      });
      continue;
    }

    if (DIGEST_PIN.test(reference)) continue;

    if (SOME_DIGEST.test(reference)) {
      findings.push({
        file,
        line: from.line,
        rule: "malformed-digest",
        message:
          "the digest behind the image is not a sha256 digest (64 hexadecimal characters) — pin it: `postgres:16-alpine@sha256:…`",
      });
      continue;
    }

    findings.push({
      file,
      line: from.line,
      rule: "unpinned-base-image",
      message:
        "the base image is pulled by tag, so a rebuild can fetch other bits than the ones that were reviewed — pin it: `node:24-alpine@sha256:…`",
    });
  }

  return findings;
}

/**
 * Check the `image:` keys of the `services:` blocks of a compose file or a
 * workflow.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Finding[]}
 */
export function analyzeServiceImages(text, file = "docker-compose.yml") {
  /** @type {Finding[]} */
  const findings = [];

  for (const image of collectServiceImages(text)) {
    const { resolved, reference } = resolveReference(image.value);

    if (!resolved) {
      findings.push({
        file,
        line: image.line,
        rule: "unverifiable-image",
        message:
          "the image reference is a variable without a default, so the gate cannot see which image it is — name the image with a digest: `postgres:16-alpine@sha256:…`",
      });
      continue;
    }

    if (reference === "") {
      findings.push({
        file,
        line: image.line,
        rule: "unverifiable-image",
        message:
          "the image reference is empty — name the image with a digest: `postgres:16-alpine@sha256:…`",
      });
      continue;
    }

    if (isFirstParty(reference)) continue;

    if (DIGEST_PIN.test(reference)) continue;

    if (SOME_DIGEST.test(reference)) {
      findings.push({
        file,
        line: image.line,
        rule: "malformed-digest",
        message:
          "the digest behind the image is not a sha256 digest (64 hexadecimal characters) — pin it: `postgres:16-alpine@sha256:…`",
      });
      continue;
    }

    findings.push({
      file,
      line: image.line,
      rule: "unpinned-service-image",
      message:
        "the service image is pulled by tag, so a pull can fetch other bits than the ones that were reviewed — pin it: `postgres:16-alpine@sha256:…`",
    });
  }

  return findings;
}

/**
 * Check every file of the repository that names an image.
 *
 * @param {string} [root]
 * @returns {Finding[]}
 */
export function analyzeRepository(root = ROOT) {
  /** @type {Finding[]} */
  const findings = [];

  findings.push(
    ...analyzeDockerfile(readFileSync(join(root, "Dockerfile"), "utf8"), "Dockerfile"),
  );

  findings.push(
    ...analyzeServiceImages(
      readFileSync(join(root, "docker-compose.yml"), "utf8"),
      "docker-compose.yml",
    ),
  );

  const workflowDir = join(root, ".github", "workflows");
  for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    findings.push(
      ...analyzeServiceImages(
        readFileSync(join(workflowDir, name), "utf8"),
        `.github/workflows/${name}`,
      ),
    );
  }

  return findings;
}

/**
 * The files the gate reads.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function scannedFiles(root = ROOT) {
  const workflowDir = join(root, ".github", "workflows");
  return [
    "Dockerfile",
    "docker-compose.yml",
    ...readdirSync(workflowDir)
      .filter((entry) => /\.ya?ml$/.test(entry))
      .sort()
      .map((entry) => `.github/workflows/${entry}`),
  ];
}

function main() {
  // `--root <dir>` points the gate at another tree — the regression test runs
  // it over a throwaway one.
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? ROOT : resolve(process.argv[rootIndex + 1] ?? ROOT);

  const findings = analyzeRepository(root);
  const files = scannedFiles(root);

  console.log(`image-pin gate — ${files.length} file(s) scanned\n`);

  for (const finding of findings) {
    console.log(`  HOLE    ${finding.file}:${finding.line} — ${finding.message}`);
  }

  if (findings.length === 0) {
    console.log("  ok      every image the repository pulls is pinned by digest");
    console.log(
      "          (the image this repository publishes itself is exempt — see the header of the gate)",
    );
    console.log("\n0 finding(s).");
    process.exit(0);
  }

  console.error(
    [
      "",
      `${findings.length} finding(s).`,
      "",
      "Pin every image the repository pulls by digest:",
      "",
      "  FROM node:24-alpine@sha256:…          # the base image of the build",
      "  image: postgres:16-alpine@sha256:…    # the image of a service",
      "",
      "The tag next to the digest stays, so the line stays readable — the",
      "digest decides which bits are pulled, the tag only names them.",
    ].join("\n"),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
