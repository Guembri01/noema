#!/usr/bin/env node
/**
 * Gate: the compose smoke test in the site workflow must describe the stack it
 * actually starts.
 *
 * Why this exists: the `compose-smoke` job in `.github/workflows/site.yml` is
 * the **only** place where the container deployment path is exercised end to
 * end — the compose file, the image, the database, the health probe. It once
 * could not succeed, and it could not succeed for three independent reasons,
 * each of them a one-line difference between the workflow and the stack the
 * workflow claims to test:
 *
 *   · the `app` service sits behind the `app` profile, and the job started the
 *     stack with a plain `docker compose up -d --build` — so the app was never
 *     started at all,
 *   · the compose file publishes the app on host port 3202, and the probe
 *     asked for port 3200 — so the probe could never answer,
 *   · and the image booted without applying the migrations, so the database
 *     stayed empty.
 *
 * None of the three is visible in the workflow file alone: the profile and the
 * port live in `docker-compose.yml`, the boot path lives in the `Dockerfile`
 * and in the boot wrapper. The job therefore failed *after* minutes of
 * waiting, with "the app never became ready", and the reason was in a file
 * nobody had opened.
 *
 * This gate reads those files and checks that they agree:
 *
 *   1. the job starts the stack with the profile that gates the app service,
 *   2. the readiness probe asks for the port the compose file publishes, and
 *      for the app's health endpoint,
 *   3. the database is migrated before the probe — by the job itself, or by
 *      the image's boot path (the boot wrapper applies the migrations before
 *      it starts the server).
 *
 * It is a static scan: no Docker, no daemon, no database. That matters,
 * because the gate has to run on **every** pull request — the compose job
 * itself only runs on a push to `main`, so a pull request that breaks the
 * container path would otherwise be merged unseen.
 *
 * Limits of the YAML subset this reader understands (the same decision
 * `scripts/check-workflow-permissions.mjs` makes: the repository has no YAML
 * dependency on purpose):
 *   · it reads the block structure of the subset the workflow and the compose
 *     file use — two-space indentation, `key: value` mappings, `- ` list items
 *     and block scalars. Flow mappings (`ports: ["3202:3000"]`) are read as
 *     inline lists; anchors and aliases are not resolved,
 *   · the port it checks is the **host** port the compose file publishes and
 *     the probe asks for. It does not look at the container's own port, which
 *     the compose health check probes from the inside,
 *   · the image it checks is the one the repository's `Dockerfile` builds. The
 *     compose file builds it (`build:` with `target: runner`), and the gate
 *     says so when it does not.
 *
 *   node scripts/check-compose-smoke.mjs                              # the gate
 *   node scripts/check-compose-smoke.mjs --workflow site.yml          # another workflow
 *   node scripts/check-compose-smoke.mjs --dockerfile Dockerfile       # another image
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files the gate reads. */
const FILES = {
  workflow: join(ROOT, ".github", "workflows", "site.yml"),
  compose: join(ROOT, "docker-compose.yml"),
  dockerfile: join(ROOT, "Dockerfile"),
  bootWrapper: join(ROOT, "scripts", "desktop", "boot-wrapper.cjs"),
};

/** The endpoint the app answers on (and the compose health check asks for). */
const HEALTH_PATH = "/api/health";

/* ------------------------------------------------------------------ *
 * The workflow reader
 *
 * A scanner, not a YAML parser. It reads the block structure of the subset
 * the workflow files use and answers one question: what does the `run:` of
 * every step of one job say, and on which line does it stand?
 * ------------------------------------------------------------------ */

/**
 * The steps of one job.
 *
 * @param {string} text  the workflow file
 * @param {string} job   the job's name (`compose-smoke`)
 * @returns {{found: boolean, line: number, steps: {name: string, line: number, runLine: number, run: string, runLines: {text: string, line: number}[]}[]}}
 */
