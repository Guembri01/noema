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
// This gate checks the write paths:
//
//   1. Every write of a `Page.parentId` must carry the value that
//      `assertScopedParent()` proved — or be listed in the ALLOW_LIST below
//      with the reason why the workspace equality holds by construction.
//   2. The value that is written may never be the raw request value
//      (`input.parentId`, `body.parentId`, …): the checked one is the only
//      one that is known to live in the caller's workspace.
//
// It is a **safety net over the tests**, not a proof. What it sees:
//
//   - the files under `src/`; a write outside that tree is invisible,
//   - the Prisma call forms `page.create | createMany | update | updateMany |
//     upsert` (with any receiver — `prisma.`, `tx.`, …) and the payloads
//     that carry a `Prisma.Page*Input` type,
//   - the three ways a parent is written: the `parentId` property, its
//     shorthand, and the Prisma relation form `parent: { connect: { id } }`.
//
// On the branch it finds **31** writes — the same 31 sites an independent
// TypeScript-parser inventory of `src/` finds.
//
// What it does **not** see — a write it cannot recognise is *not* covered by
// it, and the gate is no proof:
//
//   - a raw SQL write (`prisma.$executeRaw`); the repo has none,
//   - a member assignment (`data.parentId = …`), which is not an object
//     literal property,
//   - a payload whose `parentId` is computed by a helper the gate does not
//     follow (a value it cannot attribute to `assertScopedParent()` counts as
//     unguarded, which is the safe direction),
//   - the **callers** of an allow-listed helper: the gate matches a write by
//     file, function and value, so a future caller that hands the helper a raw
//     parent stays green (the helper itself is what rejects it).
//
// The gate reads the source statically; it needs no database, no build and no
// running server. It is the mechanical counterpart of the tests in
// `src/**\/*parent-scope*.test.ts` — the tests pin the behaviour, the gate
// pins the *shape* of every write path it can see, including the ones no test
// covers.

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
const PRISMA_PAGE_INPUT = /Prisma\.Page(?:Unchecked)?(?:Create|Update)(?:Many)?Input/;

/* ------------------------------------------------------------------ scanning */

/**
 * Words after which a `/` opens a regular expression instead of dividing.
 */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Whether a `/` at this position opens a regular expression. The decision is
 * made on the last significant character of code before it: a `/` after an
 * identifier, a `)` or a `]` divides, everywhere else it opens a literal.
 */
function opensRegex(lastChar, word) {
  if (!lastChar) return true;
  if (/[A-Za-z0-9_$]/.test(lastChar)) return REGEX_AFTER_WORD.has(word);
  if (lastChar === ")" || lastChar === "]") return false;
  return true;
}

/**
 * The end of the regular expression that starts at `start`, or -1 when there
 * is none (a division after all).
 */
function regexEnd(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return -1;
    if (inClass) {
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "/") {
      let end = i + 1;
      while (end < text.length && /[A-Za-z]/.test(text[end])) end += 1;
      return end;
    }
    i += 1;
  }
  return -1;
}

/**
 * Blank out the contents of strings, template literals, regular expressions
 * and comments so the bracket matching below cannot be fooled by them. The
 * length is preserved, so every offset stays valid for the original source.
 *
 * The regular expressions matter: a masker that does not know them reads
 * `/[*_`#]/g` as a division and then takes the backtick inside the character
 * class for the start of a template literal — everything after it is masked
 * away and the whole file becomes invisible to the gate. That is exactly what
 * happened in `src/server/actions/chat.ts` (B08, round 3).
 */
function mask(text) {
  const out = text.split("");
  let i = 0;
  // The last significant character of code, and the word that ends there.
  let lastChar = "";
  let lastWord = "";
  let word = "";

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (text[k] !== "\n") out[k] = " ";
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let end = i;
      while (end < text.length && text[end] !== "\n") end += 1;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = i + 2;
      while (end < text.length && !(text[end] === "*" && text[end + 1] === "/")) end += 1;
      end = Math.min(text.length, end + 2);
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      blank(i, end);
      i = end;
      lastChar = quote;
      lastWord = "";
      word = "";
      continue;
    }
    if (ch === "/" && opensRegex(lastChar, word || lastWord)) {
      const end = regexEnd(text, i);
      if (end > 0) {
        blank(i, end);
        i = end;
        lastChar = "x";
        lastWord = "";
        word = "";
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      word += ch;
      lastChar = ch;
      i += 1;
      continue;
    }
    if (word) {
      lastWord = word;
      word = "";
    }
    if (!/\s/.test(ch)) lastChar = ch;
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
 * The kind of the bracket the position `index` sits in directly — `{` for an
 * object literal, `(` for an argument list.
 *
 * It tells a property from an argument: `data: { parentId }` writes the
 * parent, `nextPosition(workspaceId, parentId)` only mentions it. The write
 * call is looked up through every enclosing call, so without this the
 * argument of a helper *inside* a page write would count as a write too.
 */
function enclosingBracket(masked, index) {
  const closers = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = masked[i];
    if (ch === ")" || ch === "}" || ch === "]") {
      closers.push(ch);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      if (closers.length === 0) return ch;
      closers.pop();
    }
  }
  return "";
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

/**
 * The callees of every call the position `index` sits in — from the innermost
 * one outwards.
 *
 * The write call is looked up through **all** of them, not only the nearest:
 * a write in a conditional spread (`data: { …(cond ? { parentId } : {}) }`)
 * sits inside the parentheses of the ternary, and only the outer call is the
 * one that writes the page.
 */
function enclosingCallees(masked, index) {
  const callees = [];
  let cursor = index;
  for (;;) {
    const paren = enclosingOpen(masked, cursor, "(", ")");
    if (paren < 0) break;
    callees.push(calleeBefore(masked, paren));
    cursor = paren;
  }
  return callees;
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
  const call = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*await\\s*${HELPER}\\(`,
    "g",
  );
  let match;
  while ((match = call.exec(body)) !== null) {
    const result = match[1];
    names.add(`${result}.parentId`);
    const local = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*[^;]*?\\b${result}\\.parentId\\b`,
      "g",
    );
    let found;
    while ((found = local.exec(body)) !== null) names.add(found[1]);
  }
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

/**
 * The variable an object literal is assigned to (`const payload = { … }`).
 */
function assignedVariable(masked, brace) {
  const before = masked.slice(Math.max(0, brace - 160), brace);
  const match =
    /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*$/.exec(before);
  return match ? match[1] : null;
}

/**
 * Whether the name is used inside a page write call. That is what turns an
 * object literal that is only *assigned* to a variable into a page write:
 * the payload is handed to `page.create({ data })` further down.
 */
function usedInPageWrite(masked, name) {
  const pattern = new RegExp(`(?<![.\\w$])${name}\\b`, "g");
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    if (enclosingCallees(masked, match.index).some((callee) => PAGE_WRITE.test(callee))) {
      return true;
    }
  }
  return false;
}

