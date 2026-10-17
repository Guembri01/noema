#!/usr/bin/env node
/**
 * Frontend consistency audit — the "bad parts" list, measured and *classified*.
 *
 * The first pass of this script over-reported: it counted the dev-only gallery as
 * user-facing, treated "no loading.tsx on /login" the same as a blank page in the
 * app, and missed multi-line imports so nearly a thousand live helpers looked
 * dead. A list like that is worse than none.
 *
 * So each rule now says which bucket a finding is in:
 *   DEFECT         — a user can hit this (broken a11y, untranslated copy, drift)
 *   INCONSISTENCY  — both work, but they differ, so the product feels uneven
 *   DEBT           — a maintainer pays for it; no user-visible effect today
 *   INFO           — recorded, not a problem (layout constants, dev-only files)
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const all = walk(SRC);
const tsx = all.filter((f) => f.endsWith(".tsx") && !/\.test\./.test(f));
const ts = all.filter((f) => f.endsWith(".ts") && !/\.test\./.test(f));
const css = all.filter((f) => f.endsWith(".css"));
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
/** Dev-only surfaces are not user-facing; they are reported separately. */
const isDevOnly = (f) => /^src\/app\/dev\//.test(rel(f)) || /design-gallery/.test(rel(f));
const stripComments = (t) =>
  // Blank the comment *bodies* rather than deleting them, so every newline survives and
  // the line numbers in the report point at the real file. Deleting the spans (the
  // previous behaviour) shifted every line after a comment, which is why findings were
  // reported a few lines off — close enough to look right, far enough to waste time.
  t
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (comment) => comment.replace(/[^\n]/g, " "));

/**
 * Local class constants, resolved per file.
 *
 * Many components keep their control classes in a constant
 * (`const button = "focus-ring …"`) and apply them with `className={button}`.
 * Without this map the rules below saw `className={button}` and reported a
 * perfectly styled button as missing its focus ring — a false positive that cost
 * a real fix in one file and a bogus finding in another.
 */
