#!/usr/bin/env node
/**
 * Builds `docs/Noema-features.pdf` — a printable feature sheet, with the
 * screenshots embedded, for people who would rather read a document than a
 * repository.
 *
 * Everything in the sheet is *derived*, so it cannot drift away from the code:
 *
 *   - the feature bullets are the README's own feature tables — `Implemented
 *     today` for the whole product, plus the Tickets / Cycles / Projects
 *     sections, which are the only areas that summary table does not cover;
 *   - the version, authors, licence and repository come from `package.json` and
 *     `src/lib/project-info.ts`, the same modules the in-app About box reads;
 *   - the status numbers are parsed out of the README's Status section;
 *   - the screenshots and their captions come from
 *     `docs/screenshots/report.json`, written by `npm run screenshots`.
 *
 * The chapter grouping — which areas sit together, which screenshots illustrate
 * them — is the one hand-made decision in here, and the script refuses to run
 * if a screenshot or a feature area is left out of it.
 *
 * Usage:
 *   npm run features:pdf              # → docs/Noema-features.pdf
 *   npm run features:pdf -- --check   # assert coverage only; no browser needed
 *   npm run features:pdf -- --html    # also keep the intermediate HTML
 *   npm run features:pdf -- --out x.pdf
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const REPORT = join(ROOT, "docs", "screenshots", "report.json");

/* ------------------------------------------------------------------ *
 * The one curated decision: how the derived rows are grouped.
 *
 * `areas` pick rows out of the README's "Implemented today" table by name;
 * `sections` pick rows out of a README section's own table (used where the
 * summary table has no row, i.e. tickets, cycles, projects and the desktop);
 * `extras` are hand-written bullets for things that are only prose in the
 * README (the native menu, the quality gates).
 * ------------------------------------------------------------------ */

const CHAPTERS = [
  {
    title: "Getting started",
    blurb:
      "Sign in, land in a workspace, and move around it without reaching for the mouse.",
    areas: ["Auth", "Workspaces", "Pages", "Navigation", "Sidebar chrome", "UX"],
    shots: [
      "02-login",
      "03-home",
      "04-home-dark",
      "05-sidebar",
      "08-command-palette",
      "09-quick-find",
    ],
  },
  {
    title: "Writing — the block editor",
    blurb:
      "A TipTap editor with Notion's block vocabulary, built for the keyboard: slash menu, drag handles, selection toolbar.",
    areas: [
      "Editor",
      "Editor blocks",
      "Block menu",
      "Undo / redo",
      "Backlinks",
      "Link previews",
      "Page chrome",
      "Page settings",
    ],
    shots: ["06-editor", "07-slash-menu", "43-mobile-editor"],
  },
  {
    title: "Databases and views",
    blurb:
      "Typed properties over rows that are pages — one dataset, eight ways to look at it.",
    areas: ["Databases", "Properties", "Formulas"],
    shots: [
      "11-db-table",
      "12-db-board",
      "13-db-timeline",
      "14-db-chart",
      "15-db-list",
      "16-db-calendar",
      "17-db-gallery",
      "18-row-peek",
    ],
  },
  {
    title: "Planning — tickets, cycles and projects",
    blurb:
      "A Linear-style issue tracker, sprints with a burndown, and projects with milestones — all on top of the same workspace.",
    sections: [
      { label: "Tickets (issues)" },
      { label: "Cycles (sprints)" },
      { label: "Email, invitations & projects", pick: ["Projects & milestones"] },
    ],
    shots: [
      "19-tickets-list",
      "20-tickets-board",
      "21-tickets-timeline",
      "22-ticket-drawer",
      "23-cycles",
      "24-projects",
      "25-project",
      "35-roadmap",
    ],
  },
  {
    title: "Finding and organising",
    blurb:
      "Postgres full-text search, a library of everything, an inbox, templates — and a trash that restores.",
    areas: [
      "Search",
      "Library",
      "Inbox",
      "Home & templates",
      "Templates",
      "Database templates",
    ],
    shots: ["26-library", "27-search", "28-inbox", "34-templates", "37-trash"],
  },
  {
    title: "Collaboration",
    blurb:
      "Comments anchored to text, workspace chat grounded in your own notes, meetings, live cursors and restorable history.",
    areas: ["Comments", "Discussions", "Meetings", "Realtime", "Version history"],
    shots: ["29-chat", "30-comments", "31-versions", "36-audit"],
  },
  {
    title: "Sharing and permissions",
    blurb:
      "Publish a page to the open web, and decide exactly who can open what inside the workspace.",
    areas: ["Sharing", "Page permissions"],
    sections: [{ label: "Permissions: guests, teamspaces, page shares" }],
    shots: ["32-share", "33-public-page"],
  },
  {
    title: "Platform, AI and administration",
    blurb:
      "An HTTP API, OAuth apps, signed webhooks, bring-your-own-model AI, importers, and the settings that hold it together.",
    areas: [
      "Public API",
      "OAuth apps",
      "Webhooks",
      "Webhook log",
      "AI",
      "AI grounding",
      "AI skills",
      "Automations",
      "Security",
      "Import / Export",
      "Exports",
      "Importers",
      "i18n / RTL",
      "Accessibility",
      "Workspace settings",
    ],
    shots: [
      "38-settings",
      "39-settings-tokens",
      "40-settings-data",
      "41-settings-prompts",
      "42-settings-notifications",
    ],
  },
  {
    title: "The desktop app",
    blurb:
      "The same codebase as a per-user Windows installer: a Tauri 2 shell around a bundled Node runtime and an embedded PostgreSQL.",
    sections: [{ label: "Desktop app" }],
    extras: [
      [
        "Native menu",
        "A real application menu — File, Edit, View, Help — wired to the same commands the in-app palette runs, including Help → **About** and Help → **Keyboard shortcuts**.",
      ],
      [
        "Diagnostics",
        "Help → **Diagnostics** shows the shell, server, database and storage locations, and can take a backup without leaving the window.",
      ],
      [
        "Nothing to install",
        "No Docker, no Postgres, no account: the embedded engine starts with the app and keeps your data in `%APPDATA%\\app.noema.desktop`.",
      ],
    ],
    shots: ["10-shortcuts", "44-about"],
  },
  {
    title: "Quality and engineering",
    blurb:
      "The parts a screenshot cannot show: the gates that keep the tree honest.",
    areas: ["Quality"],
    shots: [],
    extras: [
      [
        "Drift checks",
        "`npm run check:coherence` (docs vs code), `check:i18n` (locale parity), `check:secrets`, `check:a11y` (contrast), `check:design` (design-system rules) and `check:embedded-db` (the packaged database, end to end).",
      ],
      [
        "Honesty",
        "Every feature area is tracked row by row in `docs/FEATURE_MATRIX.md`, and `npm run docs:gaps` generates `docs/MISSING_FEATURES.md` from it — so the two cannot disagree.",
      ],
    ],
  },
];

