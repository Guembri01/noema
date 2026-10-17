// The access-rule gate (scripts/check-access-rule.mjs).
//
// B41: the access-inheritance engine was defined but never called by any
// production path. The gate is a safety net over the tests: it fails when an
// exported access helper has no production caller. A safety net is only as good
// as the holes it is pinned against — so every shape the gate has to tell
// apart lives here as a fixture, and the gate has to report it.
//
// The fixtures below are the shapes that were measured:
//   - an access helper nobody calls — the shape B41 was,
//   - an access helper a production file calls — the shape that must stay
//     green, because a gate that fails everything is no gate,
//   - an access helper whose only caller is another unwired access helper —
//     the transitivity the fund measured ("not transitively either"),
//   - a known-unwired helper — the list the gate holds open,
//   - an access-named export in a client component — UI, not the rule.
//
// The gate runs over a throwaway tree, so the test needs no database, no
// build and no running server. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node scripts/check-access-rule.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-access-rule.mjs", import.meta.url));

/** The message the gate prints for an access helper nobody calls. */
const UNWIRED = "no production path calls it";

/**
 * Run the gate over a throwaway tree.
 *
 * @param {Record<string, string>} files the tree, keyed by path under `src/`.
 * @returns {{code: number, output: string}} the exit code and the output.
 */
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "noema-access-rule-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const path = join(dir, "src", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source, "utf8");
    }
    try {
      const output = execFileSync("node", [GATE], {
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

/** An exported access helper nobody calls. */
const UNCALLED = {
  "lib/orphan.ts": `export function resolveOrphanAccess() {
  return null;
}
`,
};

/** A production file that calls the helper. */
const CALLER = {
  "server/actions/use.ts": `import { resolveOrphanAccess } from "@/lib/orphan";

export async function useIt() {
  return resolveOrphanAccess();
}
`,
};

/** An access helper whose only caller is another unwired access helper. */
const DEAD_CLUSTER = {
  "lib/cluster.ts": `export function resolveClusterAccess() {
  return null;
}
`,
  "lib/cluster-caller.ts": `import { resolveClusterAccess } from "./cluster";

export function callClusterAccess() {
  return resolveClusterAccess();
}
`,
};

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");

  describe("the access-rule gate (B41)", () => {
    it("fails when an exported access helper has no production caller", () => {
      const red = gateOver({ ...UNCALLED });
      assert.equal(red.code, 1, `the gate must fail\n${red.output}`);
      assert.ok(
        red.output.includes(UNWIRED),
        `the gate must say "${UNWIRED}"\n${red.output}`,
      );
      assert.ok(
        red.output.includes("resolveOrphanAccess()"),
        `the gate must name the helper\n${red.output}`,
      );
    });

    it("passes when a production file calls the helper", () => {
      const green = gateOver({ ...UNCALLED, ...CALLER });
      assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
    });

    it("fails when the only caller is another unwired access helper", () => {
      const red = gateOver({ ...DEAD_CLUSTER });
      assert.equal(red.code, 1, `the gate must fail\n${red.output}`);
      assert.ok(
        red.output.includes("resolveClusterAccess()"),
        `the gate must name the helper\n${red.output}`,
      );
    });

    it("passes for a helper on the known-unwired list", () => {
      const green = gateOver({
        "lib/known.ts": `export function canGuestAccess() {
  return false;
}
`,
      });
      assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
    });

    it("ignores an access-named export in a client component", () => {
      const green = gateOver({
        "components/panel.tsx": `"use client";

export function AccessList() {
  return null;
}
`,
      });
      assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
    });
  });
} else {
  const cases = [
    [
      "fails when an exported access helper has no production caller",
      () => {
        const red = gateOver({ ...UNCALLED });
        assert.equal(red.code, 1, `the gate must fail\n${red.output}`);
        assert.ok(
          red.output.includes(UNWIRED),
          `the gate must say "${UNWIRED}"\n${red.output}`,
        );
        assert.ok(
          red.output.includes("resolveOrphanAccess()"),
          `the gate must name the helper\n${red.output}`,
        );
      },
    ],
    [
      "passes when a production file calls the helper",
      () => {
        const green = gateOver({ ...UNCALLED, ...CALLER });
        assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
      },
    ],
    [
      "fails when the only caller is another unwired access helper",
      () => {
        const red = gateOver({ ...DEAD_CLUSTER });
        assert.equal(red.code, 1, `the gate must fail\n${red.output}`);
        assert.ok(
          red.output.includes("resolveClusterAccess()"),
          `the gate must name the helper\n${red.output}`,
        );
      },
    ],
    [
      "passes for a helper on the known-unwired list",
      () => {
        const green = gateOver({
          "lib/known.ts": `export function canGuestAccess() {
  return false;
}
`,
        });
        assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
      },
    ],
    [
      "ignores an access-named export in a client component",
      () => {
        const green = gateOver({
          "components/panel.tsx": `"use client";

export function AccessList() {
  return null;
}
`,
        });
        assert.equal(green.code, 0, `the gate must pass\n${green.output}`);
      },
    ],
  ];

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
