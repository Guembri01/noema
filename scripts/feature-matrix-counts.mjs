// Recomputes the FEATURE_MATRIX scoreboard from the feature rows.
// Usage: node scripts/feature-matrix-counts.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../docs/FEATURE_MATRIX.md", import.meta.url);
const text = readFileSync(path, "utf8");
const start = text.indexOf("<!-- BEGIN FEATURES -->");
const end = text.indexOf("<!-- END FEATURES -->");
if (start === -1 || end === -1 || end < start) {
  console.error("Feature markers not found.");
  process.exit(1);
}

const body = text.slice(start, end);
const rows = [];
let area = "Uncategorised";
for (const line of body.split("\n")) {
  const heading = /^##\s+(.+)$/.exec(line);
  if (heading) {
    area = heading[1].replace(/\s*\(.*$/, "").trim();
    continue;
  }
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map((cell) => cell.trim());
  if (cells.length < 5) continue;
  if (/^-+$/.test(cells[1]) || cells[1] === "Feature") continue;
  const status = cells[3];
  if (!["✅", "🟡", "🧭", "⛔"].includes(status)) continue;
  rows.push({ area, status });
}

const areas = [];
for (const row of rows) {
  if (!areas.includes(row.area)) areas.push(row.area);
}
const tally = (area) => {
  const scoped = rows.filter((row) => row.area === area);
  return {
    implemented: scoped.filter((row) => row.status === "✅").length,
    partial: scoped.filter((row) => row.status === "🟡").length,
    planned: scoped.filter((row) => row.status === "🧭").length,
    out: scoped.filter((row) => row.status === "⛔").length,
    total: scoped.length,
  };
};

const lines = [];
lines.push("| Area | ✅ Implemented | 🟡 Partial | 🧭 Planned | ⛔ Out of scope | Total |");
lines.push("| --- | --- | --- | --- | --- | --- |");
const sum = { implemented: 0, partial: 0, planned: 0, out: 0, total: 0 };
for (const area of areas) {
  const counts = tally(area);
  sum.implemented += counts.implemented;
  sum.partial += counts.partial;
  sum.planned += counts.planned;
  sum.out += counts.out;
  sum.total += counts.total;
  lines.push(
    `| ${area} | ${counts.implemented} | ${counts.partial} | ${counts.planned} | ${counts.out} | ${counts.total} |`,
  );
}
lines.push(
  `| **Total** | **${sum.implemented}** | **${sum.partial}** | **${sum.planned}** | **${sum.out}** | **${sum.total}** |`,
);

console.log(lines.join("\n"));

if (process.argv.includes("--write")) {
  const tableStart = text.indexOf("| Area |", end);
  const tableEnd = text.indexOf("\n\n", tableStart);
  if (tableStart === -1 || tableEnd === -1) {
    console.error("Scoreboard table not found.");
    process.exit(1);
  }
  const updated =
    text.slice(0, tableStart) + lines.join("\n") + text.slice(tableEnd);
  writeFileSync(path, updated);
  console.log("\nScoreboard updated.");
}
