// Gate: a `Page.parentId` may only be written through `assertScopedParent()`.
//
//   node scripts/check-parent-scope.mjs          # the gate
//   node scripts/check-parent-scope.mjs --list   # every write it found
//
// `Page.parentId` is a plain foreign key — the schema carries no composite
// `(parentId, workspaceId)` constraint, so the *application* is the only thing
// that keeps a page inside its own workspace. Until now that invariant rested
// on a code comment in every file that writes a parent: a convention, and
// nothing else. A later refactor that added an importer, or that touched one
// of the call sites, silently re-opened the cross-tenant hole (B08).
//
// This gate makes the invariant mechanical:
//
//   1. Every write of a `Page.parentId` must carry the value that
//      `assertScopedParent()` proved — or be listed in the ALLOW_LIST below
//      with the reason why the workspace equality holds by construction.
//   2. The value that is written may never be the raw request value
//      (`input.parentId`, `body.parentId`, …): the checked one is the only
//      one that is known to live in the caller's workspace.
//
// The gate reads the source statically; it needs no database, no build and no
// running server. It is the mechanical counterpart of the tests in
// `src/**\/*parent-scope*.test.ts` — the tests pin the behaviour, the gate
// pins the *shape* of every write path, including the ones no test covers.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The write paths where the parent and the row provably share one workspace
 * without a second lookup. Every entry names the file, the function, the
 * written value **and** the reason — the gate exists because a comment alone
 * was not enough, so an entry without a reason is a bug in the gate.
 */
const ALLOW_LIST = [
  {
    file: "src/server/actions/database.ts",
    fn: "createRowAction",
    value: "databasePageId",
    reason:
      "the parent is the database page `authorizeDatabase` just checked, and the row is written into that very page's workspace",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "duplicateDatabaseAction",
    value: "newPageId",
    reason:
      "the parent is the clone's own database page, created in this same transaction with the same workspace id",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "createRowFromTemplateAction",
    value: "databasePageId",
    reason: "the parent is the authorized database the row template belongs to",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "importCsvAction",
    value: "databasePageId",
    reason: "the parent is the database the caller authorized",
  },
  {
    file: "src/server/actions/pages.ts",
    fn: "seedDatabaseStructure",
    value: "databasePageId",
    reason: "the parent is the database page the owner was read from",
  },
  {
    file: "src/server/actions/home-templates.ts",
    fn: "createGalleryTemplateAction",
    value: "database.id",
    reason: "the parent is the database page this action just created in the same workspace",
  },
  {
    file: "src/server/actions/home-templates.ts",
    fn: "instantiateWorkspaceTemplateAction",
    value: "database.id",
    reason:
      "the parent is the template's database page, whose workspace was checked against the request workspace",
  },
  {
    file: "src/server/actions/import.ts",
    fn: "importTrelloAction",
    value: "database.id",
    reason: "the parent is the database page this action just created in the same transaction",
  },
  {
    file: "src/server/actions/import-formats.ts",
    fn: "createPage",
    value: "input.parentId",
    reason:
      "the importers resolve the parent with `assertScopedParent` before they call this helper — the value handed in is the checked one",
  },
  {
    file: "src/server/actions/move-workspace.ts",
    fn: "toPageCreateData",
    value: 'typeof page.parentId === "string" && page.parentId.length > 0 ? page.parentId : null',
    reason:
      "the move planner remaps the parent into the moved set (or drops it to null); `validateMove` rejects an orphaned parent",
  },
  {
    file: "src/app/api/cron/templates/route.ts",
    fn: "POST",
    value: "template.databasePageId",
    reason: "the parent is the template's own database page, read by id in the same request",
  },
];

/** The helper that makes a parent write safe. */
const HELPER = "assertScopedParent";

/** Object keys that carry a *read* filter, never a write. */
const READ_KEYS = new Set([
  "where",
  "select",
  "include",
  "orderBy",
  "cursor",
  "omit",
  "relation",
  "relationName",
]);

/** Values that are a type, not a runtime parent id. */
const TYPE_VALUE =
  /^(string|number|boolean|Date|undefined|void|bigint|symbol|unknown|any|never|object)\b/;

/** A parent id taken straight from the request — never the checked value. */
const RAW_REQUEST_VALUE =
  /\b(input|body|args|params|payload|request|req|formData|form)\s*\.\s*parentId\b/;

const PAGE_WRITE = /\bpage\.(create|createMany|update|updateMany|upsert)$/;
const PRISMA_PAGE_INPUT = /Prisma\.Page(Create|Update)(Many)?Input/;

/* ------------------------------------------------------------------ scanning */

/**
 * Blank out the contents of strings, template literals and comments so the
 * bracket matching below cannot be fooled by them. The length is preserved,
 * so every offset stays valid for the original source.
 */
