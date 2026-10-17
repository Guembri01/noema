// B09 — the compose exposure gate (scripts/check-compose-exposure.mjs).
//
// The hole it closes: the compose stack published its database on every
// interface of the machine (`ports: - "5433:5432"` binds 0.0.0.0) and started
// it with a password that was written down in the file (`POSTGRES_PASSWORD:
// noema`). Both halves were published in the repository, so the pair was a
// ready-to-use credential for anyone who could reach the host.
//
// The gate has to catch every shape of that hole and nothing else:
//
//  · the database port without a host part, on `0.0.0.0` and on a LAN address
//    — all three bind the database to more than the loopback;
//  · a fixed `POSTGRES_PASSWORD`, a *defaulted* one (`${…:-noema}` — a fixed
//    value with a warning attached) and a fixed password inside a connection
//    string;
//  · the `.env.example` template shipping a password that works.
//
// The clean cases are pinned too: a gate that fails everything is no gate, so
// the loopback binding, the mandatory interpolation and the placeholder in the
// template have to stay green.
//
// The negative control is the compose file as it was before the fix — the gate
// has to report it, otherwise the test would pass for the wrong reason.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCompose, auditEnvExample } from "./check-compose-exposure.mjs";

const GATE = fileURLToPath(new URL("./check-compose-exposure.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The compose file as it was before the fix — the negative control. */
const VULNERABLE_COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:16-alpine",
  "    environment:",
  "      POSTGRES_USER: noema",
  "      POSTGRES_PASSWORD: noema",
  "      POSTGRES_DB: noema",
  "    ports:",
  '      - "5433:5432"',
  "  app:",
  "    image: ${NOEMA_IMAGE:-ghcr.io/guembri01/noema:latest}",
  "    environment:",
  "      DATABASE_URL: postgresql://noema:noema@db:5432/noema?schema=public",
  "",
].join("\n");

/** The compose file as it is after the fix. */
const FIXED_COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:16-alpine",
  "    environment:",
  "      POSTGRES_USER: noema",
  '      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"',
  "      POSTGRES_DB: noema",
  "    ports:",
  '      - "127.0.0.1:5433:5432"',
  "  app:",
  "    image: ${NOEMA_IMAGE:-ghcr.io/guembri01/noema:latest}",
  "    environment:",
  '      DATABASE_URL: "postgresql://noema:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@db:5432/noema?schema=public"',
  "",
].join("\n");

/** The `.env` template as it was before the fix. */
const VULNERABLE_ENV_EXAMPLE = [
  "# Noema — local development environment",
  'DATABASE_URL="postgresql://noema:noema@localhost:5433/noema?schema=public"',
  "",
].join("\n");

/** The `.env` template as it is after the fix. */
const FIXED_ENV_EXAMPLE = [
  "# Noema — local development environment",
  "POSTGRES_PASSWORD=",
  'DATABASE_URL="postgresql://noema:<POSTGRES_PASSWORD>@localhost:5433/noema?schema=public"',
  "",
].join("\n");

/** The compose file with one line replaced. */
function withLine(source, from, to) {
  const lines = source.split("\n");
  const at = lines.indexOf(from);
  assert.notEqual(at, -1, `the fixture must contain ${from}`);
  lines[at] = to;
  return lines.join("\n");
}

/** The rules the gate reports for a compose file. */
function rules(source) {
  return auditCompose(source, "docker-compose.yml").map((item) => item.rule);
}

/** The message the gate reports for a compose file, at `line`. */
function message(source, line) {
  const found = auditCompose(source, "docker-compose.yml").find((item) => item.line === line);
  assert.ok(found, `the gate must report a finding on line ${line}`);
  return found.message;
}

const cases = [];
const test = (name, body) => cases.push([name, body]);

// --- the shipped files ------------------------------------------------------

test("the shipped compose file passes the gate", () => {
  const text = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  assert.deepEqual(auditCompose(text, "docker-compose.yml"), []);
});

test("the shipped .env.example passes the gate", () => {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert.deepEqual(auditEnvExample(text, ".env.example"), []);
});

// --- the negative control ---------------------------------------------------

test("the compose file as it was before the fix is reported", () => {
  const findings = auditCompose(VULNERABLE_COMPOSE, "docker-compose.yml");
  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((item) => item.rule),
    ["interface", "password", "password"],
  );
  assert.equal(findings[0].line, 9);
  assert.equal(findings[1].line, 6);
  assert.equal(findings[2].line, 13);
});

test("the .env.example as it was before the fix is reported", () => {
  const findings = auditEnvExample(VULNERABLE_ENV_EXAMPLE, ".env.example");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "password");
  assert.equal(findings[0].line, 2);
});

// --- the interface rule -----------------------------------------------------

test("a database port without a host part is reported", () => {
  const source = withLine(FIXED_COMPOSE, '      - "127.0.0.1:5433:5432"', '      - "5433:5432"');
  assert.ok(rules(source).includes("interface"));
  assert.match(message(source, 9), /published on every interface/);
});

