// Generates docs/MISSING_FEATURES.md from the FEATURE_MATRIX.
//
//   node scripts/feature-gaps.mjs            # print the summary
//   node scripts/feature-gaps.mjs --write    # (re)write docs/MISSING_FEATURES.md
//
import { readFileSync, writeFileSync } from "node:fs";

const matrixPath = new URL("../docs/FEATURE_MATRIX.md", import.meta.url);
const outputPath = new URL("../docs/MISSING_FEATURES.md", import.meta.url);
const text = readFileSync(matrixPath, "utf8");

const start = text.indexOf("<!-- BEGIN FEATURES -->");
const end = text.indexOf("<!-- END FEATURES -->");
if (start === -1 || end === -1) {
  console.error("Feature markers not found in FEATURE_MATRIX.md");
  process.exit(1);
}

const STATUS = { "✅": "done", "🟡": "partial", "🧭": "planned", "⛔": "out" };
const rows = [];
let area = "Uncategorised";
for (const line of text.slice(start, end).split("\n")) {
  const heading = /^##\s+(.+)$/.exec(line);
  if (heading) {
    area = heading[1].replace(/\s*\(.*$/, "").trim();
    continue;
  }
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map((cell) => cell.trim());
  if (cells.length < 5) continue;
  if (/^-+$/.test(cells[1]) || cells[1] === "Feature") continue;
  const status = STATUS[cells[3]];
  if (!status) continue;
  rows.push({ area, feature: cells[1], what: cells[2], status, notes: cells[4] });
}

const areas = [...new Set(rows.map((row) => row.area))];
const count = (status, scoped = rows) => scoped.filter((row) => row.status === status).length;
const total = rows.length;

/** The shortlist a maintainer should read first (kept in sync by hand). */
const PRIORITY = [
  ["Filter tree UI", "The AND/OR filter tree already evaluates; the nested group builder UI is not exposed.", "3. Databases"],
  ["Conditional formatting", "ColorRule is modelled and evaluated; the rule-authoring and render path are partial.", "3. Databases"],
  ["Form view", "No ViewType.FORM yet; the builder + public submit path are spec'd but unwired.", "3. Databases"],
  ["Linked database views", "The read-only node exists; view identity and per-instance overrides are missing.", "3. Databases"],
  ["Synced blocks", "Mirror one block's content in many places with a canonical source marker.", "1. Editor & blocks"],
  ["Suggestions mode", "Propose edits for approval with a diff overlay.", "7. Collaboration"],
  ["Comment depth", "Server-side depth validation, block anchors and dispatch scoping on page threads.", "7. Collaboration"],
  ["Notification inbox & preferences", "Per-user delivery preferences, digests and PageFollow dispatch are missing.", "7. Collaboration"],
  ["Pagination everywhere", "Databases, tickets and audit lists load bounded sets; cursor pagination is pending.", "17. Data model & platform"],
  ["Audit log UI", "Activity is recorded per ticket/page; a workspace-wide, filterable audit view is missing.", "8. Sharing & permissions"],
  ["Object storage & backups", "Uploads and scheduled backups to S3-compatible storage.", "17. Data model & platform"],
  ["SAML SSO", "OIDC is implemented and tested; SAML needs a provider-agnostic strategy layer.", "8. Sharing & permissions"],
  ["Undo/redo (global)", "App-wide undo beyond the editor's local history.", "16. Navigation & UX"],
  ["Self-hosting & auth", "Packaging, provider-agnostic sign-in and documented deployment remain.", "17. Data model & platform"],
];

const pad = (value, width) => String(value).padEnd(width);
const lines = [];
lines.push("# Noema — remaining work");
lines.push("");
lines.push("> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.");
lines.push("");
lines.push(
  `**Scoreboard:** ${total} feature rows — ${count("done")} implemented · ${count("partial")} partial · ${count("planned")} planned · ${count("out")} deliberately out of scope.`,
);
lines.push("");
lines.push(`This file lists the **${count("partial") + count("planned")}** rows that are not finished, area by area, plus ${count("out")} intentional divergences.`);
lines.push("");
lines.push("## Read this first — highest-leverage gaps");
lines.push("");
lines.push("| # | Gap | Why it matters | Area |");
lines.push("| --- | --- | --- | --- |");
PRIORITY.forEach(([gap, why, where], index) => {
  lines.push(`| ${index + 1} | **${gap}** | ${why} | ${where} |`);
});
lines.push("");
lines.push("## By area");
lines.push("");

for (const name of areas) {
  const scoped = rows.filter((row) => row.area === name);
  const partial = scoped.filter((row) => row.status === "partial");
  const planned = scoped.filter((row) => row.status === "planned");
  const out = scoped.filter((row) => row.status === "out");
  if (partial.length + planned.length + out.length === 0) continue;
  lines.push(`### ${name}`);
  lines.push("");
  lines.push(
    `${count("done", scoped)} done · ${partial.length} partial · ${planned.length} planned${out.length ? ` · ${out.length} out of scope` : ""}`,
  );
  lines.push("");
  lines.push("| Feature | What it should do | Status | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of [...partial, ...planned, ...out]) {
    const emoji = row.status === "partial" ? "🟡" : row.status === "planned" ? "🧭" : "⛔";
    lines.push(`| ${row.feature} | ${row.what} | ${emoji} | ${row.notes} |`);
  }
  lines.push("");
}

if (process.argv.includes("--write")) {
  writeFileSync(outputPath, `${lines.join("\n")}\n`);
  console.log(`Wrote docs/MISSING_FEATURES.md (${lines.length} lines).`);
} else {
  console.log(`${total} rows: ${count("done")} done, ${count("partial")} partial, ${count("planned")} planned, ${count("out")} out.`);
  for (const name of areas) {
    const scoped = rows.filter((row) => row.area === name);
    const missing = scoped.filter((row) => row.status !== "done" && row.status !== "out").length;
    console.log(`  ${pad(name, 42)} ${pad(count("done", scoped), 4)} done   ${missing} missing`);
  }
  console.log("\nRun with --write to regenerate docs/MISSING_FEATURES.md");
}