/** The shot that goes on the cover. Counted as assigned. */
const COVER_SHOT = "01-landing";

/** Shots worth a full page width, where the detail is the point. */
const WIDE_SHOTS = new Set([
  "01-landing",
  "06-editor",
  "11-db-table",
  "19-tickets-list",
  "23-cycles",
  "29-chat",
  "38-settings",
]);

/* ------------------------------------------------------------------ *
 * Reading the sources.
 * ------------------------------------------------------------------ */

function readmeLines() {
  return readFileSync(README, "utf8").split(/\r?\n/);
}

/** Strip the inline markdown that only matters for matching. */
function plain(value) {
  return value.replace(/[*`]/g, "").trim();
}

/** Read a markdown table starting at `from`; `null` when there is none. */
function readTable(lines, from) {
  const rows = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => cell === "" || /^-{2,}$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows.length ? rows : null;
}

/** The first table at or shortly after `from` (sections often open with prose). */
function tableAfter(lines, from, scan = 16) {
  const limit = Math.min(lines.length, from + scan);
  for (let i = from; i < limit; i++) {
    if (lines[i].trim().startsWith("|")) return readTable(lines, i);
  }
  return null;
}

function findSection(lines, label) {
  const wanted = new Set([label, `## ${label}`, `### ${label}`]);
  const at = lines.findIndex((line) => wanted.has(line.trim()));
  if (at < 0) throw new Error(`features-pdf: README has no section "${label}"`);
  return at;
}

const HEADER_CELLS = new Set([
  "",
  "area",
  "capability",
  "aspect",
  "provider",
  "what works",
  "detail",
  "choice",
  "notes",
  "endpoint used",
]);

/** Drop a table's header row, whatever the section calls its columns. */
function stripHeader(rows) {
  while (rows.length && HEADER_CELLS.has(plain(rows[0][0]).toLowerCase())) {
    rows.shift();
  }
  return rows;
}

/** `[[name, text], …]` for a table under a README section. */
function sectionRows(lines, label, pick) {
  const rows = stripHeader(tableAfter(lines, findSection(lines, label) + 1) ?? []);
  const pairs = rows
    .map((cells) => [cells[0], cells.slice(1).join(" | ")])
    .filter(([name, text]) => name && text);
  if (!pairs.length) {
    throw new Error(`features-pdf: no rows under README section "${label}"`);
  }
  if (!pick) return pairs;
  const wanted = new Set(pick.map(plain));
  const chosen = pairs.filter(([name]) => wanted.has(plain(name)));
  if (chosen.length !== pick.length) {
    throw new Error(`features-pdf: missing rows in "${label}": ${pick.join(", ")}`);
  }
  return chosen;
}

/** Project metadata, from the same modules the About box reads. */
function projectInfo() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const src = readFileSync(join(ROOT, "src", "lib", "project-info.ts"), "utf8");
  const constant = (name) => {
    const match = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
    if (!match) throw new Error(`features-pdf: project-info.ts has no ${name}`);
    return match[1];
  };
  const authors = [
    ...(src.match(/PROJECT_AUTHORS\s*=\s*\[([^\]]+)\]/)?.[1] ?? "").matchAll(
      /"([^"]+)"/g,
    ),
  ].map((match) => match[1]);
  if (!authors.length) throw new Error("features-pdf: project-info.ts has no authors");
  return {
    name: constant("PROJECT_NAME"),
    repository: constant("PROJECT_REPOSITORY"),
    licence: constant("PROJECT_LICENCE"),
    authors,
    version: pkg.version,
  };
}

