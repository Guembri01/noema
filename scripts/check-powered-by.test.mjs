// B78 — the powered-by gate (scripts/check-powered-by.mjs).
//
// The gate fails when `next.config.ts` does not switch the framework's own
// `X-Powered-By` header off. A gate that fails everything is no gate, and a
// gate that passes everything is no gate either — so both directions are
// pinned here: the shipped config has to pass, and every shape that leaves
// the header in place has to fail.
//
// The shapes below are the ones that were measured as holes while the gate
// was written: the property missing, the switch on (`true`), the value in a
// variable, the value as the *string* `"false"`, the property only in a
// comment, and the property only inside a string literal. A quoted key
// (`"poweredByHeader": false`) is a property like any other and has to pass.
//
// The last case is the one that keeps the gate from falling away: the CI
// workflow has to run the gate (and its own regression test), or the check
// is a file nobody executes.
//
// The gate runs over a throwaway file, so the test needs no build, no
// database and no running server. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node scripts/check-powered-by.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-powered-by.mjs", import.meta.url));

/** The config the gate is about. */
const CONFIG = fileURLToPath(new URL("../next.config.ts", import.meta.url));

/** The workflow that has to run the gate. */
const CI_WORKFLOW = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

/** A minimal config to mutate — the shape of the property is what matters. */
const BASE = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: "1.0.0" },
  poweredByHeader: false,
};

export default nextConfig;
`;

/**
 * Run the gate over a config file.
 *
 * @param {string} source the config the gate reads
 * @returns {{ code: number, output: string }} the exit code and everything
 *   the gate printed
 */
function gateOver(source) {
  const dir = mkdtempSync(join(tmpdir(), "noema-powered-by-"));
  try {
    const file = join(dir, "next.config.ts");
    writeFileSync(file, source, "utf8");
    try {
      const output = execFileSync(process.execPath, [GATE, file], {
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

/** The gate has to pass a config. */
function assertAccepted(source, name) {
  const result = gateOver(source);
  assert.equal(result.code, 0, `${name}: the gate must pass\n${result.output}`);
  assert.ok(result.output.includes("OK"), `${name}: the gate must say OK\n${result.output}`);
}

/** The gate has to report a config. */
function assertReported(source, name, expected) {
  const result = gateOver(source);
  assert.equal(result.code, 1, `${name}: the gate must fail\n${result.output}`);
  assert.ok(
    result.output.includes(expected),
    `${name}: the gate must say "${expected}"\n${result.output}`,
  );
}

/** The shipped config has to pass the gate. */
function assertShippedConfigPasses() {
  const output = execFileSync(process.execPath, [GATE, CONFIG], {
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.ok(output.includes("OK"), `the shipped config must pass\n${output}`);
  assert.ok(
    output.includes("poweredByHeader: false"),
    `the shipped config must switch the header off\n${output}`,
  );
}

/** The shapes that leave the header in place. */
const CASES = [
  {
    name: "the property is missing",
    source: BASE.replace("  poweredByHeader: false,\n", ""),
    expect: "does not set `poweredByHeader`",
  },
  {
    name: "the switch is on",
    source: BASE.replace("poweredByHeader: false", "poweredByHeader: true"),
    expect: "it must be `false`",
  },
  {
    name: "the value is a variable",
    source: BASE.replace("poweredByHeader: false", "poweredByHeader: NO_HEADER"),
    expect: "it must be `false`",
  },
  {
    name: "the value is the string \"false\"",
    source: BASE.replace("poweredByHeader: false", 'poweredByHeader: "false"'),
    expect: "it must be `false`",
  },
  {
    name: "the property is only in a comment",
    source: BASE.replace(
      "  poweredByHeader: false,\n",
      "  // poweredByHeader: false,\n",
    ),
    expect: "does not set `poweredByHeader`",
  },
  {
    name: "the property is only inside a string",
    source: BASE.replace(
      "  poweredByHeader: false,\n",
      '  const hint = "poweredByHeader: false";\n',
    ),
    expect: "does not set `poweredByHeader`",
  },
];

/** The shape that has to pass: a quoted key is a key. */
const ACCEPTED = [
  {
    name: "the key is quoted",
    source: BASE.replace("poweredByHeader: false", '"poweredByHeader": false'),
  },
];

/** The gate has to run in CI — a check nobody executes is not a check. */
function assertRunsInCi() {
  const workflow = readFileSync(CI_WORKFLOW, "utf8");
  assert.ok(
    workflow.includes("scripts/check-powered-by.mjs"),
    "the CI workflow has to run scripts/check-powered-by.mjs",
  );
  assert.ok(
    workflow.includes("scripts/check-powered-by.test.mjs"),
    "the CI workflow has to run the gate's own regression test",
  );
}

function runCase(testCase) {
  assertReported(testCase.source, testCase.name, testCase.expect);
}

function runAccepted(testCase) {
  assertAccepted(testCase.source, testCase.name);
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  describe("the powered-by gate (B78)", () => {
    it("passes the shipped next.config.ts", assertShippedConfigPasses);
    for (const testCase of CASES) {
      it(`fails when ${testCase.name}`, () => runCase(testCase));
    }
    for (const testCase of ACCEPTED) {
      it(`passes when ${testCase.name}`, () => runAccepted(testCase));
    }
    it("runs in the CI workflow", assertRunsInCi);
  });
} else {
  let failed = 0;
  const all = [
    ["passes the shipped next.config.ts", assertShippedConfigPasses],
    ...CASES.map((testCase) => [`fails when ${testCase.name}`, () => runCase(testCase)]),
    ...ACCEPTED.map((testCase) => [`passes when ${testCase.name}`, () => runAccepted(testCase)]),
    ["runs in the CI workflow", assertRunsInCi],
  ];
  for (const [name, body] of all) {
    try {
      body();
      console.log(`ok — ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${name}\n  ${error.message}`);
    }
  }
  console.log(`\n${all.length - failed}/${all.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
