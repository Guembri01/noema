// Design-system conformance report.
//
// Finds places that bypass the tokens declared in `src/app/tokens.css`:
// raw hex colours, arbitrary z-index/duration/radius/shadow values, and the
// legacy Tailwind palette (`text-red-600`, `bg-blue-500/10`, …).
//
// Usage:
//   node scripts/check-design-system.mjs           # report (exit 0)
//   node scripts/check-design-system.mjs --check    # fail if worse than BASELINE
//
// Not every hit is a bug: user-chosen colours (tag allow-lists, cover gradients
// stored as data) legitimately carry hex. Read the offender list, don't just
// chase the number to zero.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Worst tolerated totals. Lower these as the design system lands; never raise. */
// All at zero: the whole app (171 files) now paints exclusively through the
// token layer. Any new hit fails `npm run check:design`, which is the point —
// the ratchet only turns one way.
const BASELINE = {
  "raw hex": 0,
  "arbitrary z-index": 0,
  "arbitrary duration": 0,
  "arbitrary radius": 0,
  "ad-hoc shadow": 0,
  "legacy palette": 0,
};

const RULES = [
  ["raw hex", /#[0-9a-fA-F]{3,8}\b/],
  ["arbitrary z-index", /z-\[\d+\]|zIndex:\s*\d\d+/],
  ["arbitrary duration", /duration-\[|\btransition[-:]?all\b/],
  ["arbitrary radius", /rounded-\[/],
  ["ad-hoc shadow", /shadow-\[\d/],
  [
    "legacy palette",
    /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/,
  ],
];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
  }
})("src/components");
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (/page\.tsx$/.test(entry)) files.push(path);
  }
})("src/app");

const counts = Object.fromEntries(RULES.map(([name]) => [name, 0]));
const offenders = new Map();

for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // skip comments
    for (const [name, re] of RULES) {
      if (re.test(line)) {
        counts[name] += 1;
        if (!offenders.has(file)) offenders.set(file, new Set());
        offenders.get(file).add(name);
      }
    }
  });
}

const check = process.argv.includes("--check");
const worse = [];
console.log(`Design-system report — ${files.length} files scanned\n`);
for (const [name, total] of Object.entries(counts)) {
  const limit = BASELINE[name];
  const mark = total > limit ? "FAIL" : "ok  ";
  console.log(`  ${mark} ${String(total).padStart(4)} ${name}${total > limit ? ` (baseline ${limit})` : ""}`);
  if (total > limit) worse.push(name);
}

const worst = [...offenders.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 20);
if (worst.length > 0) {
  console.log("\n  files furthest from the system (rules matched):");
  for (const [file, set] of worst) {
    console.log(`    ${String(set.size).padStart(2)}  ${file.replace(/\\/g, "/")}  [${[...set].join(", ")}]`);
  }
}
console.log(`\n  ${offenders.size} file(s) with at least one hit.`);

if (check && worse.length > 0) {
  console.error(`\nDESIGN DRIFT — ${worse.join(", ")} exceeded the baseline.`);
  process.exit(1);
}
process.exit(0);