/** The status summary, straight out of the README's Status section. */
function statusSummary(lines) {
  const text = lines.join("\n");
  const rows = text.match(/(\d+) rows,/)?.[1];
  const tally = text.match(
    /(\d+) implemented · (\d+) partial · (\d+) planned · (\d+) deliberately out of scope/,
  );
  if (!rows || !tally) {
    throw new Error("features-pdf: README's Status section has changed shape");
  }
  return {
    rows: Number(rows),
    implemented: Number(tally[1]),
    partial: Number(tally[2]),
    planned: Number(tally[3]),
    outOfScope: Number(tally[4]),
  };
}

function screenshots() {
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const shots = new Map();
  for (const shot of report) shots.set(shot.name, shot);
  return shots;
}

/* ------------------------------------------------------------------ *
 * Markdown, in the small subset the README tables use.
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `**bold**`, `` `code` `` and absolute links; relative doc links are dropped. */
function inline(markdown) {
  let html = escapeHtml(markdown.replace(/^…\s*\+?\s*/, ""));
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, text, href) =>
    /^https?:/.test(href) ? `<a href="${href}">${text}</a>` : text,
  );
  return html;
}

/** A feature row: a bold area name, then its detail. */
function featureRow([name, text]) {
  return `<li><strong>${inline(name)}</strong><span> — ${inline(text)}</span></li>`;
}

/* ------------------------------------------------------------------ *
 * The document.
 * ------------------------------------------------------------------ */

