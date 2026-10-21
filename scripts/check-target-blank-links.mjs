#!/usr/bin/env node
/**
 * Gate: a link that opens a new tab carries `rel="noreferrer noopener"`.
 *
 *   node scripts/check-target-blank-links.mjs            # the repository
 *   node scripts/check-target-blank-links.mjs <dir>      # another tree
 *
 * Why this exists:
 *
 *   A link that opens a new browsing context hands the opened document a
 *   `window.opener` unless the link says `noopener`. The opened page can then
 *   navigate the tab that opened it — the reverse-tabnabbing trick. The token
 *   `noreferrer` cuts the opener *and* the `Referer` header, so the two
 *   together are the strongest form of the attribute, and they are what this
 *   tree writes for every such link.
 *
 *   The tree was not consistent. Four places wrote only `noreferrer` (B72) and
 *   two more did the same — one of them behind a conditional `target`, which a
 *   grep for `target="_blank"` never sees. A convention that only some files
 *   follow is not a control, so the rule lives in a gate: the tree is scanned
 *   and a link that does not carry both tokens fails the build.
 *
 * What the gate reads:
 *
 *   - the **whole** tree below the root: every `.ts`, `.tsx`, `.js`, `.jsx`,
 *     `.mjs`, `.cjs` and `.html` file, the build output and the VCS metadata
 *     aside;
 *   - **test files are skipped** (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, …):
 *     the HTML strings in them are fixtures of the paste sanitiser, not links
 *     the application renders. `scripts/check-target-blank-links.test.mjs`
 *     pins that exclusion, so it cannot grow unnoticed.
 *
 * How a link is read:
 *
 *   - the source is scanned for opening tags; a tag ends at the first `>`
 *     that is neither inside a quoted value nor inside a `{…}` expression, so
 *     an arrow function in an attribute does not cut the tag short;
 *   - a tag opens a new browsing context when its `target` attribute is the
 *     literal `_blank` **or** an expression that mentions the literal
 *     `_blank` (`target={open ? "_blank" : undefined}`) — the conditional form
 *     is the one a grep misses;
 *   - the `rel` of that tag has to carry the tokens `noopener` **and**
 *     `noreferrer`. The order of the tokens does not matter (`rel` is a set),
 *     and a third token (`nofollow`) is allowed.
 *
 * What the gate does **not** see — it is a text scan, not a parser:
 *
 *   - a `rel` written through a name (`rel={REL}`) has no literal to read;
 *     the gate cannot prove the tokens are there and fails the link — it
 *     fails closed, so such a link cannot become a silent bypass;
 *   - an expression that picks a weaker `rel` in one of its branches
 *     (`rel={cond ? "noreferrer noopener" : "noreferrer"}`) is read as the
 *     union of the literals it can see;
 *   - a link built at runtime (`document.createElement("a")`) is invisible.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(process.argv[2] ?? REPO_ROOT);

/** The directories that hold no source of the application. */
const SKIP_DIRS = new Set([".git", ".next", "node_modules", "out", "dist", "build", "coverage"]);

/** The file extensions the gate reads. */
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html"]);

/** The tokens the `rel` of such a link has to carry. */
const REQUIRED = ["noopener", "noreferrer"];

/** A test file holds fixtures, not links the application renders. */
const isTestFile = (name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name);

/** Every source file of the tree, the build output and the VCS metadata aside. */
function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      // The Rust build output is not source, and it is big.
      if (entry.name === "target" && basename(dir) === "src-tauri") continue;
      collectFiles(full, out);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name)) && !isTestFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The index after the `}` that closes the `{` at `start` — the quotes inside
 * the expression are respected, so a `}` inside a string does not close it.
 */
function matchBrace(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * The opening tags of a source: the tag name, its attribute blob and where the
 * blob starts. A tag ends at the first `>` that is neither inside a quoted
 * value nor inside a `{…}` expression — so `onClick={() => go()}` does not cut
 * the tag short.
 */
function scanTags(source) {
  const tags = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    const name = /^[A-Za-z][A-Za-z0-9._:-]*/.exec(source.slice(lt + 1, lt + 64));
    if (!name) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1 + name[0].length;
    let depth = 0;
    let quote = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote !== null) {
        if (ch === "\\") j += 2;
        else {
          if (ch === quote) quote = null;
          j += 1;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        j += 1;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        j += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        j += 1;
        continue;
      }
      if (ch === ">" && depth === 0) break;
      j += 1;
    }
    if (j >= source.length) break;
    tags.push({
      name: name[0],
      blob: source.slice(lt + 1 + name[0].length, j),
      blobStart: lt + 1 + name[0].length,
      lineStarts,
    });
    i = j + 1;
  }
  return tags;
}

/**
 * The attributes of a tag: the name, the value and whether the value is an
 * expression (`{…}`) or a literal.
 */
