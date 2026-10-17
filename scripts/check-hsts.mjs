#!/usr/bin/env node
/**
 * Gate: the `Strict-Transport-Security` header (B33).
 *
 *   npm run check:hsts                        # the gate
 *   npx tsx scripts/check-hsts.mjs <config>   # another config file
 *
 * Why the gate exists: HSTS is the one security header of this repository
 * whose value depends on the deployment (`HSTS_MAX_AGE`). The header is sent
 * **by default** — with one year — so a deployment that is served over HTTPS
 * pins HTTPS; a deployment that is not loses nothing, because a browser MUST
 * ignore an STS header that arrives over plain HTTP (RFC 6797 §7.2). The
 * documented way out is `HSTS_MAX_AGE=0`: no header at all.
 *
 * That makes the state easy to break in both directions, and neither side is
 * visible in a code review:
 *
 *   - the header is dropped from the map → the finding returns (the first
 *     request can be downgraded to plain HTTP, which exposes the session
 *     cookie), and
 *   - the header is hardcoded → the deployment can no longer turn it off, and
 *     its `max-age` no longer follows the environment.
 *
 * So the gate does not read the source. It **evaluates the real
 * configuration** — the same `headers()` function Next calls — and looks at
 * the headers that would go on the wire:
 *
 *   1. no `HSTS_MAX_AGE` (the default) → `max-age=31536000`
 *   2. `HSTS_MAX_AGE=0` → NO header (the documented way out)
 *   3. `HSTS_MAX_AGE=31536000` → `max-age=31536000`
 *   4. `HSTS_MAX_AGE=not-a-number` → NO header (fail closed)
 *   5. `HSTS_MAX_AGE=99999999` (beyond the two-year cap) → NO header
 *   6. `HSTS_MAX_AGE=31536000` + `HSTS_INCLUDE_SUBDOMAINS=1` →
 *      `max-age=31536000; includeSubDomains`
 *   7. the five B61 headers must be sent in **every** case — the gate must
 *      not be able to pass a configuration that dropped them.
 *
 * The configuration is a TypeScript file (`next.config.ts`), so the gate needs
 * a TypeScript loader: `tsx` (a devDependency). The CI runs it the same way.
 *
 * `scripts/check-hsts.test.mjs` pins the gate's own verdicts — including the
 * red ones, so a gate that cannot go red cannot pass by accident.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The configuration the gate checks when it is not told otherwise. */
export const DEFAULT_CONFIG = join(ROOT, "next.config.ts");

/** The header this gate is about. */
export const HSTS_HEADER = "Strict-Transport-Security";

/** The environment variables the gate controls while it evaluates. */
export const HSTS_ENV_VARS = ["HSTS_MAX_AGE", "HSTS_INCLUDE_SUBDOMAINS"];

/** The headers every deployment sends (the B61 map) — none of them may go. */
export const BASE_HEADERS = [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
];

/**
 * The scenarios the gate runs: the environment it evaluates the
 * configuration under, and the header value that environment must produce
 * (`null` = no header at all).
 */
export const SCENARIOS = [
  {
    label: "the default (no HSTS_MAX_AGE)",
    env: {},
    expected: "max-age=31536000",
  },
  {
    label: "HSTS_MAX_AGE= (empty: the default)",
    env: { HSTS_MAX_AGE: "" },
    expected: "max-age=31536000",
  },
  {
    label: "HSTS_MAX_AGE=0 (the documented way out)",
    env: { HSTS_MAX_AGE: "0" },
    expected: null,
  },
  {
    label: "HSTS_MAX_AGE=31536000",
    env: { HSTS_MAX_AGE: "31536000" },
    expected: "max-age=31536000",
  },
  {
    label: "HSTS_MAX_AGE=63072000 (the two-year cap)",
    env: { HSTS_MAX_AGE: "63072000" },
    expected: "max-age=63072000",
  },
  {
    label: "HSTS_MAX_AGE=not-a-number",
    env: { HSTS_MAX_AGE: "not-a-number" },
    expected: null,
  },
  {
    label: "HSTS_MAX_AGE=99999999 (beyond the two-year cap)",
    env: { HSTS_MAX_AGE: "99999999" },
    expected: null,
  },
  {
    label: "HSTS_MAX_AGE=31536000 + HSTS_INCLUDE_SUBDOMAINS=1",
    env: { HSTS_MAX_AGE: "31536000", HSTS_INCLUDE_SUBDOMAINS: "1" },
    expected: "max-age=31536000; includeSubDomains",
  },
];

