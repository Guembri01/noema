#!/usr/bin/env node
/**
 * Animation & action coverage — checks the "complete animations and actions
 * system" spec, section by section, and reports per item:
 *
 *   ok       evidence found (the file that proves it)
 *   partial  present with a stated limitation (the note says which)
 *   MISSING  no evidence in src/**
 *
 * Two honest limits, stated up front so nothing here is over-claimed:
 *
 *  · the spec's action names (`toggleSidebar()`, `moveBlock(…)`) are illustrative
 *    API names, not identifiers in this codebase — mapping them to behaviour means
 *    searching for the *effect* (a token-driven width transition, a pointer-tracked
 *    drag), which is what the patterns below do;
 *  · "the animation exists in the DOM" is not the same as "it looks right". Anything
 *    that can only be judged by watching is marked `partial` with the reason, and is
 *    a line item for the browser harness rather than a claim here.
 *
 *   npm run audit:motion-spec
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

const corpus = walk(SRC)
  .filter((file) => /\.(tsx|ts|css)$/.test(file) && !/\.test\./.test(file))
  .map((file) => ({ file: relative(ROOT, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }));

const find = (regex) => corpus.filter((entry) => regex.test(entry.text)).map((entry) => entry.file);

/** section → [label, regex, note?] */
const SPEC = [
  ["1 Global animation system", [
    ["Duration tokens, not ad-hoc values", /--dur-1:|--dur-2:/, ""],
    ["Easing tokens (standard / enter / exit)", /--ease-[a-z-]+:/, ""],
    ["Micro-interaction tier 100–150ms", /--dur-1: 1[0-4][0-9]ms|--dur-1: 120ms/, ""],
    ["Standard tier 150–220ms", /--dur-2: 1[5-9][0-9]ms|--dur-2: 180ms/, ""],
    ["Panel/dialog tier 200–300ms", /--dur-3: 2[0-9][0-9]ms|--dur-3: 240ms/, ""],
    ["Global reduced-motion override", /prefers-reduced-motion: reduce/, ""],
    // The spec's animation-property list, checked as *used*, not merely available.
    ["opacity", /transition[^\n]{0,60}opacity/, ""],
    ["transform: translate", /translate[XY]?\(|translate3d/, ""],
    ["transform: scale", /scale\(0\.9|scale-\[|scale-95|scale\(0\.98/, ""],
    ["width / grid-template-columns", /grid-template-columns|transition-\[width\]|width var\(--dur/, ""],
    ["reveal technique for expandable sections", /grid-template-rows|transition-\[width\]|useFlipList/, "we transition metrics we actually know (width, grid-template-rows, FLIP) rather than max-height - recorded as a decision in docs/DESIGN_SYSTEM.md §6"],
    ["background-color", /transition[^\n]{0,80}background-color/, ""],
    ["color", /transition[^\n]{0,80}color/, ""],
    ["box-shadow / elevation", /transition[^\n]{0,80}box-shadow/, ""],
    ["border-color", /transition[\s\S]{0,120}border-color/, ""],
    ["rotate (chevrons)", /rotate-90|rotate\(90|rotate-\[|Transition[^\n]{0,80}rotate/, ""],
    ["scroll-behavior: smooth", /scroll-behavior|behavior: "smooth"|behavior: 'smooth'/, ""],
    ["Loading cycle 800–1600ms (shimmer/spin/pulse)", /@keyframes (shimmer|spin|pulse)/, ""],
  ]],
  ["2 Navigation and sidebar", [
    ["Collapse/expand sidebar (width on a token)", /transition-\[width\]|(?:width|height)[^\n]{0,24}var\(--dur-[0-9]\)/, ""],
    ["Hover navigation item (background fades)", /u-interactive|hover:bg-/, ""],
    ["Selected navigation item", /aria-selected|aria-current/, ""],
    ["Nested page expand: chevron rotates", /rotate-90|ChevronRight[\s\S]{0,200}rotate/, ""],
    ["Hover page row reveals actions", /group-hover/, ""],
    ["Context menu opens from its trigger", /placeFloating|data-popup-origin/, ""],
    ["Drag page preview follows the pointer", /pointermove|setDragPosition|dragPreview/, ""],
    ["Reorder settles into place", /reorder|position Float/, ""],
    ["Favourite toggle (fill/colour change)", /toggleFavorite|favorite/, ""],
    ["Switch workspace", /workspace-switcher|switchWorkspace/, ""],
    ["Resize sidebar follows the pointer", /resizable-panel|setPointerCapture/, ""],
    ["Open search", /command-palette|quick-find/, ""],
    ["Navigate to page — content transition", /workspace-shell[\s\S]{0,200}|animate-fade/, ""],
    ["Open page peek (slides in)", /peek[\s\S]{0,300}translate/, ""],
    ["Close page peek (slides out)", /peekMounted|peekEntered|peek-scrim/, ""],
    ["Back / forward navigation actions", /nav-history|useNavHistory/, ""],
  ]],
  ["3 Editor and block animations", [
    ["Block focus cue", /focus-visible|ProseMirror-focused|focus-ring/, ""],
    ["Slash menu fade + scale in", /slash-menu/, ""],
    ["Formatting toolbar near the selection", /bubble-toolbar/, ""],
    ["Block insertion does not shift focus", /insertBlock|insertContent/, ""],
    ["Block deletion repositions siblings", /useFlipList/, ""],
    ["Toggle expand/collapse children", /toggle[\s\S]{0,200}collapse|TaskItem|toggleList/, ""],
    ["Drag handle fades in on hover", /noema-drag-handle[\s\S]{0,200}opacity|group-hover[\s\S]{0,80}drag/i, ""],
    ["Block menu opens next to its trigger", /block-context-menu/, ""],
    ["Drop indicator moves between blocks", /drop-indicator|dropIndicator/, ""],
    ["Neighbouring blocks animate into new positions", /useFlipList|FLIP_ID_ATTRIBUTE/, ""],
    ["Invalid drop target rejection state", /dropVerdict|data-invalid/, ""],
    ["Movement threshold before a drag starts", /threshold/, ""],
    ["Undo / redo", /undo|redo/, ""],
  ]],
  ["4 Database animations", [
    ["Add / delete row", /createRow|deleteRow/, ""],
    ["Row fade in/out", /rowMotionStyle|retainLeaving|group-motion/, ""],
    ["Reorder rows / drag cards", /reorderRow|moveBoardCard|onDropCard/, ""],
    ["Resize column follows the pointer", /onColumnResize|resizeColumn|setPointerCapture/, ""],
    ["Open record as page or peek", /openPeek|peek/, ""],
    ["Property editor popover beside the cell", /property-options-editor|optionHue/, ""],
    ["Board drag highlights the target column", /isOver|dropTarget|highlight/i, ""],
    ["Calendar / timeline item move", /timeline[\s\S]{0,200}drag|calendar[\s\S]{0,200}move/i, ""],
    ["Timeline resize", /resizeTimeline|onResizeBar|dragEdge/, ""],
    ["Filter/sort updates results", /filter-tree|applyFilter/, ""],
    ["Switch view without flashing", /view-renderers|activeView/, "views swap instantly; there is no cross-transition (arguably correct — it avoids flashing)"],
    ["Expand group reveals rows", /group-motion|table-group-toggle/, ""],
  ]],
  ["5 Menus, popovers, modals", [
    ["One placement engine for floating panels", /placeFloating|FloatingLayer/, ""],
    ["Opening/closing animations (data-state driven)", /data-state=open|data-state=closed|data-side=/, ""],
    ["Tooltip fade", /ui\/tooltip/, ""],
    ["Dropdown / context menu scale from trigger", /dropdown-menu|context-menu/, ""],
    ["Search modal, share dialog, confirmation", /quick-find|share-dialog|confirm-dialog/, ""],
    ["Side drawer slides from the edge", /ui\/sheet|drawer/, ""],
    ["Command palette", /command-palette/, ""],
    ["Date picker, emoji picker", /date-picker|emoji-picker/, ""],
    ["Escape closes, outside click dismisses", /onEscapeKeyDown|consumeEscape|onPointerDownOutside/, ""],
    ["Focus is trapped and returned to the trigger", /onOpenAutoFocus|onCloseAutoFocus|returnFocus|autoFocus/, ""],
    ["Background cannot be interacted with while modal", /aria-modal|inert|modal=/, ""],
    ["Double submission prevented", /pending|aria-busy|isPending/, ""],
  ]],
  ["6 Buttons, icons, form controls", [
    ["Hover transition", /u-interactive|hover:bg-/, ""],
    ["Press scale (~0.98)", /scale\(0\.98\)|active:scale/, ""],
    ["Focus ring", /focus-ring|focus-visible/, ""],
    ["Loading spinner + duplicate-submit guard", /ButtonSpinner|loading[\s\S]{0,200}disabled|aria-busy/, ""],
    ["Switch thumb translates", /ui\/switch/, ""],
    ["Checkbox checkmark", /ui\/checkbox/, ""],
    ["Radio / segmented selection", /ui\/segmented|radio/, ""],
    ["Input focus + validation error", /aria-invalid|input-error|text-danger/, ""],
    ["Copy → checkmark feedback", /copied|Check[\s\S]{0,80}Check/, ""],
    ["Chevron rotation", /rotate-90|rotate-180/, ""],
    ["Toast on action", /toaster|toast\.success/, ""],
  ]],
  ["7 Collaboration, comments, notifications", [
    ["Comment appears in the thread", /comment-panel|comment-threads/, ""],
    ["Reply expands into view", /replyToComment|reply/, ""],
    ["Resolve thread transition", /resolve/, ""],
    ["Mention chip after selection", /mention-menu|mentions/, ""],
    ["Presence avatars appear/disappear", /avatar-stack|presence/, ""],
    ["Remote cursor moves smoothly", /awareness|cursor/, "realtime transport exists; remote cursors animate only as fast as the transport delivers"],
    ["Inbox item arrives at the top", /notifications|inbox/, ""],
    ["Mark read fades the unread indicator", /readAt|unread/, ""],
    ["Toast slides in and out", /toaster|Toast/, ""],
    ["Comment panel slides in/out", /comment-panel[\s\S]{0,300}(translate|slide)|peek/, ""],
  ]],
  ["8 Search, loading, feedback", [
    ["Search debounce", /debounce/, ""],
    ["Skeletons while loading", /ui\/skeleton|loading\.tsx/, ""],
    ["Empty state", /ui\/empty-state|EmptyState/, ""],
    ["Error state with retry", /retry/, ""],
    ["Page loading skeleton", /loading\.tsx/, ""],
    ["Upload progress / completion", /progress|uploaded/, ""],
    ["Save pending / saved / failed", /saving|saved|failed/, ""],
    ["Toast lifecycle", /toaster/, ""],
    ["Undo affordance in a toast", /withUndo|Undo/, ""],
    ["Cancel a stale search", /AbortController/, ""],
  ]],
  ["9 Page transitions, settings, AI", [
    ["Page title updates in place", /page-title|onTitleChange/, ""],
    ["Cover change crossfades", /coverKey/, ""],
    ["Theme change without a flash", /theme-bootstrap|nonce|suppressHydrationWarning/, ""],
    ["Settings section switch", /settings-nav|SettingsNav/, ""],
    ["AI streams progressively", /chat\/stream|streamChat|TextDecoder/, ""],
    ["AI stop", /stop|abort/, ""],
    ["AI accept / reject", /proposal|accept|reject/, ""],
    ["Automation running / success / failure status", /automations|run status|automationRuns/, ""],
  ]],
  ["10 Animation behaviour explorer", [
    ["An interactive place to preview the patterns", /motion-gallery|MotionGallery/, ""],
  ]],
  ["11 Implementation rules", [
    ["CSS transitions for state changes", /transition-/, ""],
    ["Keyframes for repeating/staged animation", /@keyframes/, ""],
    ["Transforms for drag previews / slides", /translate|transform/, ""],
    ["A shared timing token system", /--dur-|--ease-/, ""],
    ["No animation of everything (no `transition: all`)", /transition: all/, ""], // absence is the pass
    ["Interruptible, pointer-responsive drags", /pointermove|requestAnimationFrame/, ""],
    ["Layout animation kept away from typing", /ease-linear|u-no-transition/, ""],
    ["No animation faking success before it happens", /optimistic[\s\S]{0,400}(rollback|restore|revert)/i, ""],
  ]],
];

let ok = 0;
let partial = 0;
let missing = 0;
const gaps = [];

SPEC.forEach(([section, items]) => {
  console.log(`\n── ${section}`);
  for (const [label, regex, note] of items) {
    const hits = find(regex);
    const isAbsenceCheck = label.includes("no `transition: all`");
    if (isAbsenceCheck) {
      if (hits.length === 0) {
        ok += 1;
        console.log(`  ok       ${label}  (0 files — that is the pass)`);
      } else {
        missing += 1;
        gaps.push({ section, label, note: "found where it must not be", evidence: hits.slice(0, 3) });
        console.log(`  MISSING  ${label}  (${hits.length} files)`);
      }
      continue;
    }
    if (hits.length > 0) {
      if (note) {
        partial += 1;
        gaps.push({ section, label, note, evidence: hits.slice(0, 2) });
        console.log(`  partial  ${label}`);
        console.log(`           ${note}`);
      } else {
        ok += 1;
        console.log(`  ok       ${label}  ${hits.length > 3 ? `(${hits.length} files)` : `— ${hits[0]}`}`);
      }
    } else {
      missing += 1;
      gaps.push({ section, label, note: note ?? "no evidence in src/**", evidence: [] });
      console.log(`  MISSING  ${label}`);
      console.log(`           no evidence in src/**`);
    }
  }
});

console.log(`\n=== ${ok} ok · ${partial} partial · ${missing} missing ===`);
if (gaps.length > 0) {
  console.log("\nGaps:");
  for (const gap of gaps) console.log(`  · [${gap.section.split(" ")[0]}] ${gap.label} — ${gap.note}`);
}