const STYLES = `
  :root {
    --fg: #1f1f1f; --muted: #6f6f6f; --line: #e4e4e1; --soft: #f7f7f5;
    --accent: #2f6feb; --kicker: #9b9b96;
  }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: var(--fg); background: #fff;
    font: 10.5pt/1.5 "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
    text-wrap: pretty;
  }
  h1, h2, h3 { font-weight: 650; letter-spacing: -0.015em; margin: 0; }
  p { margin: 0 0 2.4mm; }
  code {
    font-family: "Cascadia Mono", ui-monospace, Consolas, monospace;
    font-size: 0.88em; background: var(--soft); border-radius: 3px; padding: 0 1mm;
  }
  a { color: var(--accent); text-decoration: none; }
  ul { margin: 0; padding: 0; list-style: none; }
  section { break-inside: auto; }
  .page { break-before: page; }

  /* Cover */
  .cover { padding-top: 6mm; }
  .brand { font-size: 15pt; font-weight: 700; letter-spacing: -0.02em; }
  .brand span { color: var(--accent); }
  .cover .meta {
    display: flex; gap: 6mm; color: var(--muted); font-size: 9.5pt;
    margin-top: 2mm; padding-bottom: 3mm; border-bottom: 1px solid var(--line);
  }
  .cover h1 { font-size: 27pt; line-height: 1.15; margin: 10mm 0 4mm; max-width: 150mm; }
  .cover .lede { font-size: 12pt; color: var(--muted); max-width: 140mm; margin-bottom: 8mm; }
  .cover .hero img { width: 100%; border: 1px solid var(--line); border-radius: 5px; }
  .cover .hero figcaption { color: var(--muted); font-size: 9pt; margin-top: 1.6mm; }
  .cover .foot {
    margin-top: 8mm; padding-top: 3mm; border-top: 1px solid var(--line);
    display: flex; gap: 10mm; font-size: 9.5pt; color: var(--muted);
  }
  .cover .foot b { color: var(--fg); font-weight: 600; display: block; }

  /* At a glance */
  .glance h2 { font-size: 19pt; margin-bottom: 2mm; }
  .glance .sub { color: var(--muted); margin-bottom: 6mm; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-bottom: 8mm; }
  .card { background: var(--soft); border-radius: 5px; padding: 4mm 3mm; }
  .card .n { display: block; font-size: 20pt; font-weight: 700; letter-spacing: -0.02em; }
  .card .l { display: block; color: var(--muted); font-size: 8.5pt; line-height: 1.3; margin-top: 1mm; }
  .glance h3 { font-size: 12pt; margin-bottom: 3mm; }
  .contents { display: grid; grid-template-columns: 1fr 1fr; gap: 1.6mm 8mm; font-size: 10pt; }
  .contents li { display: flex; gap: 2.5mm; }
  .contents b { color: var(--kicker); font-weight: 600; font-variant-numeric: tabular-nums; }

  /* Chapters */
  .chapter .head { border-bottom: 1px solid var(--line); padding-bottom: 2.5mm; margin-bottom: 4mm; }
  .kicker {
    color: var(--kicker); font-size: 8.5pt; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
  }
  .chapter h2 { font-size: 18pt; margin: 1mm 0 1.5mm; }
  .chapter .blurb { color: var(--muted); margin: 0; max-width: 160mm; }
  .features { margin-bottom: 5mm; }
  .features li {
    padding-left: 4.5mm; position: relative; margin-bottom: 1.8mm;
    break-inside: avoid;
  }
  .features li::before {
    content: ""; position: absolute; left: 0; top: 2.1mm;
    width: 1.6mm; height: 1.6mm; border-radius: 50%; background: var(--accent);
  }
  .features strong { font-weight: 650; }
  .features span { color: #3d3d3d; }

  /* Screenshots */
  .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm 4mm; }
  figure { margin: 0; break-inside: avoid; }
  figure.wide { grid-column: 1 / -1; }
  figure img { width: 100%; border: 1px solid var(--line); border-radius: 4px; display: block; }
  figcaption { margin-top: 1.5mm; font-size: 8.5pt; line-height: 1.35; }
  figcaption b { font-weight: 600; }
  figcaption .route {
    display: block; color: var(--muted);
    font-family: "Cascadia Mono", ui-monospace, Consolas, monospace; font-size: 7.5pt;
    margin-top: 0.4mm;
  }

  /* Closing */
  .closing h2 { font-size: 18pt; margin-bottom: 3mm; }
  .closing pre {
    background: var(--soft); border-radius: 5px; padding: 4mm;
    font-family: "Cascadia Mono", ui-monospace, Consolas, monospace;
    font-size: 9pt; line-height: 1.5; margin: 0 0 5mm; white-space: pre;
  }
  .closing .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .closing h3 { font-size: 11pt; margin-bottom: 1.5mm; }
  .closing p { color: #3d3d3d; }
  .signature { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid var(--line); color: var(--muted); font-size: 9pt; }
`;

function figure(shot, images) {
  const wide = WIDE_SHOTS.has(shot.name) ? " wide" : "";
  return `<figure class="${wide.trim()}">
      <img src="${images.get(shot.name)}" alt="${escapeHtml(shot.caption)}">
      <figcaption><b>${escapeHtml(shot.caption)}</b><span class="route">${escapeHtml(shot.url)}</span></figcaption>
    </figure>`;
}

