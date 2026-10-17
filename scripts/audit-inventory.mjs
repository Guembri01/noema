// Static inventory of the app surface, used by the coherence gate.
//
//   node scripts/audit-inventory.mjs [--json]
//
// Writes docs/_audit-raw.json and prints a summary. No dependencies.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const srcRoot = join(root, "src");

function walk(dir, extensions, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "test-results", "dist"].includes(entry.name)) continue;
      walk(full, extensions, out);
      continue;
    }
    if (extensions.includes(extname(entry.name))) out.push(full);
  }
  return out;
}

const files = walk(srcRoot, [".ts", ".tsx"]);
const rel = (file) => relative(root, file).replace(/\\/g, "/");
const read = (file) => readFileSync(file, "utf8");
const contents = new Map(files.map((file) => [file, read(file)]));

const allText = files.map((file) => contents.get(file)).join("\n");
const countMatches = (text, re) => (text.match(re) ?? []).length;

// --- 1. Server actions: exports, auth, references ---------------------------
const actionFiles = walk(join(srcRoot, "server", "actions"), [".ts"]);
const actions = [];
for (const file of actionFiles) {
  const text = contents.get(file) ?? read(file);
  const exported = [...text.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const name of exported) {
    const references = files.filter((candidate) => {
      if (candidate === file) return false;
      return new RegExp(`\\b${name}\\b`).test(contents.get(candidate) ?? "");
    });
    const block = text.slice(text.indexOf(`function ${name}`)).split(/\nexport\s/)[0];
    actions.push({
      file: rel(file),
      name,
      references: references.length,
      referencedIn: references.slice(0, 6).map(rel),
      guarded: /requireUser\s*\(/.test(block) || /getCurrentUser\s*\(/.test(block),
      permissionChecked:
        /getWorkspaceAccess|canEditContent|canManageMembers|canAdminister|assertWorkspaceAccess|canView|role/.test(block),
      validates: /safeParse|\.parse\(|zod|typeof .*===|\.trim\(\)|Number\.isFinite/.test(block),
    });
  }
}
const orphanActions = actions.filter((action) => action.references === 0);
const unguardedActions = actions.filter((action) => !action.guarded);
const unpermissionedActions = actions.filter((action) => action.guarded && !action.permissionChecked);

// --- 2. Client call sites that skip safeAction -----------------------------
const clientFiles = files.filter((file) => /^"use client"/m.test(contents.get(file) ?? ""));
const unsafeCallSites = [];
const unwrappedCallSites = [];
for (const file of clientFiles) {
  const text = contents.get(file) ?? "";
  if (!/Action\s*\(/.test(text)) continue;
  const wraps = /safeAction|useAction|guarded/.test(text);
  // Actions re-declared through `guarded(...)` are safe, even though the call
  // site still reads `await doThingAction(...)`.
  const guardedNames = new Set(
    [...text.matchAll(/const\s+(\w+Action)\s*=\s*guarded\(/g)].map((match) => match[1]),
  );
  const rawCalls = [...text.matchAll(/await\s+(\w+Action)\s*\(/g)].filter((match) => {
    const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
    if (/safeAction|guarded\(/.test(line)) return false;
    if (guardedNames.has(match[1])) return false;
    return true;
  });
  if (!wraps && rawCalls.length > 0) {
    // No helper at all: a rejected action becomes an unhandled rejection.
    // Files that merely mention Action( without an unhandled await call
    // (e.g. `void doThingAction().catch(...)` or a try/catch wrapper) are safe.
    unwrappedCallSites.push({ file: rel(file), raw: rawCalls.map((m) => m[1]) });
  } else if (rawCalls.length > 0) {
    // Helpers are adopted but some calls still bypass them (style drift only).
    unsafeCallSites.push({ file: rel(file), raw: rawCalls.map((m) => m[1]) });
  }
}

// --- 3. Placeholder / dead controls ----------------------------------------
const placeholderPatterns = [
  ["toast.info", /toast\.info\(/g],
  ["window.prompt", /window\.prompt\(/g],
  ["window.alert", /window\.(?:alert|confirm)\(/g],
  ["TODO", /\bTODO\b/g],
  ["FIXME", /\bFIXME\b/g],
  ["not implemented", /not implemented|coming soon|placeholder|stub/i],
];
const placeholders = {};
for (const [label, re] of placeholderPatterns) {
  const hits = [];
  for (const file of files) {
    const n = countMatches(contents.get(file) ?? "", re);
    if (n > 0) hits.push({ file: rel(file), count: n });
  }
  placeholders[label] = hits;
}

// --- 4. Buttons: icon-only without aria-label, and handler-less ------------
const buttonIssues = { iconOnlyUnlabelled: [], noHandler: [] };
for (const file of clientFiles) {
  const text = contents.get(file) ?? "";
  const blocks = [...text.matchAll(/<button\b[\s\S]{0,900}?>/g)].map((m) => m[0]);
  blocks.forEach((block, index) => {
    const hasAria = /aria-label|aria-labelledby|title=/.test(block);
    const iconOnly = /<[A-Z]\w*\s+className="[^"]*h-\d[^"]*"/.test(block) && !/>[^<>{]{2,}</.test(block);
    if (iconOnly && !hasAria) buttonIssues.iconOnlyUnlabelled.push({ file: rel(file), snippet: block.replace(/\s+/g, " ").slice(0, 120) });
    const hasHandler = /onClick|onSelect|type="submit"|formAction|onKeyDown|onPointerDown|asChild/.test(block);
    if (!hasHandler) buttonIssues.noHandler.push({ file: rel(file), snippet: block.replace(/\s+/g, " ").slice(0, 120), index });
  });
}

// --- 5. Routes and reachability --------------------------------------------
const pages = files.filter((file) => /[/\\]app[/\\].*page\.tsx$/.test(file)).map((file) => {
  const route = rel(file)
    .replace(/^src\/app/, "")
    .replace(/\/page\.tsx$/, "")
    .replace(/\(.*?\)\//g, "/")
    .replace(/\[(\w+)\]/g, ":$1") || "/";
  const referenced = new RegExp(route.replace(/:[A-Za-z]+/g, "\\$&").split("/").filter(Boolean)[0] ?? "__none__", "i").test(allText);
  return { route: route || "/", file: rel(file), referenced };
});
const apiRoutes = files
  .filter((file) => /[/\\]app[/\\].*route\.ts$/.test(file))
  .map((file) => ({
    route: rel(file).replace(/^src\/app/, "").replace(/\/route\.ts$/, ""),
    file: rel(file),
    authenticated: /getCurrentUser|requireUser/.test(contents.get(file) ?? ""),
    rateLimited: /rateLimit/.test(contents.get(file) ?? ""),
    permissionChecked: /getWorkspaceAccess|canEdit|canManage|claim|token/.test(contents.get(file) ?? ""),
  }));

// --- 6. Coherence probes ---------------------------------------------------
const coherence = {
  statusVocabularies: {
    project: [...new Set([...allText.matchAll(/project[\s\S]{0,120}?status:\s*(?:\[|")([^\]"\n,]+)/gi)].map((m) => m[1]))].slice(0, 12),
    ticket: [...new Set([...allText.matchAll(/TICKET_STATUSES[\s\S]{0,400}?/g)].map((m) => m[0]).slice(0, 1))].length,
  },
  dateFormatting: {
    toLocaleDateString: countMatches(allText, /toLocaleDateString\(/g),
    toLocaleString: countMatches(allText, /toLocaleString\(/g),
    toISOString: countMatches(allText, /toISOString\(/g),
    dateFnsImports: countMatches(allText, /from "date-fns"/g),
  },
  vocabulary: {
    note: countMatches(allText, /\bnote\b/gi),
    page: countMatches(allText, /\bpage\b/gi),
    doc: countMatches(allText, /\bdocument\b/gi),
    untitled: countMatches(allText, /Untitled/g),
  },
  dropdownImplementations: {
    radix: countMatches(allText, /@radix-ui\/react-dropdown-menu/g) + countMatches(allText, /@radix-ui\/react-context-menu/g),
    cmdk: countMatches(allText, /(?:from "cmdk"|@\/components\/ui\/command)/g),
    handRolled: countMatches(allText, /role="menu"/g),
  },
  dangerouslySetInnerHTML: files
    .filter((file) => /dangerouslySetInnerHTML/.test(contents.get(file) ?? ""))
    .map((file) => rel(file)),
  suppressions: {
    tsIgnore: countMatches(allText, /@ts-(ignore|expect-error)/g),
    eslintDisable: countMatches(allText, /eslint-disable/g),
    anyType: countMatches(allText, /:\s*any\b/g),
  },
  i18n: {
    filesWithTranslations: files.filter((file) => /useTranslations|from "@\/lib\/i18n"/.test(contents.get(file) ?? "")).length,
    clientFiles: clientFiles.length,
  },
};

// --- 7. Size / maintainability --------------------------------------------
const sizes = files
  .map((file) => ({ file: rel(file), lines: (contents.get(file) ?? "").split("\n").length }))
  .sort((a, b) => b.lines - a.lines);

const report = {
  generatedFor: "noema",
  totals: {
    sourceFiles: files.length,
    clientComponents: clientFiles.length,
    serverActionFiles: actionFiles.length,
    serverActions: actions.length,
    pageRoutes: pages.length,
    apiRoutes: apiRoutes.length,
    unitTestFiles: files.filter((f) => /\.test\.tsx?$/.test(f)).length,
  },
  actions: { orphan: orphanActions, unguarded: unguardedActions, missingPermissionCheck: unpermissionedActions, all: actions },
  unsafeCallSites,
  unwrappedCallSites,
  placeholders,
  buttonIssues,
  pages,
  apiRoutes,
  coherence,
  largestFiles: sizes.slice(0, 20),
};

writeFileSync(join(root, "docs", "_audit-raw.json"), JSON.stringify(report, null, 1));

const pct = (n, d) => `${n}/${d}`;
console.log("TOTALS", JSON.stringify(report.totals));
console.log(
  `ACTIONS orphan=${orphanActions.length} unguarded=${unguardedActions.length} noPermissionCheck=${unpermissionedActions.length} (of ${actions.length})`,
);
console.log(
  `CLIENT CALL SITES unwrapped=${unwrappedCallSites.length} drift=${unsafeCallSites.length}`,
);
console.log(
  `PLACEHOLDERS ` +
    Object.entries(placeholders)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(" "),
);
console.log(
  `BUTTONS iconOnlyUnlabelled=${buttonIssues.iconOnlyUnlabelled.length} noHandler=${buttonIssues.noHandler.length}`,
);
console.log(`PAGES ${pct(pages.length, pages.length)} · API unauth=${apiRoutes.filter((r) => !r.authenticated).length} unrated=${apiRoutes.filter((r) => !r.rateLimited).length}`);
console.log(`I18N files with translations=${coherence.i18n.filesWithTranslations}/${clientFiles.length}`);
console.log(`DSI (dangerouslySetInnerHTML)=${coherence.dangerouslySetInnerHTML.join(", ")}`);
console.log(`LARGEST ${sizes.slice(0, 6).map((s) => `${s.file}:${s.lines}`).join(" ")}`);
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 1).slice(0, 2000));