/**
 * The headers a configuration sends under one environment.
 *
 * The environment is set around the call, because the configuration reads it
 * when `headers()` runs — the same moment Next reads it (at build time; see
 * the note in `next.config.ts`). The previous values are restored afterwards,
 * so the gate never leaves the environment of its caller changed.
 *
 * @param {{ headers: () => Promise<{ headers: { key: string, value: string }[] }[]> }} config
 * @param {Record<string, string>} env
 * @returns {Promise<{ key: string, value: string }[]>}
 */
export async function headersFor(config, env) {
  const saved = new Map(HSTS_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of HSTS_ENV_VARS) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  try {
    const entries = await config.headers();
    return entries.flatMap((entry) => entry.headers ?? []);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Check one configuration against every scenario.
 *
 * @param {{ headers: () => Promise<any> }} config
 * @returns {Promise<{ ok: boolean, problems: string[], results: { scenario: object, value: string | null, ok: boolean }[] }>}
 */
export async function checkConfig(config) {
  const problems = [];
  const results = [];
  for (const scenario of SCENARIOS) {
    const headers = await headersFor(config, scenario.env);
    const found = headers.find((header) => header.key === HSTS_HEADER);
    const value = found ? found.value : null;
    const asExpected = value === scenario.expected;
    results.push({ scenario, value, ok: asExpected });
    if (!asExpected) {
      problems.push(
        `${scenario.label}: expected ${scenario.expected === null ? "no header" : `\`${HSTS_HEADER}: ${scenario.expected}\``}, got ${
          value === null ? "no header" : `\`${HSTS_HEADER}: ${value}\``
        }`,
      );
    }
    for (const name of BASE_HEADERS) {
      if (!headers.some((header) => header.key === name)) {
        problems.push(`${scenario.label}: the header \`${name}\` is missing`);
      }
    }
  }
  return { ok: problems.length === 0, problems, results };
}

/**
 * Load a Next configuration from disk.
 *
 * @param {string} file
 * @returns {Promise<{ headers: () => Promise<any> }>}
 */
export async function loadConfig(file) {
  const loaded = await import(pathToFileURL(file).href);
  return loaded.default;
}

async function main() {
  const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CONFIG;
  console.log(`HSTS gate — ${file}\n`);

  let config;
  try {
    config = await loadConfig(file);
  } catch (error) {
    console.error(`check-hsts: FAILED — cannot load ${file}: ${error.message}`);
    process.exit(1);
  }
  if (typeof config?.headers !== "function") {
    console.error(`check-hsts: FAILED — ${file} has no \`headers()\` function`);
    process.exit(1);
  }

  const { ok, problems, results } = await checkConfig(config);
  for (const { scenario, value, ok: asExpected } of results) {
    console.log(
      `  ${asExpected ? "ok  " : "FAIL"} ${scenario.label} → ${
        value === null ? "no header" : `\`${value}\``
      }${asExpected ? "" : ` (expected ${scenario.expected === null ? "no header" : `\`${scenario.expected}\``})`}`,
    );
  }

  if (!ok) {
    console.error(`\ncheck-hsts: FAILED — ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("");
    console.error(
      "The header must be sent by default (one year), `HSTS_MAX_AGE=0` must switch it " +
        "off, a declared max-age must be sent as it is, and a value that cannot be " +
        "parsed must send no header at all.",
    );
    process.exit(1);
  }

  console.log("\nOK — the HSTS header follows the environment: one year by default.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
