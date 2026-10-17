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
//      `assertScopedParent()` proved — or be listed in the ALLOW_LIST below.
//      An entry of that list is **not** a name that is trusted: it names the
//      **value** that is written **and** the **context** that makes it safe
//      (its `proof` — the authorization the entry relies on). The gate
//      checks that the proof is still there, so an entry whose context is
//      gone stops releasing its write.
//   2. The value that is written may never be the raw request value
//      (`input.parentId`, `body.parentId`, …): the checked one is the only
//      one that is known to live in the caller's workspace. That holds for
//      the value as it is written **and** for the local it comes from: a
//      local that mixes the raw value into the checked one
//      (`const parentId = input.parentId ?? checked.parentId`) carries the
//      raw value, whatever its name says. The taint is **transitive**: a
//      local that is derived from a tainted local is tainted as well, and a
//      read of `.parentId` from a name whose origin the gate cannot see (a
//      parameter, a module-level name, **or a local whose initializer the
//      gate cannot resolve** — a spread it cannot follow, a call whose
//      result it cannot see into, an interpolation it cannot read) is a raw
//      value, whatever the name of that receiver is. The gate resolves a
//      local it can see the origin of, and follows the taint there; a local
//      it cannot resolve holds a value of an origin nobody can show, so the
//      taint may hide in it — and the write is reported, not released.
//
// The gate follows the taint as far as it can see it, and it says where it
// stops. What it follows today:
//   - the **unresolvability** is transitive as well: a local that takes the
//     value of an unresolved local is unresolved itself (`const o =
//     { ...input }; const x = o;` leaves `x` just as opaque as `o`),
//   - the read of `.parentId` is seen in **every** form that names the
//     property directly: the plain read (`recv.parentId`), the optional chain
//     (`recv?.parentId`), the non-null assertion (`recv!.parentId`), the
//     computed member with the literal key (`recv["parentId"]`), the indexed
//     member (`arr[0].parentId`) and the result of a call
//     (`getInput().parentId`). A member whose key is **not** the literal and
//     a reflective read are among the holes below — they are not reads the
//     gate sees at all,
//   - the compound assignments (`x &&= y`, `x ||= y`, `x ??= y`, `x += y`, …)
//     are assignments the gate follows like every other — the value of the
//     local is the old one **or** the right-hand side, and the taint of the
//     old one survives with it.
//
// What it does **not** reach is a value that **mixes** an unresolved local
// with the proved one (`const parentId = o ?? checked.parentId`): the gate
// cannot see into `o`, so the raw value may hide in it — and the write is
// released all the same. That hole is listed below with the others.
//
// It is a **safety net over the tests**, not a proof. What it sees:
//
//   - the files under `src/`; a write outside that tree is invisible,
//   - the Prisma call forms `page.create | createMany | update | updateMany |
//     upsert` (with any receiver — `prisma.`, `tx.`, …) and the payloads
//     that carry a `Prisma.Page*Input` type,
//   - the three ways a parent is written: the `parentId` property, its
//     shorthand, and the Prisma relation form `parent: { connect: { id } }`,
//   - a payload that reaches the page through an **object spread**
//     (`data: { ...payload }`), as long as the spread payload is a literal
//     the gate can read.
//
// On the branch it finds **31** writes — the same 31 sites an independent
// TypeScript-parser inventory of `src/` finds.
//
// What it does **not** see — a write it cannot recognise is *not* covered by
// it, and the gate is no proof. The holes below are the ones that are
// **known today** — **eight** of them; the list is a safety net, not an
// enumeration: a new shape of write can open a new hole, and the list only
// grows when somebody measures one. `scripts/check-parent-scope.test.mjs`
// pins the shapes that are closed — and the holes that are known — so a hole
// cannot re-open unnoticed.
//
// The allow-list below is **precise**: every entry names the value it
// releases **and** the proof that makes that value safe, and the gate checks
// that the proof is still there. Two of the holes of the name-based list are
// closed by that — the callers of an allow-listed helper (the gate checks
// that no caller hands in a raw parent) and the payload whose parent a
// helper computes (a value the gate cannot attribute is no longer mistaken
// for the checked one) — so the list of known holes below is shorter than
// it was.
//
//   - a raw SQL write (`prisma.$executeRaw`); the repo has none,
//   - a member assignment (`data.parentId = …`), which is not an object
//     literal property,
//   - a write through a **computed receiver** (`prisma["page"].create`),
//     which the gate does not recognise as a page write at all,
//   - a payload that reaches the page through a spread of a value whose
//     contents the gate cannot see (`data: { ...payload }` with `payload`
//     coming in as a parameter),
//   - a value that **mixes** an unresolved local with the proved one
//     (`const parentId = o ?? checked.parentId`): the gate cannot see into
//     `o`, so the raw value may hide in it — and the write is released all
//     the same,
//   - a **computed member whose key is not the literal** (`input["parent" +
//     "Id"]`, `input[KEY]`): the gate sees a member read only when the key
//     is the literal `"parentId"`; a key it cannot fold is not a read it
//     sees, and the write is released all the same,
//   - a **reflective read** (`Reflect.get(input, "parentId")`): the gate sees
//     no `.parentId` read in it at all, and the write is released all the
//     same,
//   - the **proof** of an allow-list entry is matched as **text**: the gate
//     sees that the named authorization is called, not that it still checks
//     the workspace.
//
// The gate reads the source statically; it needs no database, no build and no
// running server. It is the mechanical counterpart of the tests in
// `src/**\/*parent-scope*.test.ts` — the tests pin the behaviour, the gate
// pins the *shape* of every write path it can see, including the ones no test
// covers.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The write paths where the parent and the row provably share one workspace
 * without a second lookup.
 *
 * Every entry names the file, the function, the written **value** **and** the
 * **proof** that makes the value safe — the authorization the entry relies on.
 * The gate exists because a comment alone was not enough, so an entry
 * without a reason is a bug in the gate; and because a *name* alone was not
 * enough either, the gate checks the proof: an entry whose proof is gone
 * stops releasing its write, and an entry whose value is no longer a proved
 * one stops releasing it as well.
 *
 *   - `proof`: the snippet that has to be in the function (or, with
 *     `scope: "file"`, in the file) for the entry to hold.
 *   - `scope`: where the proof is looked for — the function (default) or the
 *     whole file, for the two entries whose proof is in the caller.
 *   - `vouches`: the entry vouches that the value it releases is a raw read
 *     whose safety is the proof's business — the gate cannot see through the
 *     call that hands the value in.
 *   - `callers`: `"checked"` — every call of the function in the file must
 *     hand in no raw parent.
 */