function buildHtml({ project, board, shots, images, rowsFor }) {
  const authorLine =
    project.authors.length > 1
      ? `${project.authors.slice(0, -1).join(", ")} and ${project.authors.at(-1)}`
      : project.authors[0];
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const chapters = CHAPTERS.map((chapter, index) => {
    const number = String(index + 1).padStart(2, "0");
    const features = rowsFor(chapter);
    const figures = chapter.shots
      .map((name) => shots.get(name))
      .filter(Boolean)
      .map((shot) => figure(shot, images))
      .join("\n");
    return `<section class="chapter page">
    <div class="head">
      <div class="kicker">Chapter ${number}</div>
      <h2>${escapeHtml(chapter.title)}</h2>
      <p class="blurb">${escapeHtml(chapter.blurb)}</p>
    </div>
    <ul class="features">
${features.map(featureRow).join("\n")}
    </ul>
    ${figures ? `<div class="shots">\n${figures}\n</div>` : ""}
  </section>`;
  }).join("\n");

  const contents = CHAPTERS.map(
    (chapter, index) =>
      `<li><b>${String(index + 1).padStart(2, "0")}</b><span>${escapeHtml(chapter.title)}</span></li>`,
  ).join("\n");

  const cover = shots.get(COVER_SHOT);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.name)} — feature overview</title>
<style>${STYLES}</style>
</head>
<body>

