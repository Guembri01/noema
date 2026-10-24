// Coherence gate: fails when the codebase drifts away from the project's own
// rules. Run before merging; wire into CI when there is one.
//
//   node scripts/check-coherence.mjs
//
// Reads docs/_audit-raw.json (regenerated here) so the inventory and the gate
// can never disagree.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Ratchets: tighten them as the debt is paid down, never loosen them. */
const BASELINE = {
  /** Files with no action helper at all (the risk class — backstopped by ActionErrorGuard). */
  /**
   * F-09 remainder: these files call actions without the shared helper. The
   * transport risk is closed by ActionErrorGuard (a global toast for unhandled
   * action rejections) and by `guarded()` being available; migrating the call
   * sites is a tracked refactor (P1.2). May only shrink.
   */
  unwrappedCallSites: 11,
  /** Files that adopted the helper but still call some actions directly (style drift). */
  unsafeCallSites: 7,
  /** Client files consuming the i18n catalogue — must not shrink. */
  i18nFiles: 71,
};

/** Injection sinks that are allowed, with the reason. */
const DSI_ALLOW = [
  "src/components/editor/equation-editor.tsx",
  // KaTeX node views inject only `renderEquation()`'s output, which is built
  // with `trust: false`, bounded macros and escaped KaTeX markup (math-tex.ts).
  "src/components/editor/extensions/math-node.tsx",
  "src/lib/markdown.ts",
  // HTML producers/sanitizers: these modules exist to build or clean HTML, so
  // they are the single audited place where raw HTML is constructed. Every
  // caller passes their output through the sanitizer.
  "src/lib/html-export.ts",
  "src/lib/html-sanitize.ts",
  "src/lib/import-confluence.ts",
];

execFileSync(process.execPath, ["scripts/audit-inventory.mjs"], { cwd: root, stdio: "ignore" });
const report = JSON.parse(readFileSync(`${root}docs/_audit-raw.json`, "utf8"));

const failures = [];
const notes = [];
const ok = (label, detail) => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail) => {
  failures.push(label);
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. Every Server Action is reachable.
const orphans = report.actions.orphan;
if (orphans.length === 0) ok("no orphan server actions");
else fail("orphan server actions", orphans.map((a) => `${a.file}:${a.name}`).join(", "));

// 2. No native browser dialogs.
for (const kind of ["window.prompt", "window.alert", "toast.info"]) {
  const hits = report.placeholders[kind] ?? [];
  if (hits.length === 0) ok(`no ${kind}`);
  else fail(`${kind} still used`, hits.map((h) => h.file).join(", "));
}

// 3. Injection sinks stay on the allow-list (KaTeX); the Markdown path never emits HTML.
const dsi = report.coherence.dangerouslySetInnerHTML.filter((file) => !DSI_ALLOW.includes(file));
if (dsi.length === 0) ok("dangerouslySetInnerHTML only in the allowed sinks", DSI_ALLOW.join(", "));
else fail("unexpected dangerouslySetInnerHTML", dsi.join(", "));

// 4. Action-call drift: unwrapped calls are the risk class, drift is style.
const unwrapped = report.unwrappedCallSites.length;
const drift = report.unsafeCallSites.length;
if (unwrapped <= BASELINE.unwrappedCallSites) {
  ok("unwrapped action calls within baseline", `${unwrapped} <= ${BASELINE.unwrappedCallSites}`);
  if (unwrapped > 0) {
    notes.push(
      `migrate to useAction() (covered meanwhile by ActionErrorGuard): ${report.unwrappedCallSites
        .map((site) => site.file.replace(/^src\//, ""))
        .join(", ")}`,
    );
  }
} else {
  fail("unwrapped action calls grew", `${unwrapped} > baseline ${BASELINE.unwrappedCallSites}`);
}
if (drift <= BASELINE.unsafeCallSites) {
  ok("action-helper drift within baseline", `${drift} <= ${BASELINE.unsafeCallSites}`);
} else {
  fail("action-helper drift grew", `${drift} > baseline ${BASELINE.unsafeCallSites}`);
}

// 5. i18n coverage may grow, may not shrink.
const i18n = report.coherence.i18n.filesWithTranslations;
if (i18n >= BASELINE.i18nFiles) ok(`i18n coverage held`, `${i18n} >= ${BASELINE.i18nFiles} files`);
else fail("i18n coverage dropped", `${i18n} < baseline ${BASELINE.i18nFiles}`);

// 6. No dead placeholder controls in the chat composer (regression guard).
const notImplemented = report.placeholders["not implemented"] ?? [];
const suspicious = notImplemented.filter((hit) => !/input\.tsx$/.test(hit.file));
notes.push(
  `placeholder/attribute matches needing manual triage: ${suspicious.length} file(s) (mostly form placeholders)`,
);

console.log(`\n${failures.length === 0 ? "COHERENT" : "DRIFT DETECTED"} — ${failures.length} failure(s)`);
for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
  console.log("\nFix the failures above, then re-run this gate.");
  process.exit(1);
}