function mask(text) {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      out[i] = " ";
      if (i + 1 < text.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out[i] = " ";
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out[i] = " ";
          if (i + 1 < text.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out[i] = " ";
          i += 1;
          break;
        }
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** The index of the bracket that closes the one at `index`. */
function matchingClose(masked, index) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[masked[index]];
  let depth = 0;
  for (let i = index + 1; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === masked[index]) depth += 1;
    else if (ch === close) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** The bracket that opens the pair the one around `index` closes. */
function enclosingOpen(masked, index, openChar, closeChar) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = masked[i];
    if (ch === closeChar) depth += 1;
    else if (ch === openChar) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * The brace that opens the body of a function whose parameter list ends at
 * `from` — the return type annotation may carry braces of its own
 * (`Promise<Result<{ id: string }>>`), so the first brace is not the body.
 */
function bodyBraceAfter(masked, from) {
  let angle = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "<") {
      angle += 1;
      continue;
    }
    if (ch === ">") {
      if (angle > 0) angle -= 1;
      continue;
    }
    if (ch === "{") {
      if (angle > 0) {
        i = matchingClose(masked, i);
        continue;
      }
      return i;
    }
    if (ch === ";") return -1;
  }
  return -1;
}

/** The call expression the bracket at `index` belongs to (`prisma.page.create`). */
function calleeBefore(masked, index) {
  const before = masked.slice(Math.max(0, index - 160), index);
  const match = /([A-Za-z0-9_$]+(?:\s*\.\s*[A-Za-z0-9_$]+)*)\s*$/.exec(before);
  return match ? match[1].replace(/\s+/g, "") : "";
}

/** The key of the object literal the brace at `index` opens (`data`, `where`). */
function keyBefore(masked, index) {
  const before = masked.slice(Math.max(0, index - 120), index);
  const match = /([A-Za-z0-9_$]+)\s*:\s*$/.exec(before);
  return match ? match[1] : "";
}

