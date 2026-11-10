// B72 — the target-blank gate (scripts/check-target-blank-links.mjs).
//
// The gate is what keeps the tree's `rel` uniform: every link that opens a
// new tab has to carry `noreferrer noopener`. A convention that only some
// files follow is not a control — so every shape that slips past the gate
// lives here as a fixture, and the gate has to report it.
//
// The fixtures below are the shapes that were measured: the link that writes
// only `noreferrer` (the finding itself), the link that writes no `rel` at
// all, the link that names one token only, the conditional `target` that a
// grep for `target="_blank"` never sees, the arrow function in an attribute
// that cuts a naive tag scan short, and the `>` inside an attribute value that
// does the same. The clean cases are here as well — a gate that fails
// everything is no gate.
//
// The gate runs over a throwaway tree, so the test needs no database, no
// build and no running server. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node
// scripts/check-target-blank-links.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-target-blank-links.mjs", import.meta.url));

/** The repository the gate has to accept. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The fixtures — one file per shape of link, and the message the gate has to
 * print for it. `clean` marks the fixture the gate has to accept.
 */
const CASES = [
  {
    name: "a link that carries only `noreferrer` is reported (B72)",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return (
    <a href="https://x.test" target="_blank" rel="noreferrer">
      x
    </a>
  );
}
`,
    expect: 'rel="noreferrer" is missing noopener',
  },
  {
    name: "a window.open that opens a tab without noreferrer is reported",
    file: "src/probe.ts",
    source: `export function go(href: string) {
  window.open(href, "_blank", "noopener");
}
`,
    expect: 'window.open(..., "noopener") is missing noreferrer',
  },
  {
    name: "a window.open that carries both tokens is accepted",
    file: "src/probe.ts",
    source: `export function go(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}
`,
    clean: true,
  },
  {
    name: "a link without a `rel` is reported",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank">x</a>;
}
`,
    expect: "no rel attribute",
  },
  {
    name: "a link that names `noopener` alone is reported",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank" rel="noopener">x</a>;
}
`,
    expect: 'rel="noopener" is missing noreferrer',
  },
  {
    name: "a `rel` the gate cannot read fails closed",
    file: "src/probe.tsx",
    source: `const REL = "noreferrer noopener";

export function Probe() {
  return <a href="https://x.test" target="_blank" rel={REL}>x</a>;
}
`,
    expect: "rel={REL} is missing noopener and noreferrer",
  },
  {
    name: "a conditional target with a weaker `rel` is reported",
    file: "src/probe.tsx",
    source: `export function Probe({ open }: { open: boolean }) {
  return (
    <a
      href="https://x.test"
      target={open ? "_blank" : undefined}
      rel={open ? "noreferrer" : undefined}
    >
      x
    </a>
  );
}
`,
    expect: 'rel={open ? "noreferrer" : undefined} is missing noopener',
  },
  {
    name: "an arrow function in an attribute does not cut the tag short",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return (
    <a onClick={() => go()} href="https://x.test" target="_blank" rel="noreferrer">
      x
    </a>
  );
}
`,
    expect: 'rel="noreferrer" is missing noopener',
  },
  {
    name: "a `>` inside an attribute value does not cut the tag short",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a title="a > b" href="https://x.test" target="_blank" rel="noreferrer">x</a>;
}
`,
    expect: 'rel="noreferrer" is missing noopener',
  },
  {
    name: "a link with both tokens is accepted",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank" rel="noreferrer noopener">x</a>;
}
`,
    clean: true,
  },
  {
    name: "the tokens in the other order are accepted",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank" rel="noopener noreferrer">x</a>;
}
`,
    clean: true,
  },
  {
    name: "a third token is allowed",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank" rel="noreferrer noopener nofollow">x</a>;
}
`,
    clean: true,
  },
  {
    name: "a conditional target with both tokens is accepted",
    file: "src/probe.tsx",
    source: `export function Probe({ open }: { open: boolean }) {
  return (
    <a
      href="https://x.test"
      target={open ? "_blank" : undefined}
      rel={open ? "noreferrer noopener" : undefined}
    >
      x
    </a>
  );
}
`,
    clean: true,
  },
  {
    name: "a link that does not open a new tab is not scanned",
    file: "src/probe.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_self">x</a>;
}
`,
    clean: true,
  },
  {
    name: "a link in a test file is not scanned (the paste fixtures live there)",
    file: "src/probe.test.tsx",
    source: `export function Probe() {
  return <a href="https://x.test" target="_blank">x</a>;
}
`,
    clean: true,
  },
];

/** The gate has to report the fixture as a violation. */
function assertReported(testCase) {
  const result = gateOver({ [testCase.file]: testCase.source });
  assert.equal(result.code, 1, `${testCase.name}: the gate must fail\n${result.output}`);
  assert.ok(
    result.output.includes(testCase.file),
    `${testCase.name}: the gate must name ${testCase.file}\n${result.output}`,
  );
  assert.ok(
    result.output.includes(testCase.expect),
    `${testCase.name}: the gate must say "${testCase.expect}"\n${result.output}`,
  );
}

/** The gate has to accept the fixture. */
function assertAccepted(testCase) {
  const result = gateOver({ [testCase.file]: testCase.source });
  assert.equal(result.code, 0, `${testCase.name}: the gate must pass\n${result.output}`);
  assert.ok(
    result.output.includes("PASS"),
    `${testCase.name}: the gate must pass\n${result.output}`,
  );
}

/** The gate has to report the fixture as a violation. */
function run(testCase) {
  if (testCase.clean) assertAccepted(testCase);
  else assertReported(testCase);
}

/** The gate over a throwaway tree. */
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "noema-target-blank-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source, "utf8");
    }
    try {
      const output = execFileSync("node", [GATE, dir], {
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
 * The repository itself has to pass — the gate is only a control if it is
 * green on the tree it guards.
 */
function assertRepositoryIsClean() {
  try {
    const output = execFileSync("node", [GATE], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    assert.ok(output.includes("PASS"), `the repository must pass the gate\n${output}`);
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    assert.fail(`the repository must pass the gate\n${output}`);
  }
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  // Every case spawns the gate as a subprocess, and the repository check
  // walks the whole tree — seconds each, stretched further while the rest
  // of the suite loads the machine (P3-T09).
  describe("the target-blank gate (B72)", { timeout: 60_000 }, () => {
    for (const testCase of CASES) {
      it(testCase.name, () => run(testCase));
    }
    it("the repository passes the gate", () => assertRepositoryIsClean());
  });
} else {
  const all = [
    ...CASES.map((testCase) => [testCase.name, () => run(testCase)]),
    ["the repository passes the gate", () => assertRepositoryIsClean()],
  ];
  let failed = 0;
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