const ALLOW_LIST = [
  {
    file: "src/server/actions/database.ts",
    fn: "createRowAction",
    value: "databasePageId",
    proof: ["authorizeDatabase(databasePageId)"],
    reason:
      "the parent is the database page `authorizeDatabase` just checked, and the row is written into that very page's workspace",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "duplicateDatabaseAction",
    value: "newPageId",
    proof: ["id: newPageId, workspaceId: auth.page.workspaceId"],
    reason:
      "the parent is the clone's own database page, created in this same transaction with the same workspace id",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "createRowFromTemplateAction",
    value: "databasePageId",
    proof: ["authorizeDatabase(databasePageId)"],
    reason: "the parent is the authorized database the row template belongs to",
  },
  {
    file: "src/server/actions/database.ts",
    fn: "importCsvAction",
    value: "databasePageId",
    proof: ["authorizeDatabase(databasePageId)"],
    reason: "the parent is the database the caller authorized",
  },
  {
    file: "src/server/actions/pages.ts",
    fn: "seedDatabaseStructure",
    value: "databasePageId",
    proof: ["id: databasePageId"],
    reason: "the parent is the database page the owner was read from",
  },
  {
    file: "src/server/actions/home-templates.ts",
    fn: "createGalleryTemplateAction",
    value: "database.id",
    proof: ["const database = await prisma.page.create", "workspaceId: input.workspaceId"],
    reason: "the parent is the database page this action just created in the same workspace",
  },
  {
    file: "src/server/actions/home-templates.ts",
    fn: "instantiateWorkspaceTemplateAction",
    value: "database.id",
    proof: ["database.workspaceId !== input.workspaceId"],
    reason:
      "the parent is the template's database page, whose workspace was checked against the request workspace",
  },
  {
    file: "src/server/actions/import.ts",
    fn: "importTrelloAction",
    value: "database.id",
    proof: ["const database = await tx.page.create", "workspaceId: input.workspaceId"],
    reason: "the parent is the database page this action just created in the same transaction",
  },
  {
    file: "src/server/actions/import-formats.ts",
    fn: "createPage",
    value: "input.parentId",
    proof: ["assertScopedParent({ workspaceId, parentId: input.parentId })"],
    scope: "file",
    vouches: true,
    callers: "checked",
    reason:
      "the importers resolve the parent with `assertScopedParent` before they call this helper — the value handed in is the checked one",
  },
  {
    file: "src/server/actions/move-workspace.ts",
    fn: "toPageCreateData",
    value: 'typeof page.parentId === "string" && page.parentId.length > 0 ? page.parentId : null',
    proof: ["validateMove(plan)"],
    scope: "file",
    vouches: true,
    callers: "checked",
    reason:
      "the move planner remaps the parent into the moved set (or drops it to null); `validateMove` rejects an orphaned parent",
  },
  {
    file: "src/app/api/cron/templates/route.ts",
    fn: "POST",
    value: "template.databasePageId",
    proof: ["id: template.databasePageId", "workspaceId: database.workspaceId"],
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

/**
 * A read of the `parentId` property — the value of the receiver it is read
 * from is the parent that is written.
 *
 * The gate has to see the read in **every** form the language allows. A form
 * it does not see is a read it cannot hold against the raw request value:
 *
 *   - the plain form (`recv.parentId`), the optional chain (`recv?.parentId`)
 *     and the non-null assertion (`recv!.parentId`) name a receiver the gate
 *     can look up — a local, or the result of the helper,
 *   - the parenthesised expression (`(...).parentId`) and the computed member
 *     (`recv["parentId"]`) name a receiver the gate can only guess,
 *   - the indexed member (`arr[0].parentId`) and the result of a call
 *     (`getInput().parentId`) name a receiver the gate cannot resolve at all.
 */
const PARENT_READS = [
  // `recv.parentId`, `recv?.parentId`, `recv!.parentId`
  {
    pattern:
      /([A-Za-z0-9_$][\w$]*(?:\s*!\s*\.\s*[\w$]+|\s*\.\s*[\w$]+)*)\s*(?:\?\.\s*|!\s*\.\s*|\.\s*)parentId\b/g,
    group: 1,
  },
  // `(...).parentId`
  { pattern: /(\([^()]*\))\s*\.\s*parentId\b/g, group: 1 },
  // `recv["parentId"]`
  {
    pattern: /((?:[A-Za-z0-9_$][\w$]*|\([^()]*\))?)\s*\[\s*(["'`])\s*parentId\s*\2\s*\]/g,
    group: 1,
  },
  // `arr[0].parentId`
  { pattern: /([A-Za-z0-9_$][\w$]*\s*\[[^\]]*\])\s*\.\s*parentId\b/g, group: 1 },
  // `getInput().parentId`
  {
    pattern:
      /([A-Za-z0-9_$][\w$]*(?:\s*\.\s*[A-Za-z0-9_$]+)*\s*\([^()]*\))\s*\.\s*parentId\b/g,
    group: 1,
  },
];

/**
 * Words that are never the name of a local — they are keywords, literals or
 * the words of the language, not a name the gate can follow.
 */
const RESERVED = new Set([
  "as",
  "await",
  "case",
  "catch",
  "class",
  "const",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "package",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

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
      // The backticks of a template literal stay visible: the gate cannot read
      // the interpolation, but it has to see that there is one — a local that
      // is built from a template literal may carry the raw request value.
      if (quote === "`") blank(i + 1, end - 1);
      else blank(i, end);
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
 * The initializer of a declaration — the text from `=` to the end of the
 * statement. The scan balances the brackets, so a `;` inside an object
 * literal does not end it, and it stops at the semicolon that closes the
 * statement (or at the start of the next statement in code without one).
 */
function initializer(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return masked.slice(start, i);
      depth -= 1;
      continue;
    }
    if (ch === ";" && depth === 0) return masked.slice(start, i);
    if (ch === "\n" && depth === 0) {
      const rest = masked.slice(i).trimStart();
      if (
        /^(?:const|let|var|return|await|if|for|while|switch|try|throw|export|import|function)\b/.test(
          rest,
        )
      ) {
        return masked.slice(start, i);
      }
    }
  }
  return masked.slice(start);
}

/* ------------------------------------------------------------------- the scope */

/** What a local holds: the checked parent id, a raw one, or nothing. */
const PROVED = "proved";
const TAINTED = "tainted";
const UNKNOWN = "unknown";

/**
 * The bindings of a destructuring pattern — `const { parentId: raw } = input`
 * binds `raw` to `input.parentId`.
 */
function parsePattern(pattern) {
  const bindings = [];
  const inner = pattern.trim();
  if (!inner.startsWith("{")) return bindings;
  for (const part of inner.slice(1, -1).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const colon = piece.indexOf(":");
    if (colon >= 0) {
      const key = piece.slice(0, colon).trim();
      const target = piece.slice(colon + 1).split("=")[0].trim();
      if (target) bindings.push({ name: target, key });
      continue;
    }
    const equals = piece.indexOf("=");
    const name = (equals >= 0 ? piece.slice(0, equals) : piece).trim();
    if (name) bindings.push({ name, key: name });
  }
  return bindings;
}

/**
 * The destructuring declarations of a body: where they are and what they bind.
 */
function destructurings(body) {
  const found = [];
  const pattern = /(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])\s*=/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      bindings: parsePattern(match[1]),
    });
  }
  return found;
}