export function readJobSteps(text, job) {
  const lines = text.split(/\r?\n/);

  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return { found: false, line: 1, steps: [] };

  const header = new RegExp(`^ {2}${job}:\\s*$`);
  let start = -1;
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    if (header.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start === -1) return { found: false, line: jobsAt + 1, steps: [] };

  // The job's body: every line indented deeper than the job's own key.
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") {
      body.push({ text: raw, line: index + 1 });
      continue;
    }
    if (raw.length - raw.trimStart().length <= 2) break;
    body.push({ text: raw, line: index + 1 });
  }

  const steps = [];
  let current = null;
  for (let index = 0; index < body.length; index += 1) {
    const raw = body[index].text;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    // A step begins with `- ` at the step list's own indentation.
    if (indent === 6 && trimmed.startsWith("- ")) {
      current = { name: "", line: body[index].line, runLine: 0, run: "", runLines: [] };
      steps.push(current);
      const rest = trimmed.slice(2).trim();
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rest);
      if (match) {
        if (match[1] === "name") current.name = match[2];
        if (match[1] === "run") {
          current.runLine = body[index].line;
          current.run = match[2];
          current.runLines = [{ text: match[2], line: body[index].line }];
        }
      }
      continue;
    }
    if (!current) continue;

    // The keys of a step (`name:`, `run:`) sit one level below the `- `.
    if (indent !== 8) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, value] = match;

    if (key === "name") {
      current.name = value;
      continue;
    }
    if (key !== "run") continue;

    current.runLine = body[index].line;
    if (!/^[|>][-+]?\d*$/.test(value)) {
      current.run = value;
      current.runLines = [{ text: value, line: body[index].line }];
      continue;
    }

    // A block scalar: the program text is the lines below it.
    const collected = [];
    for (let cursor = index + 1; cursor < body.length; cursor += 1) {
      const next = body[cursor];
      if (next.text.trim() === "") {
        collected.push({ text: "", line: next.line });
        continue;
      }
      if (next.text.length - next.text.trimStart().length <= indent) break;
      collected.push({ text: next.text.trim(), line: next.line });
    }
    current.runLines = collected;
    current.run = collected.map((entry) => entry.text).join("\n");
  }

  return { found: true, line: start + 1, steps };
}

/* ------------------------------------------------------------------ *
 * The compose reader
 * ------------------------------------------------------------------ */

/** Split an inline flow list (`["a", "b"]`) into its entries. */
function parseInlineList(value) {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  const body = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return body
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry !== "");
}

/**
 * The services of a compose file.
 *
 * @param {string} text
 * @returns {Map<string, {name: string, line: number, profiles: {value: string, line: number}[], ports: {value: string, line: number}[], command: {value: string, line: number} | null, builds: boolean}>}
 */
export function readComposeServices(text) {
  const lines = text.split(/\r?\n/);
  const services = new Map();
  let inServices = false;
  let service = null;
  let listKey = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      inServices = /^services:\s*$/.test(trimmed);
      service = null;
      listKey = null;
      continue;
    }
    if (!inServices) continue;

    if (indent === 2) {
      const name = trimmed.replace(/:\s*$/, "");
      service = {
        name,
        line: index + 1,
        profiles: [],
        ports: [],
        command: null,
        builds: false,
      };
      services.set(name, service);
      listKey = null;
      continue;
    }
    if (!service) continue;

    if (indent === 4) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, value] = match;
      listKey = null;
      if (key === "profiles") {
        for (const entry of parseInlineList(value)) {
          service.profiles.push({ value: entry, line: index + 1 });
        }
        listKey = "profiles";
        continue;
      }
      if (key === "ports") {
        for (const entry of parseInlineList(value)) {
          service.ports.push({ value: entry, line: index + 1 });
        }
        listKey = "ports";
        continue;
      }
      if (key === "command") {
        service.command = { value, line: index + 1 };
        continue;
      }
      if (key === "build") {
        service.builds = true;
        continue;
      }
      continue;
    }

    // A block list under `profiles:` or `ports:`.
    if (indent === 6 && trimmed.startsWith("- ") && listKey) {
      const value = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      service[listKey].push({ value, line: index + 1 });
    }
  }

  return services;
}

