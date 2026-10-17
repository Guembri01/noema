// B08 — the parent-scope gate (scripts/check-parent-scope.mjs).
//
// The gate is a safety net over the tests: it fails when a `Page.parentId`
// write stores a value `assertScopedParent()` has not proved. A safety net is
// only as good as the holes it is pinned against — so every shape of write
// that once slipped past the gate lives here as a fixture, and the gate has
// to report it.
//
// The fixtures below are the shapes that were measured as holes: the five of
// the round-2 review, the two the implementer added, the two the round-3
// review measured — the raw value hiding in the local that carries the
// checked name, and the write that arrives through an object spread — and
// the four the round-4 review measured: the taint is not transitive (a local
// derived from a tainted local), the taint hides in a destructuring, the
// tainted local is re-assigned, and the raw value arrives under a receiver
// name the gate did not know. The round-5 review measured that the taint
// only follows a raw value when it lands in a **visible** `.parentId` read;
// the four the round-6 review measured are the shapes whose initializer the
// gate cannot resolve at all — an object spread, the result of a call, a
// template literal, a JSON round trip. A last fixture is the *clean* case: a
// write through the helper has to stay green, because a gate that fails
// everything is no gate.
//
// The allow-list has a fixture of its own: every entry of it has to hold for
// the one path it describes and for no other — the entry names the value it
// releases **and** the proof that makes the value safe, so a path whose proof
// is gone has to turn the gate red.
//
// The gate runs over a throwaway tree, so the test needs no database, no
// build and no running server. It runs under vitest (the suite picks up
// `scripts/**/*.test.mjs`) and on its own (`node scripts/check-parent-scope.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-parent-scope.mjs", import.meta.url));

/** The repository the allow-list describes. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    name: "the taint is transitive — a local derived from a tainted local is tainted (round 5, L7)",
    file: "probe-taint-transitive.ts",
    source: `export async function probeTaintTransitive(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const raw = input.parentId;
  const parentId = raw ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` carries the raw request value from \`raw\`)`,
  },
  {
    name: "the taint hides in a destructuring (round 5, L7)",
    file: "probe-taint-destructured.ts",
    source: `export async function probeTaintDestructured(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const { parentId: raw } = input;
  const parentId = raw ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` carries the raw request value from \`raw\`)`,
  },
  {
    name: "a re-assigned local carries the raw value (round 5, L7)",
    file: "probe-taint-reassigned.ts",
    source: `export async function probeTaintReassigned(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  let parentId = checked.parentId;
  parentId = input.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` is assigned from the raw request value)`,
  },
  {
    name: "a raw value under an unknown receiver name is a raw value (round 5, L7)",
    file: "probe-taint-receiver.ts",
    source: `export async function probeTaintReceiver(input: { parentId?: string }, workspaceId: string, ctx: { parentId?: string }) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const parentId = ctx.parentId ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` is assigned from the raw request value)`,
  },
  {
    name: "a local the gate cannot resolve — an object spread (round 6, L1)",
    file: "probe-unresolved-spread.ts",
    source: `export async function probeUnresolvedSpread(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const o = { ...input };
  const parentId = o.parentId ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` takes the value from \`o\`, whose origin the gate cannot see)`,
  },
  {
    name: "a local the gate cannot resolve — the result of a call (round 6, L1)",
    file: "probe-unresolved-call.ts",
    source: `export async function probeUnresolvedCall(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const o = Object.assign({}, input);
  const parentId = o.parentId ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` takes the value from \`o\`, whose origin the gate cannot see)`,
  },
  {
    name: "a local the gate cannot resolve — a template literal (round 6, L1)",
    file: "probe-unresolved-template.ts",
    source: `export async function probeUnresolvedTemplate(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const parentId = \`\${input.parentId}\` ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` is built from a template literal whose interpolation the gate cannot read)`,
  },
  {
    name: "a local the gate cannot resolve — a JSON round trip (round 6, L1)",
    file: "probe-unresolved-json.ts",
    source: `export async function probeUnresolvedJson(input: { parentId?: string }, workspaceId: string) {
  const checked = await assertScopedParent({ workspaceId, parentId: input.parentId });
  const o = JSON.parse(JSON.stringify(input));
  const parentId = o.parentId ?? checked.parentId;
  await prisma.page.create({ data: { workspaceId, parentId, title: "probe" } });
}
`,
    expect: `${RAW} (the local \`parentId\` takes the value from \`o\`, whose origin the gate cannot see)`,
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
 * The allow-list of the gate — one case per entry.
 *
 * Every entry names the value it releases **and** the proof that makes the
 * value safe. The case copies the real file into the fixture tree — under
 * the path the entry names, so the entry applies — and breaks the proof: the
 * gate has to report the entry, because an entry whose context is gone must
 * release nothing.
 */