function classNameSources(source) {
  const resolved = new Map();
  const expressions = new Map();
  // Three shapes, because real components use all of them:
  //   const BUTTON_BASE = "…";                  (also `export const`, and the
  //                                             string may sit on the next line)
  //   const classes = cn(BUTTON_BASE, size);
  //   const classes = buttonClasses({ … });     (a local builder — see below)
  for (const match of source.matchAll(/^\s*(?:export\s+)?const (\w+)\s*=\s*([^;]{3,600});/gm)) {
    const name = match[1];
    const value = match[2].trim();
    if (value.length >= 3 && value.startsWith('"') && value.endsWith('"')) resolved.set(name, value.slice(1, -1));
    else if (value.length >= 3 && !value.startsWith("`")) expressions.set(name, value);
  }
  // Follow a local builder's *return* expressions only. Reading its whole body
  // would pull in classes the element never receives and could mask a real
  // finding, which is the one thing this checker must never do.
  for (const match of source.matchAll(/function (\w+)\([\s\S]{0,600}?\)\s*(?::[^{]{0,120})?\{([\s\S]{0,2000}?)\n\}/g)) {
    if (resolved.has(match[1])) continue;
    const returned = [...match[2].matchAll(/return ([^;]{3,600});/g)].map((r) => r[1]).join(" ");
    if (returned) expressions.set(match[1], returned);
  }
  for (const [name, expression] of expressions) {
    if (!resolved.has(name)) resolved.set(name, { expression });
  }
  return resolved;
}

/** Resolve one identifier to the class strings it contributes (bounded depth). */
function classValues(name, sources, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(name)) return [];
  seen.add(name);
  const entry = sources.get(name);
  if (entry === undefined) return [];
  if (typeof entry === "string") return [entry];
  return [...entry.expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
    .map((match) => match[1])
    .flatMap((next) => classValues(next, sources, depth + 1, seen));
}

/** Expand `className={NAME}` to the constant's value so the rules can read it. */
function expandClassNames(line, sources) {
  // Any known class constant mentioned inside the braces counts — a bare
  // \`className={CONST}\` and a composed \`className={cn(CONST, tone)}\` are the
  // same thing to the rules below, and the composed form is the common one.
  return line.replace(/className=\{([^}]*)\}/g, (whole, expression) => {
    // Both halves of a composed expression matter: the literal classes
    // (\`cn("focus-ring", CLOSE_CLASS)\`) and the resolved constants. Taking only
    // the constants once dropped a ring that was present as a literal.
    const literals = [...expression.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    const values = [
      ...literals,
      ...[...expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
        .flatMap((match) => classValues(match[1], sources, 0, new Set())),
    ];
    return values.length > 0 ? `className="${values.join(" ")}"` : whole;
  });
}

const findings = [];
const rule = (bucket, title, why) => {
  const entry = { bucket, title, why, hits: [], files: new Map(), info: [] };
  findings.push(entry);
  return {
    hit: (file, line, detail = "") => {
      entry.hits.push({ file: rel(file), line, detail: String(detail).slice(0, 100) });
      entry.files.set(rel(file), (entry.files.get(rel(file)) ?? 0) + 1);
    },
    note: (text) => entry.info.push(text),
  };
};

// ── DEFECT: untranslated user-facing copy ───────────────────────────────────
{
  const g = rule("DEFECT", "User-facing copy that is not translated", "fr/es/de/ar users read English");
  const attr = /(placeholder|aria-label|alt)\s*=\s*"([A-Za-z][^"{}]{2,60})"/g;
  // The same attribute written as a JSX expression — `aria-label={cond ? "Pick an icon"
  // : "Pick a cover"}` — is invisible to the pattern above, and that blind spot let 11
  // English labels sit in the tree while this rule reported zero. (One of them was a
  // page's own cover hint; another was the cover dialog's title.)
  const exprAttr = /(placeholder|aria-label|alt|title)=\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  for (const file of tsx) {
    if (isDevOnly(file)) continue;
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(attr)) g.hit(file, i + 1, `${m[1]}="${m[2]}"`);
        for (const m of line.matchAll(exprAttr)) {
          const expression = m[2];
          // Translated copy is fine, and so is a value that comes from data (a user's
          // page title, a variable) — only a bare English literal is a defect.
          if (/\bt\(/.test(expression)) continue;
          const literal = expression.match(/"([A-Z][A-Za-z][^"]{2,70})"/);
          if (literal) g.hit(file, i + 1, `${m[1]}={… ${literal[1]} …}`);
        }
      });
  }
}

// ── DEFECT: icon-only controls with no accessible name ──────────────────────
{
  const g = rule("DEFECT", "Icon-only controls with no accessible name", "screen readers announce nothing");
  for (const file of tsx) {
    if (isDevOnly(file)) continue;
    const raw = stripComments(readFileSync(file, "utf8"));
    const sources = classNameSources(raw);
    const text = raw.split("\n").map((l) => expandClassNames(l, sources)).join("\n");
    for (const block of text.matchAll(/<button[\s\S]{0,500}?<\/button>/g)) {
      const body = block[0];
      const named = /aria-label=|aria-labelledby=|\bsr-only\b/.test(body);
      const visibleText = body.replace(/<[^>]+>/g, " ").replace(/\{[^}]*\}/g, " ").trim();
      if (!named && visibleText.length < 2) {
        g.hit(file, text.slice(0, block.index).split("\n").length, body.split("\n")[0].trim());
      }
    }
  }
}