/**
 * The host and the container port of a compose port mapping.
 *
 * `"3202:3000"` publishes the container's 3000 on the host's 3202;
 * `"127.0.0.1:3202:3000"` pins the host address as well.
 *
 * @param {string} value
 * @returns {{host: number, container: number} | null}
 */
export function parsePortMapping(value) {
  const parts = value.split(":").filter((part) => part !== "");
  if (parts.length < 2) return null;
  const host = Number.parseInt(parts[parts.length - 2], 10);
  const container = Number.parseInt(parts[parts.length - 1], 10);
  if (!Number.isInteger(host) || !Number.isInteger(container)) return null;
  return { host, container };
}

/* ------------------------------------------------------------------ *
 * The boot path
 * ------------------------------------------------------------------ */

/**
 * Does the image apply the migrations before it starts serving?
 *
 * The image boots through the boot wrapper (`start.cjs`, staged from
 * `scripts/desktop/boot-wrapper.cjs`), which runs `prisma migrate deploy`
 * before it starts the server. A `next start` in the `CMD` — or a wrapper
 * that serves first — leaves the database empty, and the app answers 503 on
 * every request that touches a table.
 *
 * @param {string} dockerfile
 * @param {string} bootWrapper
 * @returns {{ok: boolean, reason: string}}
 */
