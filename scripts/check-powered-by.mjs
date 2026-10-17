#!/usr/bin/env node
/**
 * Gate: the response must not advertise the framework (B78).
 *
 * Next.js answers every HTML response with `X-Powered-By: Next.js` unless
 * `poweredByHeader` is off — and the default is **on**: `poweredByHeader:
 * true` is part of Next's own default configuration
 * (next/dist/server/config-shared.js), and the header is set by the server
 * itself when it sends the HTML (next/dist/server/send-payload.js).
 *
 * The security-header map cannot cover that. `headers()` in `next.config.ts`
 * only **adds** headers to a response; it cannot switch off one the server
 * sets on its own. So the switch has to be in the Next configuration, and
 * this gate is what keeps it there.
 *
 *   node scripts/check-powered-by.mjs            # the gate
 *   node scripts/check-powered-by.mjs <file>     # another config file
 *
 * What it accepts: the property `poweredByHeader` with the literal `false`,
 * written as code. A missing line, `true`, a variable and a string all fail
 * — the gate is fail-closed, because every one of them leaves the header in
 * place. A mention in a comment or inside a string is not the setting and
 * does not count.
 *
 * Limits of the source scan — it is a scanner, not a parser:
 *   · it does not evaluate the config: a value that *computes* to `false`
 *     (a constant that holds `false`) is not accepted — spell the literal
 *     out;
 *   · it does not check that the property sits in the exported config
 *     object — `next.config.ts` has exactly one, and
 *     `src/lib/security-headers.test.ts` asserts the *evaluated* value of
 *     the config, which is the second layer;
 *   · a regular expression literal in the config is not recognised as one,
 *     so a `/poweredByHeader/` in the file would be read as code. The config
 *     has no such literal.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The config the gate checks when it is not told otherwise. */
export const DEFAULT_CONFIG = join(ROOT, "next.config.ts");

/** The property the gate looks for. */
const PROPERTY = "poweredByHeader";

/** The only value that switches the header off. */
const REQUIRED = "false";

/**
 * Classify every character of the source as `code`, `comment` or `string`.
 *
 * The gate only accepts a match that is **code**: a property mentioned in a
 * comment or inside a string literal is not the setting. The quotes of a
 * string stay `code`, so a quoted key (`"poweredByHeader": false`) is still
 * recognised as a key.
 *
 * @param {string} source
 * @returns {("code" | "comment" | "string")[]}
 */
function classify(source) {
  const kind = new Array(source.length).fill("code");
  const mark = (from, to, what) => {
    for (let k = from; k < to && k < source.length; k += 1) kind[k] = what;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // A line comment.
    if (ch === "/" && source[i + 1] === "/") {
      const stop = source.indexOf("\n", i);
      const end = stop === -1 ? source.length : stop;
      mark(i, end, "comment");
      i = end;
      continue;
    }
    // A block comment.
    if (ch === "/" && source[i + 1] === "*") {
      const stop = source.indexOf("*/", i + 2);
      const end = stop === -1 ? source.length : stop + 2;
      mark(i, end, "comment");
      i = end;
      continue;
    }
    // A string literal: the content is marked, the quotes are not.
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j += 1;
      }
      mark(i + 1, Math.min(j, source.length), "string");
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return kind;
}

/**
 * Every `poweredByHeader` property assignment in the source.
 *
 * @param {string} source
 * @returns {{ line: number, value: string }[]} one entry per assignment, in
 *   the order they appear. `value` is the text the property carries; it is
 *   the literal `false` only when the switch is really off.
 */
export function findPoweredByHeader(source) {
  const kind = classify(source);
  const found = [];
  const pattern = new RegExp(PROPERTY, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = source[start - 1] ?? "";
    const after = source[end] ?? "";
    // The name has to stand on its own: `myPoweredByHeader` is another
    // property.
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;
    // A quoted key is a key too — but only when the literal is exactly the
    // name (`"poweredByHeader"`), not a longer string that contains it.
    const quoted =
      kind[start] === "string" && (before === '"' || before === "'") && after === before;
    // Anything else in a comment or in a string is not the setting.
    if (kind[start] !== "code" && !quoted) continue;

    // A property key: the name has to be followed by a colon.
    let cursor = quoted ? end + 1 : end;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== ":") continue;
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;

    // The value: the literal `false`, nothing else. A quoted `"false"` is a
    // string, not the switch, so it is read as a value of its own.
    const word = /^[A-Za-z0-9_$]+/.exec(source.slice(cursor))?.[0] ?? "";
    const text = source.slice(cursor, cursor + 60).split(/[,}\n]/)[0].trim();
    found.push({
      line: source.slice(0, start).split("\n").length,
      value: word === REQUIRED ? REQUIRED : text || "<empty>",
      off: word === REQUIRED,
    });
  }
  return found;
}

/**
 * Check one config file.
 *
 * @param {string} file
 * @returns {{ ok: boolean, message: string }} the verdict and the line the
 *   gate prints.
 */
export function checkConfig(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, message: `cannot read ${file}: ${error.message}` };
  }
  const found = findPoweredByHeader(source);
  if (found.length === 0) {
    return {
      ok: false,
      message: `${file} does not set \`${PROPERTY}\``,
    };
  }
  const wrong = found.filter((hit) => !hit.off);
  if (wrong.length > 0) {
    return {
      ok: false,
      message: wrong
        .map((hit) => `${file}:${hit.line} sets \`${PROPERTY}: ${hit.value}\`, it must be \`${REQUIRED}\``)
        .join("; "),
    };
  }
  return {
    ok: true,
    message: `${file}:${found[0].line} sets \`${PROPERTY}: ${REQUIRED}\``,
  };
}

const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CONFIG;
const verdict = checkConfig(file);
if (!verdict.ok) {
  console.error(`check-powered-by: FAILED — ${verdict.message}`);
  if (verdict.message.includes("does not set")) {
    console.error(
      "  Next.js sends `X-Powered-By: Next.js` on every HTML response while the",
    );
    console.error(
      "  switch is on (it is on by default), and the header map cannot remove it:",
    );
    console.error("  `headers()` only adds headers. Add `poweredByHeader: false`.");
  }
  process.exit(1);
}
console.log(`check-powered-by: OK — ${verdict.message}`);