/**
 * The names a body declares — the locals whose origin the gate can see. A
 * name that is **not** declared here (a parameter, a module-level name) has
 * an origin the gate cannot see: a read of `.parentId` from such a name is a
 * raw value, because nobody can show where it came from.
 */
function declaredNames(body) {
  const names = new Set();
  const declaration = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\b/g;
  let match;
  while ((match = declaration.exec(body)) !== null) names.add(match[1]);
  const loop = /for\s*\(\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\b/g;
  while ((match = loop.exec(body)) !== null) names.add(match[1]);
  for (const entry of destructurings(body)) {
    for (const binding of entry.bindings) names.add(binding.name);
  }
  return names;
}

/**
 * The assignments of a body, in the order they happen: `const x = …`, `x = …`
 * and the destructuring forms. Each event carries the value it assigns — for
 * a destructuring binding, the property it reads.
 *
 * Every event carries **two** texts: `init` is the masked one — the shape of
 * the initializer, with the strings and the comments blanked out — and `text`
 * is the original one. The gate reads the shape in the masked text (a string
 * is not a name it may follow) and the reads of the parent id in the original
 * text (a computed member, `recv["parentId"]`, is a read of it).
 */
function assignments(body, source) {
  const events = [];
  const destructured = destructurings(body);

  // A declaration with a type annotation (`const x: string | null = …`) is no
  // plain assignment — the pattern below would stop at the colon.
  const annotated = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*:[^=;]*=(?!=|>)/g;
  let match;
  while ((match = annotated.exec(body)) !== null) {
    const start = match.index + match[0].length;
    const init = initializer(body, start);
    events.push({
      index: start,
      name: match[1],
      init,
      text: source.slice(start, start + init.length),
      compound: false,
    });
  }

  // The compound assignments (`x &&= y`, `x ||= y`, `x ??= y`, `x += y`, …)
  // assign as well: the value of the local is the old one **or** the
  // right-hand side. A gate that does not see them keeps the state the local
  // had before — and a local that was proved stays proved.
  //
  // The operator group holds every compound assignment the language has: the
  // logical ones (`&&=`, `||=`, `??=`), the arithmetic ones (`+=`, `-=`, `*=`,
  // `/=`, `%=`, `**=`) and the bitwise ones (`&=`, `|=`, `^=`, `<<=`, `>>=`,
  // `>>>=`). The two-character forms come before the one-character ones, so
  // `**=` is not read as `*=` and `>>=` is not read as `>=` — and `||=` is not
  // read as `|=`: the two pipes come before the class that holds the single
  // pipe.
  const assign =
    /(?<![.\w$])([A-Za-z0-9_$]+)\s*((?:\*\*|>>>?|<<|\|\||&&|\?\?|[-+*/%&^|])?)=(?!=|>)/g;
  while ((match = assign.exec(body)) !== null) {
    const name = match[1];
    if (RESERVED.has(name)) continue;
    if (destructured.some((entry) => match.index >= entry.start && match.index < entry.end)) {
      continue;
    }
    const start = match.index + match[0].length;
    const init = initializer(body, start);
    events.push({
      index: start,
      name,
      init,
      text: source.slice(start, start + init.length),
      compound: match[2].length > 0,
    });
  }

  for (const entry of destructured) {
    const start = entry.end;
    const init = initializer(body, start);
    const text = source.slice(start, start + init.length);
    // `const { parentId } = await assertScopedParent(…)` takes the checked
    // value out of the helper's result — the binding holds it.
    const helper = new RegExp(`^\\s*await\\s+${HELPER}\\s*\\(`).test(init);
    for (const binding of entry.bindings) {
      events.push({
        index: start,
        name: binding.name,
        init: `${init}.${binding.key}`,
        text: `${text}.${binding.key}`,
        proved: helper,
        compound: false,
      });
    }
  }

  events.sort((a, b) => a.index - b.index);
  for (const event of events) {
    event.kind = null;
    event.direct = false;
    event.from = null;
    event.reason = null;
  }
  return events;
}

/**
 * The state of the locals of a function: the names that carry the parent the
 * helper proved, the names whose `.parentId` **is** the proved value, the
 * names that carry a **raw** parent, and the names whose value the gate
 * could **not** resolve.
 *
 * A name of the last group holds a value of an origin the gate cannot see —
 * an initializer it could not follow (a spread of a value it does not know, a
 * call whose result it cannot see into, a name it does not know). The taint
 * may hide in it, so a read of `.parentId` from such a name is a raw value.
 */
function stateOf(events) {
  const proved = new Set();
  const receivers = new Set();
  const tainted = new Map();
  const unknown = new Set();
  // The kind of the **last** assignment of every name: a name that is
  // resolved again after an unresolved assignment holds the resolved value.
  const kinds = new Map();
  for (const event of events) {
    let kind = event.kind;
    let detail = { direct: event.direct, from: event.from, reason: event.reason };
    // A compound assignment (`x &&= y`, `x ||= y`, `x ??= y`) leaves the old
    // value behind whenever its condition holds: the value of the local is the
    // old one **or** the right-hand side. The taint of the old value survives
    // with it — a local that carried the raw request value keeps carrying it.
    if (event.compound) {
      const previous = kinds.get(event.name);
      if (previous === TAINTED && kind !== TAINTED) {
        kind = TAINTED;
        detail = tainted.get(event.name) ?? detail;
      } else if (previous === UNKNOWN && kind !== TAINTED) {
        kind = UNKNOWN;
      }
    }
    kinds.set(event.name, kind);
    if (kind === "helper") {
      receivers.add(event.name);
      continue;
    }
    if (kind === TAINTED) {
      tainted.set(event.name, detail);
      continue;
    }
    if (kind === PROVED) proved.add(event.name);
  }
  for (const [name, kind] of kinds) {
    if (kind === UNKNOWN) unknown.add(name);
  }
  for (const name of unknown) proved.delete(name);
  for (const name of tainted.keys()) proved.delete(name);
  return { proved, receivers, tainted, unknown };
}

/**
 * The receivers of the `.parentId` reads in an expression — in the order they
 * appear in it. A receiver the gate cannot look up is one whose origin it
 * cannot see.
 */
function parentReceivers(value) {
  const found = [];
  for (const { pattern, group } of PARENT_READS) {
    for (const match of value.matchAll(pattern)) {
      found.push({ index: match.index, receiver: (match[group] ?? "").replace(/\s+/g, "") });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((item) => item.receiver);
}

/**
 * Whether a read of `.parentId` from the given receiver is a raw value.
 *
 * A receiver whose origin the gate cannot see — a parameter, a module-level
 * name — is raw: nobody can show where the value came from. The same holds
 * for a **local whose initializer the gate could not resolve**: the gate does
 * not see where that local comes from, so the taint may hide in it and a
 * read of `.parentId` from it is raw as well. A receiver that is a local the
 * gate **can** resolve is not raw on its own: the gate sees where that local
 * comes from, and the taint follows it there. The helper's own result is the
 * proved value.
 *
 * A receiver that is not a plain name — a member chain, a parenthesised
 * expression, an index, the result of a call — is one the gate cannot look up
 * at all: what it holds is beyond the gate's reach.
 */
function rawReceiver(receiver, state, locals) {
  if (!/^[A-Za-z0-9_$]+$/.test(receiver)) return true;
  if (state.receivers.has(receiver)) return false;
  if (state.tainted.has(receiver)) return true;
  if (state.unknown.has(receiver)) return true;
  if (locals.has(receiver)) return false;
  return true;
}

/**
 * Whether the name at `index` stands on its own — `checked.parentId` names
 * `checked`, not `parentId`. The dots of a **spread** (`...input`) are no
 * property access: the name behind them is a name of its own, and the gate
 * has to see it — a spread of a value the gate cannot see into is a local
 * whose origin the gate cannot resolve.
 */
function standsAlone(value, index) {
  const before = value.slice(0, index);
  if (before.endsWith("...")) return true;
  const last = before.at(-1);
  return !last || !/[.\w$]/.test(last);
}

/**
 * Whether the name at `index` is the key of an object literal — `{ parentId:
 * value }` names the property `parentId`, not a value of its own.
 */
function isObjectKey(value, index) {
  const before = value.slice(0, index).trimEnd();
  if (!before.endsWith("{") && !before.endsWith(",")) return false;
  const after = value.slice(index).replace(/^[A-Za-z0-9_$]+/, "").trimStart();
  return after.startsWith(":");
}

/**
 * The names an expression mentions on its own — a property name is not a
 * name of its own (`checked.parentId` mentions `checked`, not `parentId`).
 */
function ownNames(value) {
  const names = [];
  for (const match of value.matchAll(/[A-Za-z0-9_$]+/g)) {
    if (isObjectKey(value, match.index)) continue;
    if (standsAlone(value, match.index)) names.push(match[0]);
  }
  return names;
}

/**
 * Whether the expression mentions one of the given names — a name that stands
 * on its own.
 */
function mentionsName(value, names) {
  for (const name of names) {
    const pattern = new RegExp(`\\b${name}\\b`, "g");
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (standsAlone(value, match.index)) return true;
    }
  }
  return false;
}

/**
 * Whether the expression is a call — the value it holds is the **result** of
 * that call, not its arguments. A helper that returns a page id hands in no
 * raw parent, whatever its arguments mention.
 */
function isCall(value) {
  return /^\s*(?:await\s+)?[A-Za-z0-9_$.]+\s*\(/.test(value);
}

/**
 * Whether the expression mentions a name whose origin the gate cannot see.
 */
function unprovedName(value, state, locals) {
  if (isCall(value)) return false;
  for (const name of ownNames(value)) {
    if (RESERVED.has(name)) continue;
    if (locals.has(name)) continue;
    if (state.proved.has(name)) continue;
    if (state.receivers.has(name)) continue;
    if (state.tainted.has(name)) continue;
    return true;
  }
  return false;
}

/**
 * The name an initializer is nothing but — the value of the local is the value
 * of that name and nothing else (`const x = o;`).
 */
function plainName(init) {
  const text = init.trim();
  if (!/^[A-Za-z0-9_$]+$/.test(text)) return null;
  if (RESERVED.has(text)) return null;
  return text;
}

/**
 * The names a spread takes its value from — `{ ...input }` spreads `input`.
 */
function spreadSources(value) {
  const sources = [];
  for (const match of value.matchAll(/\.\.\.\s*([A-Za-z0-9_$]+)/g)) sources.push(match[1]);
  return sources;
}

/**
 * The tainted local the expression mentions — the raw value hides in it. A
 * plain name only counts when it stands on its own: `checked.parentId` is the
 * checked field, `parentId` is the local.
 */
function taintedName(value, tainted) {
  for (const name of tainted.keys()) {
    if (mentionsName(value, [name])) return name;
  }
  return null;
}

/** Whether the expression mentions one of the proved names. */
function mentionsProved(value, state) {
  if (mentionsName(value, state.proved)) return true;
  for (const name of state.receivers) {
    // A read of the parent id in every form that names the property directly:
    // the plain
    // one, the optional chain and the non-null assertion.
    if (new RegExp(`\\b${name}\\s*(?:\\?\\.|!\\s*\\.|\\.)\\s*parentId\\b`).test(value)) return true;
    // A spread of the helper's result carries its fields — `{ ...checked }`
    // holds the checked parent.
    if (new RegExp(`\\.\\.\\.\\s*${name}\\b`).test(value)) return true;
  }
  return false;
}

/**
 * Whether the initializer is the **call** of a function — the value of the
 * local is then what the call returns, not what it is given.
 */
function callResult(init) {
  return /^\s*(?:await\s+)?[A-Za-z0-9_$]+(?:\s*\.\s*[A-Za-z0-9_$]+)*\s*\(/.test(init);
}

/**
 * Whether the initializer hides an interpolation. The masker blanks the
 * interpolation of a template literal — the gate cannot read it — so a local
 * that is built from one may carry the raw request value. The value of a
 * call is what the call returns, not its arguments: a template literal in the
 * arguments of a call does not flow into the local — and a local that holds
 * the result of a call is one the gate cannot resolve anyway.
 */
function hidesInterpolation(init) {
  if (callResult(init)) return false;
  return init.includes("`");
}

/**
 * What an assignment hands to its local.
 *
 * The taint is **transitive**: a local that is derived from a tainted local
 * carries the raw value as well, and the derivation does not have to be a
 * `.parentId` read (`const parentId = raw ?? checked.parentId`).
 *
 * A local the gate cannot resolve is tainted as well: the gate does not see
 * where that local comes from, so the raw value may hide in it.
 */
function classify(init, text, state, locals) {
  // A call hands in the result of that call — the gate cannot attribute it to
  // the proved value, whatever the arguments mention. A local that is handed
  // such a value loses the state it had: the parent it carried is not the
  // one that is written any more.
  if (isCall(init)) return { kind: UNKNOWN, direct: false, from: null, reason: null };
  const from = taintedName(init, state.tainted);
  if (from) return { kind: TAINTED, direct: false, from, reason: null };
  // The unresolvability is **transitive**: a local that takes the value of an
  // unresolved local is unresolved itself — the gate cannot see where that
  // value comes from, so the taint may hide in it. `const o = { ...input };`
  // leaves `o` opaque, and `const x = o;` leaves `x` just as opaque.
  const taken = plainName(init);
  if (taken && state.unknown.has(taken)) {
    return { kind: UNKNOWN, direct: false, from: null, reason: null };
  }
  // A template literal hides its interpolation: the gate cannot see what the
  // local is built from, so the raw request value may hide in it. The verdict
  // comes before the reads: the interpolation is what the gate cannot read,
  // whatever it holds.
  if (hidesInterpolation(init)) {
    return { kind: TAINTED, direct: false, from: null, reason: "hidden" };
  }
  for (const receiver of parentReceivers(text)) {
    if (rawReceiver(receiver, state, locals)) {
      // A receiver the gate cannot see into: a parameter, a module-level name
      // or a local whose initializer it could not resolve.
      if (state.unknown.has(receiver)) {
        return { kind: TAINTED, direct: false, from: receiver, reason: "unresolved" };
      }
      return { kind: TAINTED, direct: true, from: null, reason: null };
    }
  }
  // A spread of a local the gate could not resolve hands over a value of an
  // origin the gate cannot see.
  for (const source of spreadSources(init)) {
    if (state.unknown.has(source)) {
      return { kind: UNKNOWN, direct: false, from: null, reason: null };
    }
  }
  if (unprovedName(init, state, locals)) {
    return { kind: UNKNOWN, direct: false, from: null, reason: null };
  }
  if (mentionsProved(init, state)) return { kind: PROVED, direct: false, from: null, reason: null };
  return { kind: null, direct: false, from: null, reason: null };
}

/**
 * The scope of a function: the locals it declares and what they hold.
 *
 * The classification runs until it settles, because the taint is transitive:
 * a local that is derived from a tainted local is tainted as well, however
 * many steps away the raw value is. The same holds for the unresolvability:
 * a local that takes the value of an unresolved local is unresolved itself —
 * and every step of such a chain needs a round of its own.
 *
 * `body` is the masked text of the function, `source` the original one.
 */
function analyseScope(body, source) {
  const locals = declaredNames(body);
  const events = assignments(body, source);
  const helper = new RegExp(`^\\s*await\\s+${HELPER}\\s*\\(`);
  for (const event of events) {
    if (event.proved) event.kind = PROVED;
    else if (helper.test(event.init)) event.kind = "helper";
  }
  for (let round = 0; round < 40; round += 1) {
    let changed = false;
    const state = stateOf(events);
    for (const event of events) {
      if (event.kind === "helper" || event.proved) continue;
      const verdict = classify(event.init, event.text, state, locals);
      if (
        verdict.kind !== event.kind ||
        verdict.direct !== event.direct ||
        verdict.from !== event.from ||
        verdict.reason !== event.reason
      ) {
        event.kind = verdict.kind;
        event.direct = verdict.direct;
        event.from = verdict.from;
        event.reason = verdict.reason;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { locals, state: stateOf(events) };
}

/**
 * What the written value is: a raw parent, the checked one, or a value the
 * gate cannot attribute.
 */
function valueVerdict(value, state, locals) {
  const from = taintedName(value, state.tainted);
  if (from) {
    const taint = state.tainted.get(from);
    const hint =
      taint.reason === "unresolved"
        ? `the local \`${from}\` takes the value from \`${taint.from}\`, whose origin the gate cannot see`
        : taint.reason === "hidden"
          ? `the local \`${from}\` is built from a template literal whose interpolation the gate cannot read`
          : taint.direct
            ? `the local \`${from}\` is assigned from the raw request value`
            : `the local \`${from}\` carries the raw request value from \`${taint.from}\``;
    return { verdict: "raw", hint: ` (${hint})` };
  }
  for (const receiver of parentReceivers(value)) {
    if (rawReceiver(receiver, state, locals)) {
      return {
        verdict: "raw",
        hint: ` (the value is read from \`${receiver}\`, whose origin the gate cannot see)`,
      };
    }
  }
  if (mentionsProved(value, state)) return { verdict: "guarded", hint: "" };
  return { verdict: "unguarded", hint: "" };
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
 *
 * The name may reach the write as a plain reference (`data: payload`) or
 * through an **object spread** (`data: { ...payload }`). The spread carries
 * its own dots, so a plain lookbehind never matched it — and a write that
 * arrives through a spread was not counted at all.
 */
function usedInPageWrite(masked, name) {
  const pattern = new RegExp(`(?<![.\\w$])${name}\\b|\\.\\.\\.${name}\\b`, "g");
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
const scanned = [];

for (const path of collectFiles(root)) {
  const source = readFileSync(path, "utf8");
  const masked = mask(source);
  const functions = namedFunctions(masked);
  // The allow-list and every diagnostic use POSIX separators. `relative()`
  // returns `\` on Windows, so normalise it here: the gate must make the same
  // decision on every platform.
  const file = relative(".", path).replaceAll("\\", "/");
  scanned.push({ file, source, masked, functions });

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
    const origin = fn ? source.slice(fn.start, fn.end) : source;
    const scope = analyseScope(body, origin);

    const entry = ALLOW_LIST.find(
      (item) => item.file === file && item.fn === fnName && item.value === value,
    );
    // The written value is the raw request value whenever it carries one —
    // directly (`input.parentId`) or through a local that carries it
    // (`const parentId = input.parentId ?? checked.parentId`).
    const verdict = valueVerdict(value, scope.state, scope.locals);
    let kind = verdict.verdict;
    let reported = false;

    if (entry) {
      usedEntries.add(entry);
      // The entry hangs on the value **and** on the context that makes it
      // safe: the proof has to be there, or the entry releases nothing.
      const missing = missingProof(entry, fn, masked);
      if (missing) {
        problems.push({
          file,
          line: lineOf(source, index),
          text:
            `the allow-list entry ${fnName}() requires \`${missing}\` in the ` +
            `${entry.scope === "file" ? "file" : "function"} — the parent is no longer proved there`,
        });
        kind = "unguarded";
        reported = true;
      } else if (kind === "raw" && !entry.vouches) {
        problems.push({
          file,
          line: lineOf(source, index),
          text:
            `the allow-list entry ${fnName}() does not hold any more — ` +
            `\`${value}\` is not a proved value${verdict.hint}`,
        });
        kind = "unguarded";
        reported = true;
      } else {
        kind = "allow-listed";
      }
    } else if (value === "null") {
      kind = "root";
    }

    checked.push({ file, line: lineOf(source, index), fn: fnName, value, verdict: kind });

    if (kind === "guarded" || kind === "allow-listed" || kind === "root") continue;
    if (reported) continue;
    if (kind === "raw") {
      problems.push({
        file,
        line: lineOf(source, index),
        text: `parentId: ${value} — write the value ${HELPER}() returned, not the raw request value${verdict.hint}`,
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

/**
 * Whether an allow-list entry belongs to the tree the gate scans. The
 * allow-list describes the repository; a run over a fixture tree (the gate's
 * own regression test) has no entries of its own, and the repository's must
 * not be reported as stale there.
 */
function inScope(entry, root) {
  const inside = relative(root, entry.file);
  if (!inside || inside.startsWith("..")) return false;
  return existsSync(join(root, inside));
}

/**
 * The text a proof is matched against: the whitespace is collapsed, so a
 * proof survives a reformat of the code around it.
 */
function normalize(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*([,)\]}])/g, "$1")
    .replace(/([([])\s*/g, "$1")
    .replace(/,\s*([)\]}])/g, "$1");
}

/**
 * The proof an allow-list entry needs — the snippet that has to be there for
 * the entry to hold. The snippet is matched as **text**, with the whitespace
 * collapsed on both sides.
 */
function missingProof(entry, fn, masked) {
  const scope = entry.scope === "file" || !fn ? masked : masked.slice(fn.start, fn.end);
  const text = normalize(scope);
  for (const snippet of entry.proof) {
    if (!text.includes(normalize(snippet))) return snippet;
  }
  return null;
}

/**
 * The calls of an allow-listed helper that hand in a raw parent. The callers
 * are what prove the value the helper writes, so a caller that hands in the
 * raw request value has to turn the gate red.
 *
 * `masked` and `source` are the two texts of the file — the shape is read in
 * the masked one, the reads of the parent id in the original one.
 */
function rawCallSites(masked, source, functions, fnName) {
  const sites = [];
  const pattern = new RegExp(`\\b${fnName}\\s*\\(`, "g");
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    const before = masked.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s*$/.test(before)) continue; // the declaration itself
    const paren = masked.indexOf("(", match.index);
    const end = matchingClose(masked, paren);
    if (end < 0) continue;
    const argument = source.slice(paren + 1, end);
    const fn = enclosingFunction(functions, match.index);
    const body = fn ? masked.slice(fn.start, fn.end) : masked;
    const origin = fn ? source.slice(fn.start, fn.end) : source;
    const scope = analyseScope(body, origin);
    for (const receiver of parentReceivers(argument)) {
      if (rawReceiver(receiver, scope.state, scope.locals)) {
        sites.push({ index: match.index, receiver });
        break;
      }
    }
  }
  return sites;
}

for (const entry of ALLOW_LIST) {
  if (!inScope(entry, root)) continue;
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
  if (!entry.proof || entry.proof.length === 0) {
    problems.push({
      file: entry.file,
      line: 0,
      text: `allow-list entry ${entry.fn}() has no proof — every entry must name the context that makes the value safe`,
    });
  }
}

// The allow-listed helpers: every caller must hand in no raw parent.
for (const entry of ALLOW_LIST) {
  if (entry.callers !== "checked") continue;
  for (const file of scanned) {
    for (const site of rawCallSites(file.masked, file.source, file.functions, entry.fn)) {
      problems.push({
        file: file.file,
        line: lineOf(file.source, site.index),
        text:
          `the allow-list entry ${entry.fn}() is handed a raw parent ` +
          `(\`${site.receiver}.parentId\`) — the callers must pass the checked value`,
      });
    }
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
