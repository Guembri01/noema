// Motion audit for the Noema design system.
//
// The motion vocabulary lives in `src/app/tokens.css` (`--dur-*`, `--ease-*`,
// the `.u-*` utilities) and is described in `docs/DESIGN_SYSTEM.md` §6 and
// `docs/FRONTEND_PLAN.md` §19. This script finds places in `src/components/**`
// and `src/app/**` that bypass it, and prints what to use instead.
//
// Usage:
//   node scripts/check-motion.mjs           # report (exit 0)
//   node scripts/check-motion.mjs --check    # fail if a HARD rule is above BASELINE
//
// Hard rules = drift (fail `--check`). Soft rules = "smells": layout-animating
// transitions, a drag surface that forgets `.u-no-transition`, or keyframes that
// escape tokens.css. Soft rules are reported but never fail.
//
// Not every hit is a bug: the `@theme` animation shorthands and the legacy
// `.notion-*` styles in globals.css legitimately carry a raw keyword today, and
// a countdown bar is data-driven. Read the offender list, don't chase zero.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Worst tolerated totals for the HARD rules. Lower these as the motion pass
 * lands; never raise them. Soft rules are not gated.
 */
const BASELINE = {
  "transition: all": 1,
  "ad-hoc duration": 6,
  "inline animation duration": 1,
  "literal easing keyword": 8,
  "motion-reduce shortens instead of skips": 0,
};

/* -------------------------------------------------------------------------- */
/* Hard rules                                                                  */
/* -------------------------------------------------------------------------- */

/** `transition: all` / `transition-all`, in CSS or a Tailwind class. */
const transitionAll = (line) =>
  /\btransition-all\b/.test(line) || /\btransition\s*:\s*all\b/.test(line);

/**
 * A raw time inside a transition/animation, or a Tailwind `duration-<number>`.
 * `0ms` / `0.01ms` are the reduced-motion "skip" sentinel (globals.css),
 * not a duration choice, so they are ignored.
 */
const adHocDuration = (line) => {
  if (/\bduration-(?!\[)\d/.test(line)) return true;
  if (!/\b(?:transition|animation)\b/.test(line)) return false;
  for (const m of line.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
    if (m[1] === "0" || m[1] === "0.01") continue; // reduced-motion neutraliser
    return true;
  }
  return false;
};

/** `animationDuration: "1500ms"` / `transitionDuration: 200` in an inline style. */
const inlineAnimationDuration = (line) =>
  /(?:animationDuration|transitionDuration)\s*:\s*[^,}]*?(?:\d+\s*(?:ms|s)\b|\$\{[^}]*\}\s*(?:ms|s)\b)/.test(
    line,
  );

/**
 * A literal CSS easing keyword — `linear`, `ease`, `ease-in`, `ease-out`,
 * `ease-in-out`, `step-start`/`step-end` — instead of `var(--ease-*)`.
 * Token-safe: `--ease-smooth`, `var(--ease-in-out-soft)` and `ease-[var(--ease-x)]`
 * are not matches, and `linear` never matches inside `linear-gradient`.
 */
const literalEasing = (line) =>
  /(?<![\w-])(?:ease-in-out|ease-in|ease-out|step-start|step-end|ease|linear)(?![\w-])/.test(
    line,
  );

/**
 * A `motion-reduce:` guard that only shortens/slows the motion instead of
 * skipping it. `transition-none` / `animate-none` and "jump to the final
 * state" utilities (`opacity-100`, `translate-y-0`) are fine.
 */