// ── INCONSISTENCY: type/spacing outside the scale (layout constants are fine) ─
{
  const g = rule("INCONSISTENCY", "Type and spacing outside the token scale", "two elements meant to match do not");
  const typey = /\btext-\[[0-9.]+(px|rem)\]|\b(?:gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb)-\[[0-9.]+(px|rem)\]/g;
  const layout = /\b(?:w|h|max-w|min-w|max-h|min-h)-\[[0-9.]+(px|rem|ch|vw|vh)\]|\[[0-9.]+(?:ch|vw|vh)\]/g;
  for (const file of [...tsx, ...css]) {
    if (isDevOnly(file)) continue;
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(typey)) g.hit(file, i + 1, m[0]);
        for (const m of line.matchAll(layout)) g.note(`${rel(file)}:${i + 1} ${m[0]}`);
      });
  }
}

// ── INCONSISTENCY: custom-styled buttons without the shared focus ring ───────
{
  const g = rule("INCONSISTENCY", "Custom buttons without the shared focus ring", "focus looks different control to control");
  for (const file of tsx) {
    if (isDevOnly(file)) continue;
    const raw = stripComments(readFileSync(file, "utf8"));
    const sources = classNameSources(raw);
    const text = raw.split("\n").map((l) => expandClassNames(l, sources)).join("\n");
    for (const m of text.matchAll(/<button[\s\S]{0,400}?>/g)) {
      const tag = m[0];
      if (/className=/.test(tag) && !/focus-ring|u-interactive|focus-visible|outline-none/.test(tag)) {
        g.hit(file, text.slice(0, m.index).split("\n").length, tag.split("\n")[0].trim());
      }
    }
  }
}

// ── DEBT: legacy style system still in globals.css ──────────────────────────
{
  const g = rule("DEBT", "Legacy `.notion-*` / `.noema-*` rules", "a second style system the tokens must out-specify");
  const file = join(SRC, "app", "globals.css");
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*\.(notion|noema)-[a-z0-9-]+\s*[,{]/.test(line)) g.hit(file, i + 1, line.trim());
    });
}

// ── DEBT: hand-rolled anchored popovers (modals are fine) ────────────────────
{
  const g = rule("DEBT", "Anchored popovers built by hand instead of the shared placement engine", "they drift and get clipped");
  for (const file of tsx) {
    if (isDevOnly(file)) continue;
    const raw = stripComments(readFileSync(file, "utf8"));
    const sources = classNameSources(raw);
    const text = raw.split("\n").map((l) => expandClassNames(l, sources)).join("\n");
    text.split("\n").forEach((line, i) => {
      // `position: absolute/fixed` + a panel class is an anchored popup; a plain
      // `role="dialog"` modal (centred) is a legitimate different thing.
      if (/position:\s*"(fixed|absolute)"/.test(line) || /surface-raised[^\n]*absolute|absolute[^\n]*surface-raised/.test(line)) {
        g.hit(file, i + 1, line.trim());
      }
    });
  }
}

// ── DEBT: routes with no loading skeleton ───────────────────────────────────
{
  const g = rule("DEBT", "Routes with no `loading.tsx`", "navigation shows a blank frame instead of a skeleton");
  for (const page of walk(join(SRC, "app")).filter((f) => f.endsWith("page.tsx"))) {
    const dir = dirname(page);
    if (readdirSync(dir).includes("loading.tsx")) continue;
    // Trivial/auth routes get a note rather than a finding: a skeleton there
    // would flash more than it helps.
    const trivial = isDevOnly(page) || /login|signup|invite|(^|\/)app\//.test(rel(page));
    if (trivial) g.note(`no skeleton on ${rel(dir)}`);
    else g.hit(page, 1, rel(dir));
  }
}