<section class="cover">
  <div class="brand"><span>&#9670;</span> ${escapeHtml(project.name)}</div>
  <div class="meta">
    <span>Feature overview</span>
    <span>Version ${escapeHtml(project.version)}</span>
    <span>${escapeHtml(today)}</span>
    <span>${escapeHtml(project.licence)} licence</span>
  </div>
  <h1>A local-first workspace for notes, docs and databases.</h1>
  <p class="lede">
    ${escapeHtml(project.name)} is an open-source workspace — the editor, the
    databases, the tracker and the desktop app — built end to end. This document
    is the tour: what it does, grouped by area, illustrated with screenshots
    taken from the seeded demo workspace.
  </p>
  <figure class="hero">
    <img src="${images.get(COVER_SHOT)}" alt="${escapeHtml(cover.caption)}">
    <figcaption>${escapeHtml(cover.caption)} — <span class="route" style="display:inline">${escapeHtml(cover.url)}</span></figcaption>
  </figure>
  <div class="foot">
    <div><b>Authors</b>${escapeHtml(authorLine)}</div>
    <div><b>Source</b>${escapeHtml(project.repository.replace(/^https?:\/\//, ""))}</div>
    <div><b>Screenshots</b>${shots.size}, generated by the repo</div>
  </div>
</section>

<section class="glance page">
  <h2>At a glance</h2>
  <p class="sub">
    Every feature area is tracked row by row in the repository, with a status and
    a note explaining the current state. Nothing is dropped silently.
  </p>
  <div class="cards">
    <div class="card"><span class="n">${board.rows}</span><span class="l">tracked feature rows</span></div>
    <div class="card"><span class="n">${board.implemented}</span><span class="l">implemented</span></div>
    <div class="card"><span class="n">${board.partial}</span><span class="l">partial, enumerated</span></div>
    <div class="card"><span class="n">${shots.size}</span><span class="l">screenshots in this document</span></div>
  </div>
  <p class="sub">
    ${board.planned} planned · ${board.outOfScope} deliberately out of scope. The
    gap list is generated from the same source as the tracker, so the two cannot
    disagree.
  </p>
  <h3>What&rsquo;s inside</h3>
  <ul class="contents">
${contents}
  </ul>
</section>

${chapters}

<section class="closing page">
  <h2>Running it yourself</h2>
  <p class="sub">The web app runs on Postgres; the desktop app needs nothing else.</p>
  <pre>docker compose up -d             # Postgres 16 on localhost:5433
npm install
npx prisma migrate reset --force # schema, demo data, search index
npm run dev                      # http://localhost:3000

npm run desktop:bundle           # → ${escapeHtml(project.name)}_${escapeHtml(project.version)}_x64-setup.exe</pre>
  <p class="sub">
    Sign in with <code>demo@noema.local</code> / <code>password123</code> — the
    workspace in these screenshots.
  </p>
  <div class="cols">
    <div>
      <h3>Where to read next</h3>
      <p>
        The README for the summary, <code>docs/FEATURE_MATRIX.md</code> for the
        row-by-row tracker, <code>docs/MISSING_FEATURES.md</code> for what is
        unfinished, <code>docs/DESKTOP.md</code> for packaging and the embedded
        database, and <code>docs/specs/</code> for the long-form specifications.
      </p>
    </div>
    <div>
      <h3>How this document is made</h3>
      <p>
        <code>npm run features:pdf</code> renders this file from the README&rsquo;s
        own feature tables and the screenshot report. Change a feature and the
        next build of the sheet changes with it.
      </p>
    </div>
  </div>
  <div class="signature">
    ${escapeHtml(project.name)} ${escapeHtml(project.version)} ·
    ${escapeHtml(authorLine)} ·
    ${escapeHtml(project.licence)} ·
    ${escapeHtml(project.repository.replace(/^https?:\/\//, ""))}
  </div>
</section>

</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Assemble.
 * ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const value = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };

  const lines = readmeLines();
  const project = projectInfo();
  const board = statusSummary(lines);
  const shots = screenshots();

  const implemented = new Map(
    stripHeader(tableAfter(lines, findSection(lines, "Implemented today") + 1) ?? [])
      .map((cells) => [cells[0], cells.slice(1).join(" | ")])
      .filter(([name, text]) => name && text),
  );

  /** Feature rows for one chapter: README areas, section rows, then extras. */
  function rowsFor(chapter) {
    const rows = [];
    for (const area of chapter.areas ?? []) {
      const text = implemented.get(area);
      if (!text) throw new Error(`features-pdf: README has no feature row "${area}"`);
      rows.push([area, text]);
    }
    for (const section of chapter.sections ?? []) {
      rows.push(...sectionRows(lines, section.label, section.pick));
    }
    for (const extra of chapter.extras ?? []) rows.push(extra);
    if (!rows.length) throw new Error(`features-pdf: chapter "${chapter.title}" is empty`);
    return rows;
  }

  /* Guard: the sheet is only honest if nothing is missing. */
  const usedAreas = CHAPTERS.flatMap((chapter) => chapter.areas ?? []);
  const duplicateArea = usedAreas.find((area, index) => usedAreas.indexOf(area) !== index);
  if (duplicateArea) throw new Error(`features-pdf: "${duplicateArea}" is used twice`);
  const missingAreas = [...implemented.keys()].filter((area) => !usedAreas.includes(area));
  if (missingAreas.length) {
    throw new Error(
      `features-pdf: README feature rows not in any chapter: ${missingAreas.join(", ")}`,
    );
  }

  const assigned = [COVER_SHOT, ...CHAPTERS.flatMap((chapter) => chapter.shots)];
  const duplicateShot = assigned.find((name, index) => assigned.indexOf(name) !== index);
  if (duplicateShot) throw new Error(`features-pdf: screenshot "${duplicateShot}" is used twice`);
  const unknownShots = assigned.filter((name) => !shots.has(name));
  if (unknownShots.length) {
    throw new Error(
      `features-pdf: screenshots not in report.json: ${unknownShots.join(", ")} — run npm run screenshots`,
    );
  }
  const unassigned = [...shots.keys()].filter((name) => !assigned.includes(name));
  if (unassigned.length) {
    throw new Error(
      `features-pdf: screenshots not placed in any chapter: ${unassigned.join(", ")}`,
    );
  }

  return { project, board, shots, chapters: CHAPTERS, rowsFor, args, flag, value };
}

/** The HTML, with every screenshot inlined so it renders anywhere. */
function buildDocument({ project, board, shots, rowsFor, flag }) {
  const images = new Map();
  for (const shot of shots.values()) {
    const file = join(ROOT, shot.file);
    const bytes = readFileSync(file);
    images.set(shot.name, `data:image/png;base64,${bytes.toString("base64")}`);
  }

  const html = buildHtml({ project, board, shots, images, rowsFor });

  if (flag("html")) {
    const htmlPath = join(ROOT, "docs", "Noema-features.html");
    writeFileSync(htmlPath, html);
    console.log(`features-pdf: wrote ${htmlPath}`);
  }

  return html;
}

async function render(assembled) {
  const { shots, chapters, value } = assembled;
  const html = buildDocument(assembled);
  const out = resolve(ROOT, value("out") ?? join("docs", "Noema-features.pdf"));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    mkdirSync(dirname(out), { recursive: true });
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "13mm", bottom: "15mm", left: "13mm" },
    });
  } finally {
    await browser.close();
  }

  const size = statSync(out).size;
  console.log(
    `features-pdf: ${out}\n` +
      `features-pdf: ${chapters.length} chapters · ${shots.size} screenshots · ` +
      `${(size / 1024 / 1024).toFixed(1)} MB · ${pathToFileURL(out).href}`,
  );
}

async function run() {
  const assembled = main();

  /* `--check` runs the drift guards and stops: the render needs a browser, the
   * guards do not, so CI can assert coverage on a runner without one. */
  if (assembled.flag("check")) {
    const { chapters, shots, board } = assembled;
    console.log(
      `features-pdf: OK — ${chapters.length} chapters cover ${shots.size} screenshots ` +
        `and ${board.rows} tracked feature rows`,
    );
    return;
  }

  await render(assembled);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
