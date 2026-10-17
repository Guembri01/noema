// B34 — the secret gate (scripts/check-secrets.mjs).
//
// The gate has two halves, and both are pinned here:
//
//   1. The **tree** scan. A live key pasted into a fixture is published like
//      any other file, so the test files are scanned with the rest of the
//      tree. The skip that exempted them wholesale is gone; the fake values
//      the fixtures need are exempted by *value* instead — and only where the
//      value is a fixture, so the same literal in a source file is reported.
//   2. The **history** scan. A credential that was committed and later
//      removed is still in the published history — the commit is the
//      publication, not the current tree — so the gate walks the blobs of the
//      ref under review.
//
// A gate is only as good as the holes it is pinned against, so the cases
// below are the shapes that matter: the exploit of the finding (a key in a
// test file), the leak that cannot be undone (a key that was removed again),
// and the cases that have to stay green — a documented example and a fixture
// literal are not credentials.
//
// The gate runs over a throwaway repository: each case writes the files, the
// commits, and then runs the script against it. The gate resolves the
// repository from its own location, so the script is copied into the
// throwaway tree — the way a checkout looks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-secrets.mjs", import.meta.url));

/**
 * A key in the shape a provider issues.
 *
 * The literal is assembled at runtime: the gate scans this file as well, and
 * a committed key-shaped literal would be a finding of its own — the very
 * thing the gate is there to report.
 */
const LIVE_KEY = ["sk-live", "REALKEY1234567890"].join("-");

/** A fixture literal of the test suites — exempt in a test file, nowhere else. */
const FIXTURE_KEY = "sk-live-abcdef1234567890";

/** A documented example — exempt everywhere. */
const DOCUMENTED_KEY = "sk-example-0000000000000000";

/**
 * Run the gate over a throwaway repository.
 *
 * `commits` is one file set per commit: the files the commit holds, and a
 * `null` source for a file the commit removes. The gate is run twice — once
 * over the tree, once with `--history` — and both answers are returned, so a
 * case can hold that the tree is green while the history is not.
 */
function gateOver(commits) {
  const dir = mkdtempSync(join(tmpdir(), "noema-secrets-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Tester");
    git("config", "user.email", "tester@example.com");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(GATE, join(dir, "scripts", "check-secrets.mjs"));

    for (const files of commits) {
      for (const [name, source] of Object.entries(files)) {
        const path = join(dir, name);
        if (source === null) {
          rmSync(path, { force: true });
          continue;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source, "utf8");
      }
      git("add", "-A");
      git("commit", "--quiet", "--allow-empty", "-m", "probe");
    }

    return {
      tree: run(dir, []),
      history: run(dir, ["--history"]),
      // The same tree, scanned through `--root`: the gate stays where it is
      // and looks at the other directory.
      rootHistory: runRoot(dir, ["--history"]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the gate over the throwaway repository through `--root`. */
function runRoot(dir, args) {
  try {
    const output = execFileSync("node", [GATE, "--root", dir, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Run the gate in the throwaway repository. */
function run(dir, args) {
  try {
    const output = execFileSync("node", [join(dir, "scripts", "check-secrets.mjs"), ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** The gate has to report the value, and name where it is. */
function assertReported(result, expected) {
  assert.equal(result.code, 1, `the gate must fail\n${result.output}`);
  for (const needle of expected) {
    assert.ok(result.output.includes(needle), `the gate must name "${needle}"\n${result.output}`);
  }
}

/** The gate has to stay green. */
function assertAccepted(result) {
  assert.equal(result.code, 0, `the gate must stay green\n${result.output}`);
}

const CASES = [
  {
    name: "a live key in a test file is reported",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${LIVE_KEY}";\n` }],
    reported: ["src/lib/example.test.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a live key in a source file is reported",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${LIVE_KEY}";\n` }],
    reported: ["src/lib/example.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a documented example stays green",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${DOCUMENTED_KEY}";\n` }],
    accepted: true,
  },
  {
    name: "a fixture literal in a test file stays green",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    accepted: true,
  },
  {
    name: "the same fixture literal outside a test file is reported",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    reported: ["src/lib/example.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a credential that was committed and removed again is reported by the history scan",
    commits: [
      { "src/lib/leaked.ts": `const API_KEY = "${LIVE_KEY}";\n` },
      { "src/lib/leaked.ts": null },
    ],
    // The tree is clean again — the file is gone. The history is not: the
    // commit is the publication, and the value is still in it.
    treeGreen: true,
    historyReported: ["src/lib/leaked.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "the history scan stays green on a clean repository",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    treeGreen: true,
    historyGreen: true,
  },
  {
    name: "the history scan walks the history of a tree that is scanned with --root",
    commits: [
      { "src/lib/leaked.ts": `const API_KEY = "${LIVE_KEY}";\n` },
      { "src/lib/leaked.ts": null },
    ],
    // The tree is clean again — the file is gone. The history is not. The
    // directory of the throw-away repository must not become the ref of the
    // history scan: `git rev-list --objects <dir>` answers with an empty list
    // and exit 0, so a scan that walked 0 blobs would report green.
    treeGreen: true,
    rootHistoryReported: ["src/lib/leaked.ts:1", "OpenAI / DeepSeek key"],
  },
];

function runCase(testCase) {
  const result = gateOver(testCase.commits);
  if (testCase.reported) assertReported(result.tree, testCase.reported);
  if (testCase.accepted) assertAccepted(result.tree);
  if (testCase.treeGreen) assertAccepted(result.tree);
  if (testCase.historyReported) assertReported(result.history, testCase.historyReported);
  if (testCase.historyGreen) assertAccepted(result.history);
  if (testCase.rootHistoryReported) {
    assertReported(result.rootHistory, testCase.rootHistoryReported);
  }
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  describe("the secret gate (B34)", () => {
    for (const testCase of CASES) {
      it(testCase.name, () => runCase(testCase));
    }
  });
} else {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      runCase(testCase);
      console.log(`ok — ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${testCase.name}\n  ${error.message}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