test("a database port on 0.0.0.0 is reported", () => {
  const source = withLine(FIXED_COMPOSE, '      - "127.0.0.1:5433:5432"', '      - "0.0.0.0:5433:5432"');
  assert.ok(rules(source).includes("interface"));
});

test("a database port on a LAN address is reported", () => {
  const source = withLine(FIXED_COMPOSE, '      - "127.0.0.1:5433:5432"', '      - "192.168.1.10:5433:5432"');
  assert.ok(rules(source).includes("interface"));
});

test("a database port in the long form without a host_ip is reported", () => {
  const source = withLine(
    FIXED_COMPOSE,
    '      - "127.0.0.1:5433:5432"',
    ["      - target: 5432", '        published: "5433"'].join("\n"),
  );
  assert.ok(rules(source).includes("interface"));
});

test("a database port in the long form on the loopback is accepted", () => {
  const source = withLine(
    FIXED_COMPOSE,
    '      - "127.0.0.1:5433:5432"',
    ["      - target: 5432", '        published: "5433"', "        host_ip: 127.0.0.1"].join("\n"),
  );
  assert.deepEqual(rules(source), []);
});

test("the app service may publish its port on every interface", () => {
  // The app is the web app: it is meant to be reached. Only the database is
  // held to the loopback rule.
  const source = withLine(
    FIXED_COMPOSE,
    '      DATABASE_URL: "postgresql://noema:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@db:5432/noema?schema=public"',
    [
      '      DATABASE_URL: "postgresql://noema:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@db:5432/noema?schema=public"',
      '    ports:',
      '      - "3202:3000"',
    ].join("\n"),
  );
  assert.deepEqual(rules(source), []);
});

// --- the password rules -----------------------------------------------------

test("a fixed POSTGRES_PASSWORD is reported", () => {
  const source = withLine(
    FIXED_COMPOSE,
    '      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"',
    "      POSTGRES_PASSWORD: noema",
  );
  assert.ok(rules(source).includes("password"));
  assert.match(message(source, 6), /POSTGRES_PASSWORD is a fixed value \("noema"\)/);
});

test("a defaulted POSTGRES_PASSWORD is reported", () => {
  const source = withLine(
    FIXED_COMPOSE,
    '      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"',
    '      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-noema}"',
  );
  assert.ok(rules(source).includes("password"));
  assert.match(message(source, 6), /POSTGRES_PASSWORD is a fixed value/);
});

test("a fixed password in a connection string is reported", () => {
  const source = withLine(
    FIXED_COMPOSE,
    '      DATABASE_URL: "postgresql://noema:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@db:5432/noema?schema=public"',
    "      DATABASE_URL: postgresql://noema:noema@db:5432/noema?schema=public",
  );
  assert.ok(rules(source).includes("password"));
  assert.match(message(source, 13), /connection string carries a fixed password \("noema"\)/);
});

test("an interpolated password in a connection string is accepted", () => {
  assert.deepEqual(rules(FIXED_COMPOSE), []);
});

// --- the template rules -----------------------------------------------------

test("a template that ships a fixed password is reported", () => {
  const findings = auditEnvExample(VULNERABLE_ENV_EXAMPLE, ".env.example");
  assert.match(findings[0].message, /ships a fixed database password \("noema"\)/);
});

test("a template with a fixed POSTGRES_PASSWORD is reported", () => {
  const source = withLine(FIXED_ENV_EXAMPLE, "POSTGRES_PASSWORD=", "POSTGRES_PASSWORD=noema");
  const findings = auditEnvExample(source, ".env.example");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /ships a fixed database password \("noema"\)/);
});

test("a template with an empty password and a placeholder is accepted", () => {
  assert.deepEqual(auditEnvExample(FIXED_ENV_EXAMPLE, ".env.example"), []);
});

// --- the gate as a command --------------------------------------------------

test("the gate fails on the compose file as it was before the fix", () => {
  const run = gateOver({ "docker-compose.yml": VULNERABLE_COMPOSE });
  assert.equal(run.code, 1);
  assert.match(run.output, /published on every interface/);
  assert.match(run.output, /POSTGRES_PASSWORD is a fixed value \("noema"\)/);
});

test("the gate passes on the compose file as it is", () => {
  const run = gateOver({ "docker-compose.yml": FIXED_COMPOSE });
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /0 finding\(s\)/);
});

/** Run the gate over a throwaway tree and report its exit code and output. */
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "noema-compose-gate-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    const paths = Object.keys(files).map((name) => join(dir, name));
    try {
      const output = execFileSync(process.execPath, [GATE, ...paths], { encoding: "utf8" });
      return { code: 0, output };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  describe("the compose exposure gate (B09)", () => {
    for (const [name, body] of cases) {
      it(name, () => body());
    }
  });
} else {
  let failed = 0;
  for (const [name, body] of cases) {
    try {
      body();
      console.log(`ok — ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${name}\n  ${error.message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