/**
 * The Prisma relation form of a parent write — `parent: { connect: { id } }`
 * writes the parent relation, and therefore `Page.parentId`, without ever
 * naming the property. `parent: { disconnect: true }` clears it.
 *
 * Returns the span of the written id, or `"null"` for a disconnect.
 */
function relationWrite(masked, index) {
  const colon = masked.indexOf(":", index);
  if (colon < 0) return null;
  const brace = masked.indexOf("{", colon);
  if (brace < 0) return null;
  const end = matchingClose(masked, brace);
  if (end < 0) return null;
  const body = masked.slice(brace + 1, end);
  if (/^\s*disconnect\s*:\s*true\s*$/.test(body)) return { value: "null" };
  const connect = /connect\s*:\s*\{/.exec(body);
  if (!connect) return null;
  const idBrace = brace + 1 + connect.index + connect[0].lastIndexOf("{");
  const idEnd = matchingClose(masked, idBrace);
  if (idEnd < 0) return null;
  const id = /\bid\s*:/.exec(masked.slice(idBrace + 1, idEnd));
  if (!id) return null;
  const start = idBrace + 1 + id.index + id[0].length;
  return { start, end: idEnd };
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

  // The candidates: `parentId: …` (key/value), `parentId,` (the shorthand)
  // and `parent: { connect: { id } }` (the Prisma relation form).
  const candidates = [];
  const properties = /(?:^|[{,\s(])parentId\b\s*(:?)/g;
  let match;
  while ((match = properties.exec(masked)) !== null) {
    candidates.push({
      index: match.index + match[0].length - "parentId".length,
      shorthand: match[1] !== ":",
    });
  }
  const relations = /(?:^|[{,\s(])parent\b\s*:/g;
  while ((match = relations.exec(masked)) !== null) {
    const index = match.index + match[0].length - "parent".length;
    const relation = relationWrite(masked, index);
    if (!relation) continue;
    candidates.push({ index, shorthand: false, relation });
  }

  for (const candidate of candidates) {
    const index = candidate.index;
    // A property of an object literal writes the parent; the same name as an
    // argument (`nextPosition(workspaceId, parentId)`) only mentions it.
    if (enclosingBracket(masked, index) !== "{") continue;
    const chain = keyChain(masked, index);

    // A read filter (`where`, `select`, …) is not a write.
    if (chain.some((key) => READ_KEYS.has(key))) continue;

    let value;
    if (candidate.relation) {
      value =
        candidate.relation.value ??
        source.slice(candidate.relation.start, candidate.relation.end).trim();
    } else if (candidate.shorthand) {
      value = "parentId";
    } else {
      value = valueExpression(source, masked, index + "parentId".length + 1);
    }
    // A type annotation is not a value.
    if (TYPE_VALUE.test(value)) continue;

    // Is this a write of a *page* parent?
    let isPageWrite = enclosingCallees(masked, index).some((callee) => PAGE_WRITE.test(callee));
    if (!isPageWrite) isPageWrite = hasPrismaPageType(masked, index);
    if (!isPageWrite) {
      // The payload may be built in a variable and handed to the write later.
      let brace = enclosingOpen(masked, index, "{", "}");
      while (brace >= 0) {
        const variable = assignedVariable(masked, brace);
        if (variable && usedInPageWrite(masked, variable)) {
          isPageWrite = true;
          break;
        }
        brace = enclosingOpen(masked, brace, "{", "}");
      }
    }
    if (!isPageWrite) {
      // … or by a helper that is called inside the write.
      const builder = enclosingFunction(functions, index);
      if (builder && usedInPageWrite(masked, builder.name)) isPageWrite = true;
    }
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
    } else if (RAW_REQUEST_VALUE.test(value)) {
      // A raw request value in the expression — even next to a checked one
      // (`parent.parentId ?? input.parentId`) — is a raw request value.
      verdict = "unguarded";
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