const motionReduceShortens = (line) => {
  if (!line.includes("motion-reduce:")) return false;
  for (const m of line.matchAll(/motion-reduce:([^\s"'`]+)/g)) {
    const utility = m[1].replace(/^(?:[a-z0-9-]+:)+/, ""); // drop variants
    if (/^(?:duration-|delay-)/.test(utility)) return true;
    if (/^\[animation-duration/.test(utility)) return true;
    if (/^transition-/.test(utility) && utility !== "transition-none") return true;
    if (/^animate-/.test(utility) && utility !== "animate-none") return true;
  }
  return false;
};

const HARD_RULES = [
  {
    name: "transition: all",
    advice: "name the properties, or use `.u-colors` / `.u-surface` with var(--dur-1)",
    test: transitionAll,
  },
  {
    name: "ad-hoc duration",
    advice: "use var(--dur-1)…var(--dur-4) (or `duration-[var(--dur-2)]`), never a raw ms/s",
    test: adHocDuration,
  },
  {
    name: "inline animation duration",
    advice: "use var(--dur-1)…var(--dur-4); a data-driven window belongs in a local CSS var",
    test: inlineAnimationDuration,
  },
  {
    name: "literal easing keyword",
    advice: "use var(--ease-smooth) / --ease-in-out-soft / --ease-spring (add a token if one is missing)",
    test: literalEasing,
  },
  {
    name: "motion-reduce shortens instead of skips",
    advice: "skip it: `motion-reduce:animate-none` / `motion-reduce:transition-none`, or jump to the final state",
    test: motionReduceShortens,
  },
];

/* -------------------------------------------------------------------------- */
/* Soft rules (reported, never gated)                                          */
/* -------------------------------------------------------------------------- */

/** Animating `width`/`height`/`top`/`left` instead of transform/opacity. */
const layoutAnimating = (line) =>
  /(?<![\w-])(?:width|height|top|left)\s+(?:var\(--(?:dur|ease)|[0-9.]+m?s)\b/.test(line) ||
  /\btransition\s*:\s*[^;"'`]*(?<![\w-])(?:width|height|top|left)(?![\w-])/.test(line) ||
  /transition-\[[^\]]*\b(?:width|height|top|left)\b/.test(line);

/**
 * File-level: a drag/resize surface (pointermove + drag vocabulary) with no
 * `.u-no-transition` anywhere. `.u-no-transition` is what keeps a 1:1 drag from
 * lagging the cursor (design system §6 / plan §19.6).
 */
const dragWithoutFreeze = (text, file) => {
  if (!/pointermove/i.test(text)) return false;
  if (!/drag|resiz|col-resize|grab/i.test(text)) return false;
  if (/u-no-transition/.test(text)) return false;
  return true;
};

/** `@keyframes` declared outside tokens.css (the vocabulary file). */
const keyframesOutsideTokens = (line, file) =>
  /@keyframes\b/.test(line) && !file.endsWith("tokens.css");

const SOFT_RULES = [
  {
    name: "animating layout (width/height/top/left)",
    advice: "animate transform/opacity instead",
    perLine: true,
    test: layoutAnimating,
  },
  {
    name: "drag/resize surface without .u-no-transition",
    advice: "add `.u-no-transition` while dragging so it tracks the cursor 1:1",
    perLine: false,
    test: dragWithoutFreeze,
  },
  {
    name: "@keyframes outside tokens.css",
    advice: "move it next to the vocabulary in tokens.css and reference it via a token",
    perLine: true,
    test: keyframesOutsideTokens,
  },
];

/* -------------------------------------------------------------------------- */
/* Scan                                                                        */
/* -------------------------------------------------------------------------- */

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const INCLUDE = /\.(?:[jt]sx?|css)$/;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry).replace(/\\/g, "/");
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (INCLUDE.test(entry) && !TEST_FILE.test(entry) && !path.endsWith("tokens.css"))
      files.push(path);
  }
})("src/components");
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry).replace(/\\/g, "/");
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (INCLUDE.test(entry) && !TEST_FILE.test(entry) && !path.endsWith("tokens.css"))
      files.push(path);
  }
})("src/app");

const scan = (rules) =>
  rules.map((rule) => ({ ...rule, count: 0, offenders: [] }));

const hard = scan(HARD_RULES);
const soft = scan(SOFT_RULES);
const allRules = [...hard, ...soft];
const byName = new Map(allRules.map((r) => [r.name, r]));

const record = (rule, file, line, snippet) => {
  rule.count += 1;
  rule.offenders.push({ file, line, snippet: snippet.trim() });
};

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const isDragSurface = dragWithoutFreeze(raw, file);

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // skip comment lines
    for (const rule of allRules) {
      if (rule.perLine === false) continue;
      if (rule.test(line, file)) record(rule, file, i + 1, line);
    }
  });

  if (isDragSurface) {
    const rule = byName.get("drag/resize surface without .u-no-transition");
    const hit = lines.findIndex((l) => /pointermove/i.test(l));
    record(rule, file, hit >= 0 ? hit + 1 : 1, lines[hit >= 0 ? hit : 0] ?? "");
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const check = process.argv.includes("--check");
const failed = [];

const printRule = (rule, isHard) => {
  const limit = isHard ? BASELINE[rule.name] : null;
  const over = isHard && rule.count > limit;
  const mark = isHard ? (over ? "FAIL" : "ok  ") : "note";
  const suffix = isHard ? ` (baseline ${limit})` : "";
  console.log(
    `  ${mark} ${String(rule.count).padStart(4)}  ${rule.name}${suffix}\n         → ${rule.advice}`,
  );
  const shown = rule.offenders.slice(0, 40);
  for (const o of shown) {
    console.log(`           ${o.file}:${o.line}  ${o.snippet}`);
  }
  if (rule.offenders.length > shown.length) {
    console.log(`           … ${rule.offenders.length - shown.length} more`);
  }
  if (over) failed.push(rule.name);
};

console.log(`Motion audit — ${files.length} files scanned (tokens.css excluded)\n`);
console.log("  HARD — drift (fails --check above the baseline)");
for (const rule of hard) printRule(rule, true);
console.log("\n  SOFT — smells (reported, never gated)");
for (const rule of soft) printRule(rule, false);

const hardFiles = new Set(
  hard.flatMap((r) => r.offenders.map((o) => o.file)),
);
console.log(
  `\n  ${hardFiles.size} file(s) with at least one hard hit; ${failed.length} hard rule(s) over baseline.`,
);

if (check && failed.length > 0) {
  console.error(`\nMOTION DRIFT — ${failed.join(", ")} exceeded the baseline.`);
  process.exit(1);
}
process.exit(0);