/** The named functions of a file, with the span of their body. */
function namedFunctions(masked) {
  const functions = [];

  const declarations =
    /(?:^|[^\w$.])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]*)\s*\(/g;
  let match;
  while ((match = declarations.exec(masked)) !== null) {
    const name = match[1];
    const paren = masked.indexOf("(", match.index + match[0].length - 1);
    if (paren < 0) continue;
    const paramsEnd = matchingClose(masked, paren);
    if (paramsEnd < 0) continue;
    const brace = bodyBraceAfter(masked, paramsEnd);
    if (brace < 0) continue;
    const bodyEnd = matchingClose(masked, brace);
    if (bodyEnd < 0) continue;
    if (name) functions.push({ name, start: brace, end: bodyEnd });
  }

  const arrows = /=>\s*\{/g;
  while ((match = arrows.exec(masked)) !== null) {
    const brace = masked.indexOf("{", match.index);
    // The head of the arrow has to *be* this `const name = … =>` — otherwise
    // the nearest `const` in the file would be mistaken for the name.
    const before = masked.slice(Math.max(0, match.index - 400), match.index);
    const named =
      /(?:^|[^\w$.])(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*(?::[^=]*?)?$/.exec(
        before,
      );
    if (!named) continue;
    const bodyEnd = matchingClose(masked, brace);
    if (bodyEnd < 0) continue;
    functions.push({ name: named[1], start: brace, end: bodyEnd });
  }

  return functions;
}

/** The innermost named function that contains `index`. */
function enclosingFunction(functions, index) {
  let found = null;
  for (const fn of functions) {
    if (fn.start <= index && index <= fn.end) {
      if (!found || fn.start > found.start) found = fn;
    }
  }
  return found;
}

/** The value expression of the property that starts at `index`. */
function valueExpression(source, masked, index) {
  let depth = 0;
  let i = index;
  for (; i < source.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === "," && depth === 0) break;
  }
  return source.slice(index, i).trim();
}

/** The chain of object keys the property at `index` sits in. */
function keyChain(masked, index) {
  const chain = [];
  let cursor = index;
  for (;;) {
    const brace = enclosingOpen(masked, cursor, "{", "}");
    if (brace < 0) break;
    chain.push(keyBefore(masked, brace));
    cursor = brace;
  }
  return chain;
}

/**
 * Whether the object literal the property sits in is annotated with a Prisma
 * page input type (`Prisma.PageCreateManyInput` and friends) — that is how a
 * page payload is built when it is not written inline.
 */
function hasPrismaPageType(masked, index) {
  let cursor = index;
  for (;;) {
    const brace = enclosingOpen(masked, cursor, "{", "}");
    if (brace < 0) return false;
    const before = masked.slice(0, brace);
    const boundary = Math.max(
      before.lastIndexOf(";"),
      before.lastIndexOf("}"),
      before.lastIndexOf("{"),
    );
    if (PRISMA_PAGE_INPUT.test(before.slice(boundary + 1))) return true;
    cursor = brace;
  }
}

/**
 * The names that carry the parent the helper proved: the helper's own result
 * field and every local that was assigned from it.
 */
function checkedNames(body) {
  const names = new Set();
  const call = new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*await\\s+${HELPER}\\(`).exec(
    body,
  );
  if (!call) return names;
  const result = call[1];
  names.add(`${result}.parentId`);
  const local = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*[^;]*?\\b${result}\\.parentId\\b`,
    "g",
  );
  let match;
  while ((match = local.exec(body)) !== null) names.add(match[1]);
  return names;
}

/** Whether the expression mentions one of the checked names. */
function mentionsChecked(value, names) {
  for (const name of names) {
    // A plain name only counts when it stands on its own — `input.parentId`
    // is the request value, not the checked one.
    const token = name.includes(".") ? name.replace(".", "\\.") : name;
    const pattern = name.includes(".")
      ? new RegExp(`\\b${token}\\b`)
      : new RegExp(`(?<![.\\w$])${token}\\b`);
    if (pattern.test(value)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ the scan */

function collectFiles(root) {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !/\.d\.ts$/.test(entry.name)
      ) {
        files.push(path);
      }
    }
  })(root);
  return files;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

const problems = [];
const checked = [];
const usedEntries = new Set();
const root = "src";

for (const path of collectFiles(root)) {
  const source = readFileSync(path, "utf8");
  const masked = mask(source);
  const functions = namedFunctions(masked);
  const file = relative(".", path);

  // `parentId: …` (key/value) and `parentId,` (the shorthand) are both writes.
  const properties = /(?:^|[{,\s(])parentId\b\s*(:?)/g;
  let match;
  while ((match = properties.exec(masked)) !== null) {
    const index = match.index + match[0].length - "parentId".length;
    const shorthand = match[1] !== ":";
    const chain = keyChain(masked, index);

    // A read filter (`where`, `select`, …) is not a write.
    if (chain.some((key) => READ_KEYS.has(key))) continue;

    const value = shorthand
      ? "parentId"
      : valueExpression(source, masked, match.index + match[0].length);
    // A type annotation is not a value.
    if (TYPE_VALUE.test(value)) continue;

    // Is this a write of a *page* parent?
    const paren = enclosingOpen(masked, index, "(", ")");
    const callee = paren < 0 ? "" : calleeBefore(masked, paren);
    const isPageWrite = PAGE_WRITE.test(callee) || hasPrismaPageType(masked, index);
    if (!isPageWrite) continue;

    const fn = enclosingFunction(functions, index);
    const fnName = fn ? fn.name : "<module scope>";
    const body = fn ? masked.slice(fn.start, fn.end) : masked;
    const names = checkedNames(body);

    const entry = ALLOW_LIST.find(
      (item) => item.file === file && item.fn === fnName && item.value === value,
    );
    let verdict;
    if (entry) {
      usedEntries.add(entry);
      verdict = "allow-listed";
    } else if (value === "null") {
      verdict = "root";
    } else if (names.size > 0 && mentionsChecked(value, names)) {
      verdict = "guarded";
    } else {
      verdict = "unguarded";
    }

    checked.push({ file, line: lineOf(source, index), fn: fnName, value, verdict });

    if (verdict !== "unguarded") continue;
    if (RAW_REQUEST_VALUE.test(value)) {
      problems.push({
        file,
        line: lineOf(source, index),
        text: `parentId: ${value} — write the value ${HELPER}() returned, not the raw request value`,
      });
      continue;
    }
    problems.push({
      file,
      line: lineOf(source, index),
      text: `parentId: ${value} — no ${HELPER}() call in ${fnName}() and no allow-list entry`,
    });
  }
}

/* ------------------------------------------------------------------- report */

for (const entry of ALLOW_LIST) {
  if (!usedEntries.has(entry)) {
    problems.push({
      file: entry.file,
      line: 0,
      text: `allow-list entry ${entry.fn}() / \`parentId: ${entry.value}\` matches no write — remove it`,
    });
  }
  if (!entry.reason || entry.reason.length < 20) {
    problems.push({
      file: entry.file,
      line: 0,
      text: `allow-list entry ${entry.fn}() has no reason — every entry must say why the workspace equality holds`,
    });
  }
}

if (process.argv.includes("--list")) {
  for (const item of checked) {
    console.log(`${item.file}:${item.line}  ${item.fn}()  parentId: ${item.value}  ${item.verdict}`);
  }
  console.log(`\n${checked.length} Page.parentId write(s)`);
  process.exit(0);
}

if (problems.length > 0) {
  console.error(
    `FAIL  every Page.parentId write must go through ${HELPER}() (${problems.length} problem(s))`,
  );
  for (const problem of problems) {
    console.error(`      ${problem.file}:${problem.line}  ${problem.text}`);
  }
  console.error("");
  console.error(
    `Call ${HELPER}({ workspaceId, parentId }) before the write and store the id it returns, or add a reasoned entry to the ALLOW_LIST in scripts/check-parent-scope.mjs.`,
  );
  process.exit(1);
}

const counts = checked.reduce((acc, item) => {
  acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `PASS  ${checked.length} Page.parentId write(s): ${counts.guarded ?? 0} guarded by ${HELPER}(), ${counts["allow-listed"] ?? 0} allow-listed, ${counts.root ?? 0} workspace root`,
);