const ALLOW_LIST_CASES = [
  {
    name: "the allow-list entry for createRowAction() holds only while the parent is authorized",
    file: "src/server/actions/database.ts",
    fn: "createRowAction",
    from: "authorizeDatabase(databasePageId)",
    to: "authorizeDatabase(otherPageId)",
    expect:
      "the allow-list entry createRowAction() requires `authorizeDatabase(databasePageId)` in the function",
  },
  {
    name: "the allow-list entry for duplicateDatabaseAction() holds only while the clone is created here",
    file: "src/server/actions/database.ts",
    fn: "duplicateDatabaseAction",
    from: "id: newPageId,",
    to: "id: clonePageId,",
    expect:
      "the allow-list entry duplicateDatabaseAction() requires `id: newPageId, workspaceId: auth.page.workspaceId` in the function",
  },
  {
    name: "the allow-list entry for createRowFromTemplateAction() holds only while the parent is authorized",
    file: "src/server/actions/database.ts",
    fn: "createRowFromTemplateAction",
    from: "authorizeDatabase(databasePageId)",
    to: "authorizeDatabase(otherPageId)",
    expect:
      "the allow-list entry createRowFromTemplateAction() requires `authorizeDatabase(databasePageId)` in the function",
  },
  {
    name: "the allow-list entry for importCsvAction() holds only while the parent is authorized",
    file: "src/server/actions/database.ts",
    fn: "importCsvAction",
    from: "authorizeDatabase(databasePageId)",
    to: "authorizeDatabase(otherPageId)",
    expect:
      "the allow-list entry importCsvAction() requires `authorizeDatabase(databasePageId)` in the function",
  },
  {
    name: "the allow-list entry for seedDatabaseStructure() holds only while the owner is read from that id",
    file: "src/server/actions/pages.ts",
    fn: "seedDatabaseStructure",
    from: "where: { id: databasePageId }",
    to: "where: { id: otherPageId }",
    expect:
      "the allow-list entry seedDatabaseStructure() requires `id: databasePageId` in the function",
  },
  {
    name: "the allow-list entry for createGalleryTemplateAction() holds only while the database is created here",
    file: "src/server/actions/home-templates.ts",
    fn: "createGalleryTemplateAction",
    from: "const database = await prisma.page.create",
    to: "const database = await prisma.page.findUnique",
    expect:
      "the allow-list entry createGalleryTemplateAction() requires `const database = await prisma.page.create` in the function",
  },
  {
    name: "the allow-list entry for instantiateWorkspaceTemplateAction() holds only while the workspace is checked",
    file: "src/server/actions/home-templates.ts",
    fn: "instantiateWorkspaceTemplateAction",
    from: "database.workspaceId !== input.workspaceId",
    to: "database.workspaceId === input.workspaceId",
    expect:
      "the allow-list entry instantiateWorkspaceTemplateAction() requires `database.workspaceId !== input.workspaceId` in the function",
  },
  {
    name: "the allow-list entry for importTrelloAction() holds only while the database is created here",
    file: "src/server/actions/import.ts",
    fn: "importTrelloAction",
    from: "const database = await tx.page.create",
    to: "const database = await tx.page.findUnique",
    expect:
      "the allow-list entry importTrelloAction() requires `const database = await tx.page.create` in the function",
  },
  {
    name: "the allow-list entry for createPage() holds only while the importers prove the parent",
    file: "src/server/actions/import-formats.ts",
    fn: "",
    scope: "file",
    from: "assertScopedParent({ workspaceId, parentId: input.parentId })",
    to: "assertScopedParent({ workspaceId, parentId: rawParentId })",
    expect:
      "the allow-list entry createPage() requires `assertScopedParent({ workspaceId, parentId: input.parentId })` in the file",
  },
  {
    name: "a caller that hands the allow-listed helper the raw parent is reported",
    file: "src/server/actions/import-formats.ts",
    fn: "importHtmlAction",
    from: "parentId,\n",
    to: "parentId: input.parentId,\n",
    expect: "the allow-list entry createPage() is handed a raw parent",
  },
  {
    name: "the allow-list entry for toPageCreateData() holds only while the plan is validated",
    file: "src/server/actions/move-workspace.ts",
    fn: "",
    scope: "file",
    from: "validateMove(plan)",
    to: "validateMoveWithoutOrphans(plan)",
    expect: "the allow-list entry toPageCreateData() requires `validateMove(plan)` in the file",
  },
  {
    name: "the allow-list entry for POST() holds only while the template's database is read by id",
    file: "src/app/api/cron/templates/route.ts",
    fn: "POST",
    from: "where: { id: template.databasePageId }",
    to: "where: { id: otherPageId }",
    expect: "the allow-list entry POST() requires `id: template.databasePageId` in the function",
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
      // A fixture of the gate's own tree lives in `src/`; a file of the
      // repository keeps its path, so the allow-list applies to it.
      const path = join(dir, name.startsWith("src/") ? name : join("src", name));
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

/**
 * The span of the body of a named function — the text a mutation is applied
 * to. The return type may carry braces of its own
 * (`Promise<Result<{ id: string }>>`), so the body is the first brace that
 * is not inside a type argument.
 */
function functionBody(source, fn) {
  const declaration = new RegExp(`(?:function\\s+${fn}\\s*\\()`).exec(source);
  if (!declaration) throw new Error(`the function ${fn}() is not in the file`);
  const paren = source.indexOf("(", declaration.index);
  let depth = 0;
  let index = paren;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let angle = 0;
  let start = index;
  for (; start < source.length; start += 1) {
    const char = source[start];
    if (char === "<") angle += 1;
    else if (char === ">") angle -= 1;
    else if (char === "{" && angle <= 0) break;
  }
  let braces = 0;
  for (let end = start; end < source.length; end += 1) {
    if (source[end] === "{") braces += 1;
    else if (source[end] === "}") {
      braces -= 1;
      if (braces === 0) return { start, end };
    }
  }
  throw new Error(`the body of ${fn}() is not closed`);
}

/**
 * Apply a mutation — in the named function, or in the whole file when the
 * proof of the entry is a file-scoped one.
 */
function mutate(source, testCase) {
  if (testCase.scope === "file") {
    if (!source.includes(testCase.from)) {
      throw new Error(`the text "${testCase.from}" is not in ${testCase.file}`);
    }
    return source.split(testCase.from).join(testCase.to);
  }
  const { start, end } = functionBody(source, testCase.fn);
  const body = source.slice(start, end);
  if (!body.includes(testCase.from)) {
    throw new Error(`the text "${testCase.from}" is not in ${testCase.fn}()`);
  }
  return (
    source.slice(0, start) + body.split(testCase.from).join(testCase.to) + source.slice(end)
  );
}

/**
 * The gate has to hold the allow-list entry — and to let go of it as soon as
 * the proof is gone.
 */
function assertAllowList(testCase) {
  const source = readFileSync(join(ROOT, testCase.file), "utf8");

  // The unmodified file: the entry holds, the gate is green.
  const green = gateOver({ [testCase.file]: source });
  assert.equal(green.code, 0, `${testCase.name}: the file must pass\n${green.output}`);
  assert.ok(
    green.output.includes("allow-listed"),
    `${testCase.name}: the entry must release its write\n${green.output}`,
  );

  // The broken file: the entry does not hold any more, the gate reports it.
  const broken = mutate(source, testCase);
  const red = gateOver({ [testCase.file]: broken });
  assert.equal(red.code, 1, `${testCase.name}: the gate must fail\n${red.output}`);
  assert.ok(
    red.output.includes(testCase.expect),
    `${testCase.name}: the gate must say "${testCase.expect}"\n${red.output}`,
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
    for (const testCase of ALLOW_LIST_CASES) {
      it(testCase.name, () => assertAllowList(testCase));
    }
  });
} else {
  let failed = 0;
  const all = [...CASES.map((testCase) => [testCase.name, () => run(testCase)]), ...ALLOW_LIST_CASES.map((testCase) => [testCase.name, () => assertAllowList(testCase)])];
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