// ── DEBT: duplicated helpers/maps ──────────────────────────────────────────
{
  const g = rule("DEBT", "Duplicated helpers and colour catalogues", "the same thing implemented several times drifts");
  for (const file of ts) {
    const text = stripComments(readFileSync(file, "utf8"));
    text.split("\n").forEach((line, i) => {
      const m = line.match(/^export const ([A-Z_]*(?:COLORS|TONES|HUES|SWATCH|TINTS|INK|HUE)[A-Z_]*)\s*[:=]/);
      if (m) g.hit(file, i + 1, m[1]);
    });
  }

  // Multi-line aware helper scan (the first pass counted a helper as dead when it
  // was imported on a wrapped line).
  const names = new Map();
  for (const file of [...ts, ...tsx]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
        if (name) names.set(name, (names.get(name) ?? 0) + 1);
      }
    }
    for (const m of text.matchAll(/import\s+(?:type\s+)?(\w+)\s+from/g)) names.set(m[1], (names.get(m[1]) ?? 0) + 1);
  }
  g.note("exported helpers that are never imported elsewhere: not measured (a helper used only inside its own module is not dead, so any count would mislead)");
}

// ── DEBT: static inline styles ──────────────────────────────────────────────
{
  const g = rule("DEBT", "Inline `style=` carrying static design values", "bypasses the tokens and cannot be re-themed");
  const literal = /style=\{\{[^}]*?(?:color|background|borderColor|fontSize)\s*:\s*"(?!#|inherit|currentColor)/g;
  for (const file of tsx) {
    if (isDevOnly(file)) continue;
    const raw = stripComments(readFileSync(file, "utf8"));
    const sources = classNameSources(raw);
    const text = raw.split("\n").map((l) => expandClassNames(l, sources)).join("\n");
    text.split("\n").forEach((line, i) => {
      for (const _ of line.matchAll(literal)) g.hit(file, i + 1, line.trim());
    });
  }
}

// ─────────────────────────────────────────────────────────────── report
// `--files`: one line per file with its total, so a coordinator can hand out
// work by file ownership rather than by rule.
if (process.argv.includes("--files")) {
  const perFile = new Map();
  for (const f of findings) {
    for (const hit of f.hits) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
  }
  for (const [file, count] of [...perFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(count).padStart(4) + "  " + file);
  }
  console.log("\n" + perFile.size + " file(s) with findings");
  process.exit(0);
}

const order = { DEFECT: 0, INCONSISTENCY: 1, DEBT: 2, INFO: 3 };
const pad = (s, n) => s.padEnd(n);
console.log("Frontend consistency audit (classified)\n");
console.log(`scanned ${tsx.length} tsx · ${ts.length} ts · ${css.length} css\n`);

for (const bucket of ["DEFECT", "INCONSISTENCY", "DEBT"]) {
  const inBucket = findings.filter((f) => f.bucket === bucket).sort((a, b) => b.hits.length - a.hits.length);
  if (inBucket.length === 0) continue;
  console.log(`── ${bucket} ─────────────────────────────────────────────`);
  for (const f of inBucket) {
    const count = f.hits.length;
    console.log(`${pad(count === 0 ? "ok" : String(count), 5)}  ${f.title}`);
    console.log(`       ${f.why}`);
    if (count > 0) {
      const worst = [...f.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      console.log(`       worst: ${worst.map(([file, n]) => `${file} (${n})`).join(", ")}`);
      for (const hit of f.hits.slice(0, 3)) console.log(`         ${hit.file}:${hit.line}  ${hit.detail}`);
    }
    for (const line of f.info.slice(0, 2)) console.log(`       note: ${line}`);
    console.log("");
  }
}

console.log("── recorded, not counted as problems ─────────────────────");
for (const f of findings) {
  if (f.bucket !== "INFO" && f.info.length === 0) continue;
  for (const line of f.info) console.log(`  ${line}`);
}
const defects = findings.filter((f) => f.bucket === "DEFECT").reduce((n, f) => n + f.hits.length, 0);
const inconsistency = findings.filter((f) => f.bucket === "INCONSISTENCY").reduce((n, f) => n + f.hits.length, 0);
const debt = findings.filter((f) => f.bucket === "DEBT").reduce((n, f) => n + f.hits.length, 0);
console.log(`\nDEFECT ${defects} · INCONSISTENCY ${inconsistency} · DEBT ${debt}`);
