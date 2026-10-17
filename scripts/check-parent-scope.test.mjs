// B08 — the parent-scope gate (scripts/check-parent-scope.mjs).
//
// The gate is a safety net over the tests: it fails when a `Page.parentId`
// write stores a value `assertScopedParent()` has not proved. A safety net is
// only as good as the holes it is pinned against — so every shape of write
// that once slipped past the gate lives here as a fixture, and the gate has
// to report it.
//
// The fixtures below are the nine shapes that were measured as holes: the
// five of the round-2 review, the two the implementer added, and the two the
// round-3 review measured — the raw value hiding in the local that carries
// the checked name, and the write that arrives through an object spread. A
// last fixture is the *clean* case: a write through the helper has to stay
// green, because a gate that fails everything is no gate.
//
// The gate runs over a throwaway tree, so the test needs no database, no
// build and no running server. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node scripts/check-parent-scope.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = new URL("./check-parent-scope.mjs", import.meta.url).pathname;

/** The message the gate prints when the written value is the raw request value. */
const RAW = "write the value assertScopedParent() returned, not the raw request value";

/** The message the gate prints when a write carries no proof at all. */
const UNGUARDED = "no assertScopedParent() call in";

/**
 * The fixtures — one file per shape of write, and the message the gate has
 * to print for it.
 */
const CASES = [
  {
    name: "a file with a regular expression literal is still read (round 2, a)",
    file: "probe-regex.ts",
    source: `export async function probeRegex(message: { thread: { pageId: string } }, workspaceId: string) {
  const title = "probe".replace(/[*_\`#]/g, "-");
  await prisma.page.create({ data: { workspaceId, title, parentId: message.thread.pageId } });
}
`,
    expect: UNGUARDED,
  },
  {
    name: "a write in a conditional spread is found (round 2, b)",
    file: "probe-conditional.ts",
    source: `export async function probeConditional(input: { parentId?: string }, workspaceId: string, cond: boolean) {
  await prisma.page.create({
    data: {
      workspaceId,
      title: "probe",
      ...(cond ? { parentId: input.parentId } : {}),
    },
  });
}
`,
    expect: RAW,
  },
  {
    name: "a mixed expression is a raw request value (round 2, c)",
    file: "probe-mixed.ts",
    source: `export async function probeMixed(parent: { parentId?: string }, input: { parentId?: string }, workspaceId: string) {
  await prisma.page.create({ data: { workspaceId, title: "probe", parentId: parent.parentId ?? input.parentId } });
}
`,
    expect: RAW,
  },
  {
    name: "an unchecked Prisma page input is a write (round 2, d)",
    file: "probe-unchecked.ts",
    source: `export async function probeUnchecked(input: { parentId?: string }, workspaceId: string) {
  const data: Prisma.PageUncheckedCreateInput = { workspaceId, title: "probe", parentId: input.parentId };
  await prisma.page.create({ data });
}
`,
    expect: RAW,
  },
  {
    name: "the Prisma relation form is a write (round 2, e)",
    file: "probe-relation.ts",
    source: `export async function probeRelation(input: { parentId?: string }, workspaceId: string) {
  await prisma.page.create({ data: { workspaceId, title: "probe", parent: { connect: { id: input.parentId } } } });
}
`,
    expect: RAW,
  },
  {
    name: "a payload built in a variable is a write (round 2, f)",
    file: "probe-payload.ts",
    source: `export async function probePayload(input: { parentId?: string }, workspaceId: string) {
  const data = { workspaceId, title: "probe", parentId: input.parentId };
  await prisma.page.create({ data });
}
`,
    expect: RAW,
  },
  {
    name: "a payload built by a helper is a write (round 2, g)",
    file: "probe-helper.ts",
    source: `function buildPayload(input: { parentId?: string }, workspaceId: string) {
  return { workspaceId, title: "probe", parentId: input.parentId };
}

export async function probeHelper(input: { parentId?: string }, workspaceId: string) {
  await prisma.page.create({ data: buildPayload(input, workspaceId) });
}
`,
    expect: RAW,
  },
  {
    name: "the raw value in the local that carries the checked name is a raw write (round 4, A)",
    file: "probe-tainted-local.ts",
    source: `export async function probeTaintedLocal(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const parentId = input.parentId ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` is assigned from the raw request value)`,
  },
  {
    name: "a write that arrives through an object spread is a write (round 4, B)",
    file: "probe-spread.ts",
    source: `export async function probeSpread(input: { parentId?: string }, workspaceId: string) {
  const payload = { parentId: input.parentId };
  await prisma.page.create({ data: { workspaceId, title: "probe", ...payload } });
}
`,
    expect: RAW,
  },
  {
    name: "a write through the helper stays green",
    file: "probe-guarded.ts",
    source: `export async function probeGuarded(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const parentId = checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
  await prisma.page.update({ where: { id: "probe" }, data: { parentId: checked.parentId } });
}
`,
    clean: true,
    expect: "PASS  2 Page.parentId write(s): 2 guarded by assertScopedParent()",
  },
  {
    // The allow-list describes the repository. A run over a fixture tree has
    // no entries of its own, and the repository's must not be reported as
    // stale there — otherwise the gate could not be run over a fixture at all.
    name: "the repository's allow-list does not leak into a fixture tree",
    file: "probe-allow-list.ts",
    source: `export async function probeAllowList(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  await prisma.page.create({ data: { workspaceId, title: "probe", parentId: checked.parentId } });
}
`,
    clean: true,
    expect:
      "PASS  1 Page.parentId write(s): 1 guarded by assertScopedParent(), 0 allow-listed, 0 workspace root",
  },
];

/**
 * Run the gate over a throwaway tree that holds the given files.
 * Returns the exit code and the output of the gate.
 */
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "noema-parent-scope-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, "src", name), source, "utf8");
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
    result.output.includes(testCase.expect),
    `${testCase.name}: the gate must say "${testCase.expect}"\n${result.output}`,
  );
}

function run(testCase) {
  if (testCase.clean) assertAccepted(testCase);
  else assertReported(testCase);
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");
  describe("the parent-scope gate (B08)", () => {
    for (const testCase of CASES) {
      it(testCase.name, () => run(testCase));
    }
  });
} else {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      run(testCase);
      console.log(`ok — ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${testCase.name}\n  ${error.message}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