export function imageAppliesMigrations(dockerfile, bootWrapper) {
  const cmd = /^CMD\s+(.+)$/m.exec(dockerfile);
  if (!cmd) {
    return { ok: false, reason: "the Dockerfile has no `CMD` — the image has no boot path", line: 1 };
  }
  const line = dockerfile.slice(0, cmd.index).split("\n").length;
  if (!/start\.cjs/.test(cmd[1])) {
    return {
      ok: false,
      reason: `the image boots with \`CMD ${cmd[1].trim()}\` and not with the boot wrapper, so it never applies the migrations`,
      line,
    };
  }

  if (!/migrate["',\s]+deploy/.test(bootWrapper)) {
    return {
      ok: false,
      reason: "the boot wrapper never runs `prisma migrate deploy`",
      line,
    };
  }

  // The wrapper must migrate *before* it serves. `function startServer()` is a
  // declaration, a call is `startServer();` — so the call sites are the ones
  // that end in a semicolon.
  const migrateAt = bootWrapper.search(/\bawait\s+migrate\s*\(/);
  const serveAt = bootWrapper.search(/\bstartServer\s*\(\s*\)\s*;/);
  if (migrateAt === -1 || serveAt === -1) {
    return {
      ok: false,
      reason: "the boot wrapper does not migrate before it starts the server",
      line,
    };
  }
  if (migrateAt > serveAt) {
    return {
      ok: false,
      reason: "the boot wrapper starts the server before it applies the migrations",
      line,
    };
  }

  return { ok: true, reason: "", line };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Check that the compose smoke test describes the stack it starts.
 *
 * @param {{workflow: string, compose: string, dockerfile: string, bootWrapper: string, workflowFile?: string, composeFile?: string, dockerfileFile?: string}} input
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function analyzeComposeSmoke(input) {
  const { workflow, compose, dockerfile, bootWrapper } = input;
  const file = input.workflowFile ?? ".github/workflows/site.yml";
  const composeFile = input.composeFile ?? "docker-compose.yml";
  const dockerfileFile = input.dockerfileFile ?? "Dockerfile";
  const findings = [];

  const job = readJobSteps(workflow, "compose-smoke");
  if (!job.found) {
    findings.push({
      file,
      line: job.line,
      rule: "compose-smoke-job-missing",
      message:
        "the site workflow has no `compose-smoke` job — the compose stack is never smoke-tested, so the container deployment path is never verified",
    });
    return findings;
  }

  const services = readComposeServices(compose);
  const published = [];
  for (const service of services.values()) {
    for (const port of service.ports) {
      const mapping = parsePortMapping(port.value);
      if (mapping) published.push({ service, ...mapping, line: port.line });
    }
  }

  // Every command that starts the stack, and every profile it activates.
  const starts = [];
  const activated = new Set();
  for (const step of job.steps) {
    for (const entry of step.runLines) {
      if (!/\bdocker\s+compose\b/.test(entry.text)) continue;
      if (!/\bup\b/.test(entry.text)) continue;
      starts.push({ text: entry.text.trim(), line: entry.line });
      for (const match of entry.text.matchAll(/--profile[= ]+([A-Za-z0-9_.-]+)/g)) {
        activated.add(match[1]);
      }
    }
  }
  if (starts.length === 0) {
    findings.push({
      file,
      line: job.line,
      rule: "stack-start-missing",
      message:
        "the `compose-smoke` job never starts the stack (`docker compose … up`) — there is nothing to probe",
    });
    return findings;
  }

  // Every URL the job asks for.
  const urls = [];
  for (const step of job.steps) {
    for (const entry of step.runLines) {
      const pattern = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?([^\s'"\\)]*)/g;
      for (const match of entry.text.matchAll(pattern)) {
        urls.push({
          url: match[0],
          port: match[1] ? Number.parseInt(match[1], 10) : 80,
          path: match[2] === "" ? "/" : match[2],
          line: entry.line,
        });
      }
    }
  }

  const health = urls.filter((url) => url.path === HEALTH_PATH || url.path.startsWith(`${HEALTH_PATH}?`));
  if (health.length === 0) {
    findings.push({
      file,
      line: job.line,
      rule: "no-health-probe",
      message: `the \`compose-smoke\` job never probes ${HEALTH_PATH} — the readiness step must wait for the app's health endpoint`,
    });
  }

  const probe = health[0] ?? urls[0] ?? null;
  const target = probe ? published.find((entry) => entry.host === probe.port) : null;

  if (probe && !target) {
    const list = published.map((entry) => `${entry.host} (\`${entry.service.name}\`)`).join(", ");
    findings.push({
      file,
      line: probe.line,
      rule: "probe-port-mismatch",
      message:
        `the readiness probe asks for port ${probe.port} on 127.0.0.1, but the compose stack publishes ` +
        `${list === "" ? "no port at all" : list} — the probe can never answer`,
    });
  }

  // The service the probe talks to must actually be started: a service that
  // sits behind a profile only comes up when the profile is activated. When
  // the port matches no service at all, the gate cannot know which service
  // was meant — so it takes the profiled services that publish a host port,
  // the ones the smoke test would have to reach.
  const reachable = target
    ? [target]
    : published.filter((entry) => entry.service.profiles.length > 0);
  for (const entry of reachable) {
    for (const profile of entry.service.profiles) {
      if (activated.has(profile.value)) continue;
      findings.push({
        file,
        line: starts[0].line,
        rule: "profile-not-activated",
        message:
          `the stack is started without \`--profile ${profile.value}\` (\`${starts[0].text}\`) — the ` +
          `\`${entry.service.name}\` service sits behind that profile, so it never starts and the smoke test can never succeed`,
      });
    }
  }

  // Every other URL of the job must use the published port as well.
  for (const url of urls) {
    if (!probe || url === probe) continue;
    if (url.port === probe.port) continue;
    findings.push({
      file,
      line: url.line,
      rule: "probe-port-mismatch",
      message:
        `the job asks for port ${url.port} on 127.0.0.1, but the compose stack publishes port ${probe.port} — ` +
        "that request can never answer",
    });
  }

  // The database must be migrated before the probe: either by the job itself,
  // or by the image the stack starts.
  const migratesInJob = job.steps.some((step) => /migrate\s+deploy/.test(step.run));
  if (!migratesInJob) {
    const image = imageAppliesMigrations(dockerfile, bootWrapper);
    const overridden = target && target.service.command;
    if (overridden) {
      findings.push({
        file: composeFile,
        line: overridden.line,
        rule: "migration-not-applied",
        message:
          `the compose service overrides the image's command (\`command: ${overridden.value}\`), so the boot path — ` +
          "and with it the migration — never runs",
      });
    } else if (!image.ok) {
      findings.push({
        file: dockerfileFile,
        line: image.line,
        rule: "migration-not-applied",
        message:
          `the database is never migrated before the probe — neither the job nor the image applies ` +
          `\`prisma migrate deploy\` (${image.reason}), so the container starts against an empty schema`,
      });
    }
  }

  // The stack must run the image of the repository, not the published one:
  // otherwise the smoke test says nothing about the code under review.
  if (target && !target.service.builds) {
    findings.push({
      file: composeFile,
      line: target.service.line,
      rule: "image-not-built-from-repository",
      message:
        `the \`${target.service.name}\` service has no \`build:\` section — the stack would run the published image ` +
        "instead of the code under review, so the smoke test would not test this commit",
    });
  }

  return findings;
}

/**
 * Check the files in the repository.
 *
 * Every file may be pointed at another one — the gate is then a question
 * about *these* files, which is how the shapes it closes are demonstrated
 * against a workflow that is broken on purpose.
 *
 * @param {{workflowFile?: string, composeFile?: string, dockerfileFile?: string, bootWrapperFile?: string}} options
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function analyzeRepository(options = {}) {
  const workflowPath = options.workflowFile ?? FILES.workflow;
  const composePath = options.composeFile ?? FILES.compose;
  const dockerfilePath = options.dockerfileFile ?? FILES.dockerfile;
  const bootWrapperPath = options.bootWrapperFile ?? FILES.bootWrapper;
  return analyzeComposeSmoke({
    workflow: readFileSync(workflowPath, "utf8"),
    compose: readFileSync(composePath, "utf8"),
    dockerfile: readFileSync(dockerfilePath, "utf8"),
    bootWrapper: readFileSync(bootWrapperPath, "utf8"),
    workflowFile: label(workflowPath),
    composeFile: label(composePath),
    dockerfileFile: label(dockerfilePath),
  });
}

/** The name a path is reported under: relative to the repository, if it is in it. */
function label(path) {
  if (!isAbsolute(path)) return path;
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? path : rel.replace(/\\/g, "/");
}

/**
 * The command line: `--workflow`, `--compose`, `--dockerfile` and
 * `--boot-wrapper` point the gate at other files. A positional argument is
 * the workflow.
 */
function parseArguments(argv) {
  const options = {};
  const flags = {
    "--workflow": "workflowFile",
    "--compose": "composeFile",
    "--dockerfile": "dockerfileFile",
    "--boot-wrapper": "bootWrapperFile",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag in flags) {
      options[flags[flag]] = argv[index + 1];
      index += 1;
      continue;
    }
    if (!flag.startsWith("-") && !options.workflowFile) {
      options.workflowFile = flag;
    }
  }
  return options;
}

function main() {
  const findings = analyzeRepository(parseArguments(process.argv.slice(2)));

  console.log("compose-smoke gate — the workflow, the compose file and the image must agree\n");

  for (const finding of findings) {
    console.log(`  HOLE    ${finding.file}:${finding.line} — ${finding.message}`);
  }

  if (findings.length === 0) {
    console.log(
      "  ok      the smoke test starts the stack the compose file describes, probes the published port,",
    );
    console.log("          and the image applies the migrations before the probe.");
    console.log("\n0 finding(s).");
    process.exit(0);
  }

  console.error(
    [
      "",
      `${findings.length} finding(s).`,
      "",
      "The compose smoke test cannot succeed while these hold. Start the stack with the profile that",
      "gates the app service, probe the port the compose file publishes, and let the image apply the",
      "migrations (the boot wrapper does it) before the probe.",
    ].join("\n"),
  );
  process.exit(1);
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
