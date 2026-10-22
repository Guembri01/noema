// Gate: an exported access helper must have a production caller.
//
//   node scripts/check-access-rule.mjs          # the gate
//   node scripts/check-access-rule.mjs --list   # every access helper it found
//
// B41 — the access-inheritance engine (`src/lib/access-inheritance.ts`) was a
// complete, *second* access rule: a role baseline, grant inheritance along the
// page tree and link shares. No production path called it — not the page
// route, not a server action, not an API route — and its rule was *stricter*
// than the product's: there a MEMBER holds no implicit baseline, while the
// product grants every member read access to every page. Wiring it in would
// have denied every member every page, so the engine was removed instead.
//
// The product's page-access rule is one rule, in two places:
//   - read: workspace membership (`src/lib/permissions.ts`); a GUEST is scoped
//     by `src/lib/guest-access.ts`,
//   - edit: the same membership plus the page's own `PagePermission` row,
//     which is an edit lock on that page — not a read restriction.
// There is **no** permission inheritance: a `PagePermission` row never
// reaches a child page.
//
// This gate keeps it that way: an exported access helper that no production
// path calls is a second, competing rule. It drifts from the real one, and it
// misleads every reader who trusts the name (B41).
//
// What it sees:
//   - the exported functions of `src/` whose name carries "access" (a client
//     component is skipped — the access rule lives on the server),
//   - their call sites (`name(`) in the non-test sources.
//
// A helper is **live** when a production path can reach it: a file that
// defines no access helper calls it directly, and a helper is live when a
// live helper of its own module calls it. The rule is a fixpoint, so the
// transitivity B41 measured holds too (`db.ts` called `tenant-guard.ts` called
// the engine, and none of the three was called).
//
// What it does **not** see: a call through a computed member
// (`obj["resolvePageAccess"]`), a dynamic `import()`, a module-level call in a
// file that also defines a dead access helper, and a helper whose only caller
// is a module-level call in such a file. The fund measured that the
// repository holds no dynamic access today.
//
// The helpers that are known to be unwired are listed in BASELINE below; that
// list may only shrink.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** The sources the gate reads, relative to the repository root. */
const SRC = "src";

/**
 * The access helpers that no production path calls today. The list may only
 * shrink: a helper that gets a production caller leaves it.
 *
 * - `canGuestAccess` — the guest-grant query form of the guest module; the
 *   guest scope itself is read through `pageScopeFor` / `guestReadablePageIds`.
 */
const BASELINE = new Set(["canGuestAccess"]);

/** A file is a test when its name carries a test suffix. */
function isTestFile(name) {
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

/** A client component is UI, not the server-side access rule. */
function isClientComponent(text) {
  return /^\s*["']use client["']/m.test(text);
}

/** Every source file under `src/`, with its text. */
function collectSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", "test-results"].includes(entry.name)) continue;
      collectSources(full, out);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (isTestFile(entry.name)) continue;
    out.push({ file: full, text: readFileSync(full, "utf8") });
  }
  return out;
}

/** The exported function names of a source file. */
function exportedFunctions(text) {
  const names = new Set();
  for (const match of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g)) {
    names.add(match[1]);
  }
  return names;
}

/** The line a symbol is defined on (1-based), or 0 when it is not found. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index === -1 ? 0 : text.slice(0, index).split("\n").length;
}

const collected = collectSources(SRC);

// B133: a gate that read nothing has checked nothing. `collectSources`
// swallows a directory it cannot read, so a run in the wrong directory (or
// with an unreadable `src`) used to end in "PASS  0 access helper(s)" — a
// green gate that saw no code at all. A broken walk is not a clean
// repository: the gate fails instead.
if (collected.length === 0) {
  console.error(
    "FAIL  the gate read no source at all — a broken walk is not a clean repository",
  );
  console.error(`      expected the sources under \`${SRC}/\` — run the gate in the repository root`);
  process.exit(1);
}

const sources = collected.filter((source) => !isClientComponent(source.text));

/** Every exported access helper: its name, its module and its line. */
const helpers = [];
for (const source of sources) {
  for (const name of exportedFunctions(source.text)) {
    if (!/access/i.test(name)) continue;
    helpers.push({
      name,
      file: relative(process.cwd(), source.file).replace(/\\/g, "/"),
      line: lineOf(source.text, `function ${name}`),
    });
  }
}

/** The access helpers a module defines. */
const helpersIn = new Map();
for (const helper of helpers) {
  const names = helpersIn.get(helper.file) ?? [];
  names.push(helper.name);
  helpersIn.set(helper.file, names);
}

/** The production files that call a helper (`name(`), its own module excluded. */
function callersOf(name, ownFile) {
  const callers = [];
  for (const source of sources) {
    const file = relative(process.cwd(), source.file).replace(/\\/g, "/");
    if (file === ownFile) continue;
    if (new RegExp(`\\b${name}\\s*\\(`).test(source.text)) callers.push(file);
  }
  return callers;
}

/**
 * The live helpers — the ones a production path can reach.
 *
 * A file that defines no access helper calls it directly; a helper is live
 * when a live helper of its own module calls it. The fixpoint makes the
 * transitivity hold: a helper whose only callers are dead helpers is dead.
 */
const live = new Set();
let changed = true;
while (changed) {
  changed = false;
  for (const helper of helpers) {
    if (live.has(helper.name)) continue;
    const callers = callersOf(helper.name, helper.file);
    if (callers.length === 0) continue;
    const reachable = callers.some((caller) => {
      const defined = helpersIn.get(caller) ?? [];
      if (defined.length === 0) return true;
      return defined.some((name) => live.has(name));
    });
    if (reachable) {
      live.add(helper.name);
      changed = true;
    }
  }
}

const unwired = helpers.filter((helper) => !live.has(helper.name));
const problems = unwired.filter((helper) => !BASELINE.has(helper.name));
const known = unwired.filter((helper) => BASELINE.has(helper.name));

if (process.argv.includes("--list")) {
  for (const helper of [...helpers].sort((a, b) => a.name.localeCompare(b.name))) {
    const state = live.has(helper.name) ? "live" : BASELINE.has(helper.name) ? "known unwired" : "UNWIRED";
    console.log(`${helper.file}:${helper.line}  ${helper.name}()  ${state}`);
  }
  console.log(`\n${helpers.length} access helper(s)`);
  process.exit(0);
}

if (problems.length > 0) {
  console.error(
    `FAIL  every exported access helper must have a production caller (${problems.length} unwired helper(s))`,
  );
  for (const problem of problems) {
    console.error(
      `      ${problem.file}:${problem.line}  ${problem.name}() — no production path calls it`,
    );
  }
  console.error("");
  console.error(
    "Call the helper from a production path, or delete it: an access rule nobody calls drifts from the real one (B41).",
  );
  process.exit(1);
}

const knownNames = known.map((helper) => helper.name).sort();
console.log(
  `PASS  ${helpers.length} access helper(s): ${live.size} live, ${unwired.length} unwired` +
    (knownNames.length > 0 ? ` (known: ${knownNames.join(", ")})` : ""),
);