function parseAttributes(blob) {
  const attributes = [];
  let i = 0;
  while (i < blob.length) {
    while (i < blob.length && /\s/.test(blob[i])) i += 1;
    if (i >= blob.length) break;
    const start = i;
    while (i < blob.length && !/[\s=]/.test(blob[i])) i += 1;
    const name = blob.slice(start, i);
    while (i < blob.length && /\s/.test(blob[i])) i += 1;
    if (blob[i] !== "=") {
      attributes.push({ name, value: null, expression: false, start });
      continue;
    }
    i += 1;
    while (i < blob.length && /\s/.test(blob[i])) i += 1;
    const ch = blob[i];
    if (ch === '"' || ch === "'") {
      const end = blob.indexOf(ch, i + 1);
      if (end === -1) {
        attributes.push({ name, value: blob.slice(i + 1), expression: false, start });
        break;
      }
      attributes.push({ name, value: blob.slice(i + 1, end), expression: false, start });
      i = end + 1;
    } else if (ch === "{") {
      const end = matchBrace(blob, i);
      attributes.push({ name, value: blob.slice(i + 1, end - 1), expression: true, start });
      i = end;
    } else {
      const valueStart = i;
      while (i < blob.length && !/[\s>]/.test(blob[i])) i += 1;
      attributes.push({ name, value: blob.slice(valueStart, i), expression: false, start });
    }
  }
  return attributes;
}

/** Does the `target` attribute open a new browsing context? */
function opensBlank(target) {
  if (!target || target.value === null) return false;
  if (target.expression) return /["']_blank["']/.test(target.value);
  return target.value.trim() === "_blank";
}

/** The tokens of a `rel` attribute — the literals of an expression are unioned. */
function relTokens(rel) {
  const tokens = new Set();
  if (!rel || rel.value === null) return tokens;
  const literals = rel.expression
    ? [...rel.value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "")
    : [rel.value];
  for (const literal of literals) {
    for (const token of literal.split(/\s+/)) {
      if (token) tokens.add(token.toLowerCase());
    }
  }
  return tokens;
}

/** The line an offset of the source is on. */
function lineAt(lineStarts, offset) {
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
  return line + 1;
}

/** The index after the `)` that closes the `(` at `start`. */
function matchParen(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a call's argument list on top-level commas. */
function splitArguments(text) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/**
 * `window.open` calls that open a new tab. The feature string is the third
 * argument; the second argument names `_blank`. The gate reads the same two
 * tokens as a `rel`, because `window.open` is the one new-tab path a JSX tag
 * scanner cannot see.
 */
function scanWindowOpen(source, lineStarts) {
  const calls = [];
  const needle = "window.open(";
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    const start = index + needle.length;
    const end = matchParen(source, start - 1);
    if (end === -1) break;
    const args = splitArguments(source.slice(start, end));
    const target = args[1] ?? "";
    if (!/["'`]_blank["'`]/.test(target)) {
      index = end + 1;
      continue;
    }
    const features = args[2] ?? "";
    const tokens = new Set((features.match(/[A-Za-z]+/g) ?? []).map((token) => token.toLowerCase()));
    calls.push({
      line: lineAt(lineStarts, index),
      missing: REQUIRED.filter((token) => !tokens.has(token)),
      features,
    });
    index = end + 1;
  }
  return calls;
}

const files = collectFiles(ROOT);
const violations = [];
let links = 0;
let windowOpenCalls = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  for (const call of scanWindowOpen(source, lineStarts)) {
    windowOpenCalls += 1;
    if (call.missing.length === 0) continue;
    violations.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      line: call.line,
      missing: call.missing,
      rel: null,
      kind: "window.open",
      features: call.features,
    });
  }
  for (const tag of scanTags(source)) {
    const attributes = parseAttributes(tag.blob);
    const target = attributes.find((attribute) => attribute.name === "target");
    if (!opensBlank(target)) continue;
    links += 1;
    const rel = attributes.find((attribute) => attribute.name === "rel");
    const tokens = relTokens(rel);
    const missing = REQUIRED.filter((token) => !tokens.has(token));
    if (missing.length === 0) continue;
    // The report names the line of the offending `rel` — the tag itself, when
    // the link carries no `rel` at all.
    const offset = rel ? tag.blobStart + rel.start : tag.blobStart;
    violations.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      line: lineAt(tag.lineStarts, offset),
      missing,
      rel,
    });
  }
}

const relText = (violation) => {
  if (violation.kind === "window.open") {
    return `window.open(..., ${violation.features || "no features"}) is missing ${violation.missing.join(" and ")}`;
  }
  const rel = violation.rel;
  if (!rel) return "no rel attribute";
  const value = rel.expression ? `{${rel.value}}` : `"${rel.value}"`;
  return `rel=${value} is missing ${violation.missing.join(" and ")}`;
};

if (violations.length > 0) {
  console.error(
    `FAIL  every link that opens a new tab must carry rel="noreferrer noopener" (${violations.length} violation(s))`,
  );
  for (const violation of violations) {
    console.error(`      ${violation.file}:${violation.line}  ${relText(violation)}`);
  }
  console.error("");
  console.error("A link without `noopener` hands the opened document a `window.opener`,");
  console.error("and the opened document can navigate the tab that opened it.");
  console.error("");
  console.error('Fix: write rel="noreferrer noopener" on the link.');
  process.exit(1);
}

console.log(
  `PASS  ${links} link(s) open a new tab and every one of them carries noreferrer noopener, ` +
    `${windowOpenCalls} window.open call(s) carry noopener,noreferrer (${files.length} file(s) scanned)`,
);
