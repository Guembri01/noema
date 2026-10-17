# Spec — Navigation UX: side peek, page tabs, back/forward, shortcut map

> **Status: spec complete, implementation pending.** A **docs-only** change: no
> `src/**`, `e2e/**` or schema file was edited to produce this document. Every claim about the current code cites `file:line`
> as measured on 2026-10-15. Requirement IDs (`R29.x`) are the traceability
> anchors: §11 lists tasks 1:1 against them and tests must cite the IDs they
> cover. §13 maps them to the exact `FEATURE_MATRIX` rows this change appends its
> spec path to — **side peek / tabs / back-forward rows only**; the command
> palette and shortcut rows belong to **B43** and are deliberately untouched
> (this spec designs *around* them, see §3.4).

---

## 1. Problem statement

Noema navigates exactly like a server-rendered site: one page on screen, the
browser's own back button, and no way to keep a second page open. Four
navigation affordances that the product class ships are missing or only
half-built:

- **Side peek** — the matrix plans "preview in a side drawer" twice (a general
  *Side peek* row and a database *Open row in side peek* row), yet the only
  drawer in the codebase is an ad-hoc, database-local `<aside>` that is not
  deep-linkable, has no Escape handling, cannot be reached by keyboard, and
  shows properties only (no content).
- **Page tabs** — nothing in `src/**` models "multiple open pages as tabs".
  The word *tabs* in this codebase means the sidebar's Home/Chat/Meetings
  switch and database view tabs, both of which reset or are persisted for a
  different purpose.
- **Back/forward** — there is **zero** use of `router.back`, `history.back`,
  `pushState` or `popstate` anywhere in `src/`; the only "back" affordances are
  two hardcoded "Back to …" links on secondary screens.
- **A shortcut map** — keybindings are scattered: one `window` keydown listener
  in the shell, synthetic `KeyboardEvent` dispatch in the topbar, TipTap's own
  editor bindings, and shortcut *labels* rendered from a menu model. There is no
  single place that says what is bound, in which scope, and who owns it — which
  is precisely why B43 (command palette) and B11 (Actions menu) had to claim
  rows before this spec landed.

The goal is a coherent navigation layer — **peek + tabs + history + one
shortcut registry** — that extends the existing shell, chat-dock and database
peek precedents instead of replacing them, and that B43's palette can consume
rather than duplicate.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Side-peek state | `src/components/database/database-view.tsx:138` `const [peek, setPeek] = useState<DBRow \| null>(null)` | **Local to one component.** Not URL state, not shareable, lost on reload, resets when the view unmounts. |
| Side-peek drawer | `database-view.tsx:1044-1124` — `{peek && (<aside className="fixed inset-y-0 right-0 z-40 w-[26rem] … p-5 shadow-2xl" aria-label={t(locale,"rowLabel")}>` … property `<dl>` (`:1076-1123`) … `</aside>)}` | **Partial.** Renders: title, "Open as page" link (`:1054-1059`), close `X` (`:1060-1067`), inline property editors (`:1093-1117`). Width fixed, no resize, **no `role`/`aria-modal`, no Escape handler** (no `Escape` match in the file), no backdrop, no focus management, no content preview, no history integration. |
| Peek trigger | `src/components/database/view-renderers.tsx:236` `<div className="… opacity-0 group-hover:opacity-100">` wrapping the button at `:245-252` (`title={t(locale,"openSidePeek")}`, `onClick={() => onOpenPeek(row)}`) | **Mouse-only.** Hover-gated opacity means keyboard users never see it; no `aria-expanded`, not in tab order when invisible. |
| Peek i18n | `src/lib/i18n.ts:455` `openSidePeek: "Open side peek"` (+ `:1153` fr, `:1846` es, `:2539` de, `:3232` ar); `closeSidePeek` also exists | Present — keys already exist for a real drawer. |
| Other peek precedent | `src/components/chat-panel.tsx:91-95` — "Docked AI conversation panel. Lives inside the main content area (like the **sidebar-peek in the product this mirrors**)…" | Dock pattern exists; comment proves the peek model was already being mirrored informally. |
| Page tabs | grep `openPages\|pageTabs\|tabStrip\|TabStrip\|workspaceTabs` over `src/**` → **0 hits**; `sessionStorage` → **0 hits** in all of `src/` | **Absent.** |
| What "tabs" means today | `src/components/sidebar.tsx:75` `const [tab, setTab] = useState<"home" \| "chat" \| "meetings">("home")` (+ render `:170`, `:223`, `:227`); matrix row 578 "Sidebar navigation ✅ Tabs (Home/Chat/Meetings)" | Sidebar panel switch, resets to `home` every load; **not** page tabs. |
| View-tab persistence precedent | `database-view.tsx:146-173` — `const viewStorageKey = \`noema:active-view:${databasePageId}\``, restored in an effect "so server and client HTML stay identical", written by `selectView`, `try/catch` for private mode | **The pattern to copy** for session-persisted page tabs. |
| Back/forward | grep `router\.back\|history\.back\|pushState\|popstate\|window\.history` over `src/**` → **0 hits**; only `app/w/[slug]/cycles/page.tsx:50` and `app/w/[slug]/trash/page.tsx:30` "Back to {workspace.name}" links | **Absent** — matrix row 584 "🧭 Planned; router-driven" is accurate. |
| URL deep-link precedent | `src/components/workspace-shell.tsx:58-68` — `searchParams.get("chat")` → `setChatOpen(true)`, commented "`?chat=<threadId>` deep-links a conversation… so a discussion is addressable" | **The pattern to copy for `?peek=`.** Only `useSearchParams` site in `src/`. |
| Global keybindings | `workspace-shell.tsx:81-90` — one listener: `(metaKey \|\| ctrlKey) && key === "k"` → `setQuickOpen`; the only `metaKey\|ctrlKey` match in `src/**` besides a synthetic dispatch | One ad-hoc global binding; no scope stack, no registry. |
| Synthetic shortcut dispatch | `src/components/page-title.tsx:221-236` `undoEditor()` fires `new KeyboardEvent("keydown", { key: "z", ctrlKey: true })` at `.ProseMirror` | Workaround pattern — shortcuts are *simulated*, not registered. |
| Shortcut labels (menu) | `src/lib/actions-menu.ts:50` `ctrl+alt+l`, `:65` `ctrl+d`, `:74` `ctrl+shift+p`, `:156` `ctrl+z`; renderer `:280` `formatShortcut` | Labels are display-only strings in the Actions menu model (B11's file). |
| Command palette | `src/components/command-palette.tsx` → **NOT PRESENT** at audit time; a command palette is being written in parallel | **B43 owns it — this spec designs around it.** |
| Quick find (predecessor of palette) | `src/components/quick-find.tsx` (mtime **2026-10-14 19:53**, 4.7 KB) — `cmdk` `Command` + Radix `Dialog`, `quickFindAction`, create-page item; mounted at `workspace-shell.tsx:157-161`; opened by `?`/footer (`sidebar.tsx:130-134`, `sidebar/sidebar-footer.tsx:87-88`); e2e `e2e/search.spec.ts:156,167` presses `Control+k` | Exists, **e2e-locked to Ctrl+K**; B43 extends it. |
| Breadcrumb — header | `src/components/page-title.tsx:324-328` — `<nav aria-label="Breadcrumb">` with exactly two **static `<span>`s** (`workspaceName / title`), no links, no ancestors, no popover | **Partial** (matrix row 580 🟡 "renders; interactions partial"). |
| Breadcrumb — data | `src/server/queries.ts:403-424` `getAncestorTrail(workspaceId, pageId)` walks `parentId` up to `guard < 50`, workspace-scoped; consumed by `src/app/w/[slug]/[pageId]/page.tsx:53-56` → `:181` `breadcrumbTrail` | Full trail is computed on every page load — **and then only handed to the editor**, not the header. |
| Breadcrumb — in-doc block | `src/components/editor/extensions/breadcrumb.tsx:26-56` (atom `block` node, `setBreadcrumb` inserts it) and `:58-75` view rendering **clickable ancestor `<a>`s** (`:69`) + empty state `:63-64`; inserted via `slash-menu.tsx:73` ("Breadcrumb — Parent page trail") | Interactive crumbs exist — but only as a block the user must manually insert into the document. |
| Sidebar collapse | `workspace-shell.tsx:106-110` sidebar wrapper: `sidebarOpen ? "block" : "hidden md:block"`; `:94-104` mobile menu button; `:130-137` full-screen scrim `button` (`bg-black/40 md:hidden`); no `collapse/Collapsed/toggleSidebar` state anywhere; sidebar panel width never persists | **Mobile drawer only.** On `md+` the sidebar is permanently visible; there is no desktop collapse and no `Ctrl+\` binding (matrix row 590 = B43's). |
| Tree expand state | `sidebar.tsx:70-72` `useState(() => new Set(root ids))`, `page-tree.tsx:63-64,122,153,169`; **no `localStorage`** in `sidebar.tsx` | Resets every load — matrix row 581 🟡 "state persistence partial" is accurate. |
| Autosave (tabs must flush it) | `src/components/editor/page-editor.tsx:100` `saveTimer`, `:134-143` `persist` → 600 ms `setTimeout(runSave)`, `:107-118` `runSave` → `updatePageAction`, `:378` `onUpdate` hook; file is 511 lines post-B06 | Tab switching/closing has an unsaved-content hazard (≤600 ms window) — R29.17. |
| Reusable primitives | `src/components/ui/dialog.tsx:4` wraps `@radix-ui/react-dialog` (focus trap free); `ui/kbd.tsx` (`<Kbd>` chip); `cmdk` installed; `DocRenderer` at `src/components/doc-renderer.tsx:286` (read-only renderer, `:7` comment) | Drawer, key chips and read-only preview can all reuse what is already installed. |

### 2.2 What the product class (Notion & peers) does

1. **Side peek for pages and database rows** — a right-hand drawer over the
   list, resizable, closed with Escape/back or the X, **addressable in the URL**
   (Notion's `?p=<id>`-style peek state), with an "Open as full page" escape
   hatch; the list behind stays usable.
2. **Back/forward** — Notion leans on browser history (peek and modal states
   are history entries); peers that ship in-app buttons (Linear, GitHub, VS
   Code web) expose both buttons and `Alt+←/→`-class shortcuts.
3. **Tabs** — Notion web has no tab strip (deliberate single-document model);
   the matrix calls tabs "optional UX", so the reference class is
   browser-like/VS Code: session-restored strip, close/middle-click, numbered
   activation, per-tab history.
4. **One shortcut map** — every binding is data, surfaced in menus as right
   -aligned `Kbd` chips and in a single "Keyboard shortcuts" sheet; no
   hardcoded key literals in components.

### 2.3 Gaps this spec closes (G-numbers feed §4)

- **G1 — peek is not a product feature.** It exists only for database rows,
  only as component state (`database-view.tsx:138`), so matrix rows 583 and 234
  cannot flip while the drawer is one component's private `useState`.
- **G2 — peek is unreachable and undismissable by keyboard.** Hover-only
  trigger (`view-renderers.tsx:236`), no Escape (`database-view.tsx` has no
  `Escape` match), no focus return, no `role` semantics.
- **G3 — peek is not addressable.** No URL param, so refresh/share/back lose
  it — while the app already has the `?chat=` precedent
  (`workspace-shell.tsx:60-68`).
- **G4 — no page tabs at all** (§2.1: 0 hits) and no persistence layer for
  them (`sessionStorage` unused in `src/`).
- **G5 — no back/forward** (0 hits for every history API) → matrix row 584.
- **G6 — breadcrumbs are split-brained**: full ancestor trail is computed
  (`queries.ts:403-424`) but the header renders two static crumbs
  (`page-title.tsx:324-328`); interactivity lives in an opt-in document block
  (`breadcrumb.tsx:58-75`).
- **G7 — no desktop sidebar collapse and no state persistence** for the sidebar
  or tree (`workspace-shell.tsx:106-110`, `sidebar.tsx:70-72`) — audit-only
  here; the `Ctrl+\` binding row (590) is B43's.
- **G8 — no shortcut registry.** Bindings live in a shell `useEffect`
  (`workspace-shell.tsx:81-90`), a synthetic event (`page-title.tsx:221-236`)
  and TipTap; labels live in a menu model (`actions-menu.ts:50-156`). Nothing
  prevents two changes from binding the same combo — hence the explicit
  ownership table in §7.3.
- **G9 — planned shortcut rows collide with the browser.** Matrix row 587
  proposes `Cmd/Ctrl+P` for quick find and row 588 proposes `Cmd/Ctrl+N` for
  new page, but in Chromium `Ctrl+P` is the print dialog and `Ctrl+N` opens a
  new window — both are browser-owned and never reach the page; `Ctrl+D`
  (row 593 duplicate block, also `actions-menu.ts:65`) is bookmark-this-page.
  Recorded here for B43's awareness; **their cells are not edited by this
  change** (§13).

## 3. Decision

### 3.1 Side peek: one shared drawer, URL-driven

| Option | Fit | Verdict |
| --- | --- | --- |
| **Extract the existing `<aside>` into a shared `SidePeek` shell driven by `?peek=`** (reuse `?chat=` deep-link precedent, `ui/dialog.tsx` for the mobile full-sheet variant, `DocRenderer` for content) | Keeps the proven visual language (`fixed inset-y-0 right-0 w-[26rem]`), lets the database view delete ~80 lines instead of growing, makes peek shareable/refreshable/back-navigable in one change. | **Chosen.** |
| Keep per-component peeks (database only), add params per caller | Each surface re-solves Escape, focus, URL and history; matrix row 583 ("Side peek", general) stays 🧭 forever. | Rejected — this is how G1 happened. |
| Render peek as a Radix **modal** dialog | Blocks the list behind it, contradicts "preview without leaving the list", and collides with B45's modal-trap work. | Rejected — non-modal drawer; modal only for the mobile full-sheet fallback. |
| Open peek as a route (`/w/slug/page/peek`) | Extra server render per peek, loses list scroll, slower. | Rejected — client state + URL param. |

### 3.2 Tabs: client-side strip over the existing router (sequential, not parallel)

Notion-class content is one live TipTap document per page; Next.js App Router
cannot mount two `page.tsx` trees side by side without parallel routes + two
editor instances (autosave, collab rooms and presence would double). Decision:
**tabs are sequential** — the strip holds N entries, exactly one route is
mounted at a time, switching = `router.push` + scroll restore + autosave flush.
This keeps every existing route, permission check and e2e green and is the same
model browsers themselves use (one active tab per window).

### 3.3 Persistence: `sessionStorage`, keyed like the view-tab precedent

The requirement is *session-persisted* → `sessionStorage["noema:tabs:<slug>"]`
(follows `database-view.tsx:150-173`: namespaced key, restore in an effect to
keep server/client HTML identical, `try/catch` for private mode). `localStorage`
is explicitly deferred (O29.1).

### 3.4 Shortcut map: one pure registry, with a hard ownership column

`src/lib/shortcuts.ts` is data + a scope resolver; it does **not** rebind
anything B43 or B11 owns. §7.3's table is the single source of truth for who
owns which combo, and the registry's unit test fails if B29 adds a combo
already claimed elsewhere or reserved by the browser (G8/G9).

**Boundary with B43** (running; `command-palette.tsx` absent at audit time):
B43 owns *palette behaviour* (open, fuzzy match, keyboard nav, its rows) and the
`Ctrl+K`/`Ctrl+P`/`Ctrl+N`/`Ctrl+\`/`Ctrl+D` rows in the matrix. This spec owns
**peek, tabs, back/forward** rows and the registry those features register into.
If B43's palette renders a shortcut list, it reads this registry (R29.23) — one
list, no duplicated literals.

## 4. Requirements (numbered, testable, with acceptance)

### Side peek

- **R29.1 — Shared drawer shell.** A reusable `src/components/side-peek.tsx`
  renders the right-side drawer (`fixed inset-y-0 right-0`, default `26rem`,
  resizable `20rem–40rem`, `z-40`, non-modal: the list behind stays
  scrollable and clickable) and replaces the inline `<aside>` block in
  `database-view.tsx:1044-1124`. Single drawer instance app-wide.
  **Acceptance:** unit RED first — pure helpers `clampPeekWidth(n)` +
  `serializePeekState({pageId,width})` (out-of-range width clamps, round-trips)
  → GREEN; e2e opens a peek from a table row and asserts the page behind is
  still scrollable (`overflow` not locked).
- **R29.2 — URL addressability.** Peek state lives in `?peek=<pageId>` on the
  current route (same mechanic as `?chat=` in `workspace-shell.tsx:58-68`).
  Opening uses `router.replace(..., { scroll: false })` for swaps and one
  `push` for the initial open; closing clears the param.
  **Acceptance:** e2e — open peek → copy `page.url()` → `page.reload()` →
  drawer re-opens on the same row; a hand-typed URL with `?peek=` opens it.
- **R29.3 — Back closes peek before leaving the page.** Because the initial
  open pushes one history entry, `page.goBack()` closes the drawer and stays on
  the route; closing via X or Escape pops that entry instead of leaving a stale
  `?peek=` behind (no history loops: open→close→open keeps ≤1 extra entry).
  **Acceptance:** unit RED — history-entry reducer (`open` pushes once,
  `reopen-other-target` replaces, `close` pops only when the top entry is the
  peek entry); e2e — open peek → Back → drawer closed, same page; 5×
  open/close → back-button reachability unchanged (bounded stack).
- **R29.4 — Keyboard dismiss + reachable trigger.** Escape closes the drawer
  (after any modal, per R29.22 scope order); focus moves into the drawer on
  open and returns to the trigger on close; the trigger is visible on
  `:focus-visible` as well as hover (today `view-renderers.tsx:236`
  `opacity-0 group-hover:opacity-100` hides it from keyboard users).
  **Acceptance:** e2e keyboard — Tab to the row trigger → Enter opens →
  `Escape` closes → focus is back on the trigger; `npm run check:a11y` green.
- **R29.5 — Content, not just properties.** Two peek kinds: (a) **database
  row** — property panel exactly as today (`database-view.tsx:1076-1123`,
  inline editors + computed read-only + "Open as page") **plus**, when the row
  has page content, a read-only preview via `DocRenderer`
  (`doc-renderer.tsx:286`); (b) **page** — read-only body via `DocRenderer`,
  ancestor crumbs (from `getAncestorTrail`, `queries.ts:403-424`), "Open as
  full page" primary action.
  **Acceptance:** e2e — peek a page from the sidebar/list: heading text visible
  while the address bar still shows the parent route + `?peek=`; peek a row:
  rename inline, reload, rename persisted.
- **R29.6 — Peek list navigation.** While the drawer has focus, `Alt+↑` /
  `Alt+↓` move to the previous/next item of the list that opened it (table
  order for databases; tree/nav order elsewhere), updating `?peek=` via
  `replaceState` (no history spam). Ends are inert (no wrap).
  **Acceptance:** unit RED — `stepPeek(list, activeId, direction)` incl. empty,
  single-item, first/last boundaries; e2e — arrows change the drawer title and
  the URL param together.
- **R29.7 — Toggle shortcut `Ctrl/Cmd+Alt+P`.** Opens the active item in peek
  or closes it. Verified collision-free today: the only modifier bindings in
  `src/**` are `workspace-shell.tsx:83` (`Ctrl+K`) and a synthetic `Ctrl+Z`
  (`page-title.tsx:231`). Suppressed while focus is in an editable field.
  **Acceptance:** e2e — press `Control+Alt+p` on a focused row → drawer opens;
  again → closes; inside the editor's text it does nothing.
- **R29.8 — One drawer, swap-not-stack.** Opening another object while a peek
  is open replaces content and the URL param (`replace`, R29.3); only one
  drawer ever mounts; closing restores focus to the original trigger (or the
  nearest list container if the item unmounted).
  **Acceptance:** unit (state reducer, R29.3 test file); e2e — peek row A →
  peek row B → one `<aside role="dialog">` in DOM, URL shows B.
- **R29.9 — Semantics & i18n.** Drawer: `role="dialog"`,
  `aria-modal="false"`, accessible name from the i18n catalogue
  (`rowLabel`/`openSidePeek` already exist, `i18n.ts:455`), trigger carries
  `aria-expanded`; **all** new strings go through `t()` in all 5 locales via
  the i18n key inserter (no hand-edits). New client files using `t()` may
  only *raise* the coherence `i18nFiles` ratchet (`check-coherence.mjs:26,82-84`
  — growth allowed, shrink fails).
  **Acceptance:** locale key-parity unit test stays green; `check:coherence`
  COHERENT; `check:a11y` green.

### Back / forward navigation

- **R29.10 — In-app back/forward controls.** A new
  `src/components/nav-history.tsx` (buttons with `aria-label`s from `t()`,
  disabled states when at the ends) is mounted by **`workspace-shell.tsx`** —
  not `page-title.tsx`, which belongs to B11 — at the top-left of the content
  column, visually paired with the breadcrumb slot.
  **Acceptance:** unit RED — pure stack model `push/replace/back/forward/
  canBack/canForward` (bounds, replace-no-grow, forward cleared on push);
  e2e — navigate A → B → C, click back ×2 → A, forward → B.
- **R29.11 — Shortcuts `Alt+Shift+←` / `Alt+Shift+→`.** Deliberately **not**
  `Alt+←/→` (browser-owned back/forward on Windows/Linux/macOS — reserved list
  §7.3). Suppressed when focus is in a text field/editor or a modal is open.
  **Acceptance:** unit — scope predicate (`isEditable(el)`, modal-open flag)
  RED→GREEN; e2e — keyboard back/forward changes route; typing `Alt+Shift+←`
  inside the editor does not navigate.
- **R29.12 — Single source of truth = browser history.** The in-app Back button
  calls `history.back()`; the per-app stack mirrors entries the app itself
  created (`router.push` route changes, R29.2's peek entry), so browser Back,
  browser Forward and the buttons always agree. Manual `pushState` is
  forbidden outside the peek param (raw calls desync the App Router); max 50
  entries per session with drop-oldest.
  **Acceptance:** unit — stack model (`R29.10`) asserts `replace` never grows
  the stack and 51 pushes keep 50; e2e parity — `page.goBack()` and the button
  leave the app in identical URL+DOM state.
- **R29.13 — Per-tab history.** When tabs ship (M3), each tab owns its own
  stack/cursor (§5); until then there is exactly one stack.
  **Acceptance:** unit — two stacks are independent (back in tab A does not
  move tab B's cursor); e2e (M3) — back in tab 1, switch to tab 2, back still
  refers to tab 2's own history.

### Multi-tab pages (session-persisted)

- **R29.14 — Tab strip.** `workspace-shell.tsx` renders a strip above `<main>`
  (`:139-142`) with one entry per open page (favicon/icon + truncated title +
  close `×`, `aria-current` on the active tab, `role="tablist"`); it is
  **hidden while only one tab exists**, so today's layout — and every existing
  e2e — is unchanged until a second tab is opened. Cap **8 tabs**; opening a
  9th replaces the least-recently-used with a toast.
  **Acceptance:** unit RED — tab reducer `openTab/dedupeByRoute/activate/close/
  lruEvict` (dedupe returns existing tab, LRU order, cap enforced); e2e — open
  a second tab → strip appears; close back to one → strip hides.
- **R29.15 — Session persistence.** Tabs persist in
  `sessionStorage["noema:tabs:<workspaceSlug>"]`, written on every change and
  restored in an effect **after hydration** (mirroring `database-view.tsx:
  146-164`: "restored in an effect … so server and client HTML stay
  identical"); malformed/oversized (>16 KB) entries are discarded silently
  (same defensive posture as `parseViewConfig`, `database-view.tsx:179-180`);
  nothing is stored server-side.
  **Acceptance:** unit RED — `decodeTabs(raw)` JSON/garbage/over-cap/unknown-
  shape cases; e2e — open 2 tabs → reload → both tabs and the active one
  restored; a **second browser context** starts with an empty strip
  (sessionStorage isolation).
- **R29.16 — Activation restores route + scroll.** Activating a tab
  `router.push`s that tab's route and restores its last scroll offset
  (saved on scroll, rAF-throttled, and on tab switch) after paint; a route
  change updates only the active tab's entry.
  **Acceptance:** e2e — scroll down on page A, switch to tab B, switch back →
  scroll offset within ±50 px; switching does not re-open the drawer or lose
  the strip.
- **R29.17 — Close semantics flush pending autosave.** Closing a tab (×,
  middle-click, `Ctrl+Alt+W`) first flushes the editor's 600 ms debounced save
  (`page-editor.tsx:100,134-143`) — a `flushSave` handshake the editor slot
  exposes, also fired on `pagehide`/`visibilitychange`; then activates the
  most-recently-used neighbour. Closing the last tab leaves one current tab
  (strip hides). Content typed <600 ms before a close must survive.
  **Acceptance:** unit RED — flush-guard state machine (close requested while a
  timer is pending → flush → then close); e2e — type into the editor, close the
  tab immediately, reopen within 1 s, text present (this is the test that would
  fail without the flush).
- **R29.18 — Tab keyboard map (B29-owned).** `Alt+1`…`Alt+9` activate tab N;
  `Alt+PageUp` / `Alt+PageDown` cycle prev/next; `Ctrl+Alt+T` opens the current
  page as a new tab; `Ctrl+Alt+W` closes the active tab. None is
  browser-reserved (§7.3) and none is claimed by B43.
  **Acceptance:** unit — registry test asserts these four combos are unique,
  not reserved, and scope `tabs`; e2e — each of the four performs its action.
- **R29.19 — Navigation semantics inside a tab.** Normal sidebar/link
  navigation replaces the **active tab's** route (no tab explosion from inside
  the app); the native "open in new browser tab" paths (Ctrl/Cmd+click,
  middle-click on links, `Open as page`/`Open in new tab` menu items) keep
  working untouched because they are browser-level. Peek state (`?peek=`) is
  stored per tab and restored with it.
  **Acceptance:** e2e — navigate inside tab 1 → still one tab, route updated;
  `Control+click` a tree link → a new **browser** context/tab opens (asserted
  via `context.on('page')` or skipped honestly if the harness forbids it).
- **R29.20 — Per-tab history stacks.** Each tab entry owns its own back/forward
  stack and cursor (implements R29.13); switching tabs swaps both route and
  cursor; closing a tab discards its stack.
  **Acceptance:** unit — `stacksPerTab` model; e2e — back twice in tab 1,
  switch to tab 2, its Forward is at its own start (buttons disabled) while
  tab 1's cursor is unchanged.

### Shortcut map (registry — B29 rows only)

- **R29.21 — One registry, pure data.** New `src/lib/shortcuts.ts` exports the
  map: `{ id, combo, scope: "global"|"editor"|"peek"|"tabs", labelKey (i18n),
  owner: "B29"|"B43"|"B11"|"core", browserReserved?: true }`. **No binding is
  added for combos owned by B43/B11 or marked `browserReserved`.**
  **Acceptance:** unit RED first — invariants: (a) no duplicate `combo` within
  a scope, (b) no registered entry is `browserReserved`, (c) every B43/B11
  entry in §7.3 exists with its `owner` unchanged (locks the boundary),
  (d) every `labelKey` resolves in all 5 locales → GREEN after implementation.
- **R29.22 — Scope-ordered dispatch.** One dispatcher (not N growing window
  listeners as in `workspace-shell.tsx:81-90`) resolves keypresses topmost
  first: **modal → peek → editor → tabs → global**; the first matching scope
  handles and stops; `Escape` follows the same order (closes topmost overlay
  only — this is what makes R29.4 and B45's modal traps coexist).
  **Acceptance:** unit RED — `resolveShortcut(event, activeScopes)` matrix:
  modal open + peek open + Escape → modal wins; peek focus + `Alt+↑` → peek;
  editable focus + global combo → suppressed; GREEN.
- **R29.23 — Rendered from the registry.** Right-aligned shortcut hints use
  `<Kbd>` (`ui/kbd.tsx`) formatted by `formatShortcut` semantics
  (`actions-menu.ts:280`) but sourced from the registry; if B43's palette (or
  a future help sheet) lists shortcuts, it maps over this registry — **no
  component hardcodes a combo literal** for B29-owned rows.
  **Acceptance:** unit — every B29 entry has a `labelKey` + formatter output
  (e.g. `ctrl+alt+p` → `Ctrl+Alt+P` on non-mac, `⌘`-form flagged for i18n);
  lint-level spot check in review: no new `"ctrl+"` literals outside
  `src/lib/shortcuts.ts` (grep evidence).
- **R29.24 — Collision gate stays on.** The registry test additionally fails
  if a B29 combo equals any combo in B43's or B11's claimed set (§7.3) or a
  browser-reserved combo (`Ctrl+T/W/N/Tab/PageUp/PageDown/1-9`,
  `Ctrl+Shift+T`, `Alt+←/→`, `Alt+Home`, `Alt+Backspace`, `Ctrl+P`, `Ctrl+D`,
  `Ctrl+R/F5`) — so G9-style rows can never be implemented silently.
  **Acceptance:** unit (same file as R29.21) asserts the reserved list is
  enforced by adding a deliberately reserved combo → RED → removed → GREEN
  (negative-control evidence).

### Cross-cutting

- **R29.25 — Docs-only this change.** B29 changes no `src/**`, `e2e/**` or
  schema file; implementation lands in M1–M3 work that inherits this
  document's requirement IDs.
  **Acceptance:** `git status` shows only `docs/specs/navigation-ux.md` and the
  four matrix Notes cells for this change; `check:coherence` COHERENT.
- **R29.26 — No-regression envelope.** Every M1–M3
  step keeps `check:tsc` 0, eslint 0 errors, unit green, `check:a11y` green,
  coherence COHERENT, and the existing suites green — especially
  `e2e/search.spec.ts:156` (Ctrl+K quick find), the database-parity specs that
  exercise the current peek panel, and `e2e/noema.spec.ts` (editor slot, never
  edited here).
  **Acceptance:** evidence recorded per step; a targeted
  `npx playwright test -g "peek|tab|history"` run on dev `:3201` in M1.

## 5. State model & storage (no schema change)

```ts
// sessionStorage — per browser session, per workspace (R29.15)
"noema:tabs:<workspaceSlug>" -> JSON.stringify({
  v: 1,                        // version tag; unknown -> discard
  active: "t3",
  tabs: [{ id, href, title, icon, peek: string|null, scrollY, lastActive }]
})                             // cap 8 entries / 16 KB

// localStorage — drawer geometry only (R29.1)
"noema:peek-width" -> "416"   // px, clamped 320..640 on read

// URL — the addressable parts (R29.2, R29.16)
/w/<slug>/<pageId>?peek=<pageOrRowId>     // peek target (precedent: ?chat=)
```

- **Per-tab history stacks** (R29.13/R29.20) are in-memory only — never
  persisted; losing them on reload is correct (the browser owns reload
  navigation).
- **Nothing new in Prisma.** Tabs, peek and history are presentation state;
  authorization continues to flow from the existing route guards
  (`page.tsx:38-51`), which is also why peeking a foreign-workspace id must
  render "not found", never a leak (same invariant as `page.tsx:44-46`).

## 6. Contracts

```ts
// src/lib/shortcuts.ts (R29.21) — pure, no React
export type Scope = "global" | "editor" | "peek" | "tabs";
export type Shortcut = { id: string; combo: string; scope: Scope;
                         labelKey: string; owner: "B29"|"B43"|"B11"|"core";
                         browserReserved?: boolean };
export const SHORTCUTS: Shortcut[];
export function resolveShortcut(ev: KeyEventLike, active: Scope[]): Shortcut | null;
export function formatCombo(combo: string, platform: "mac"|"other"): string;

// src/components/side-peek.tsx (R29.1, R29.5)
<SidePeek target={{ kind: "row" | "page"; id: string }}
          list={readonly { id: string }[]} onStep={(dir) => void}
          onOpenFullPage={(id) => void} onClose={() => void} locale={string} />
// mounted ONCE by the surface that owns the list (database-view keeps its
// properties/editors as the drawer's children or a render-prop) — the shell
// owns URL sync, focus, Escape, width; the surface owns content.

// src/components/nav-history.tsx (R29.10) — mounted by workspace-shell
<NavHistory locale={string} />   // reads the shared history store

// src/components/tabs/*.tsx (R29.14) — mounted by workspace-shell above <main>
<TabStrip tabs={Tab[]} activeId={string} onActivate onClose onReorder />

// editor flush handshake (R29.17) — editor-slot owned implementation detail:
// window.dispatchEvent(new CustomEvent("noema:flush-save")) -> page-editor's
// runSave() (page-editor.tsx:107-118) resolves before the tab closes.
```

- **Peek ↔ history**: the shell subscribes to route changes; the drawer's
  open/close is derived from `?peek=` (state *follows* the URL — R29.2/R29.3
  fall out structurally instead of being special-cased).
- **i18n**: new keys are inserted by the i18n key inserter only
  (5 locales, parity test), never by hand.

## 7. UI spec

### 7.1 Side-peek drawer

- Geometry: `fixed inset-y-0 right-0 z-40 border-l border-border bg-bg
  shadow-2xl`, default `26rem`, drag-resize handle on the left edge
  (`cursor-col-resize`, width persisted per R29.1), `w-full` full-sheet on
  `<md` (rendered through `ui/dialog.tsx` there so the mobile variant gets
  Radix's trap for free — B45 stays owner of the trap itself).
- Header: kind label (`rowLabel`/`Page preview`), `Open as full page` link,
  resize handle, `X` close (`closeSidePeek` key exists).
- Body: R29.5 content; footer for rows: `Open as page` (existing
  `view-renderers.tsx:237-244` affordance reused).
- Motion: `translate-x` slide-in, 150–200 ms, gated on
  `prefers-reduced-motion` (ties matrix row 606's intent; no new ratchet).
- Interaction: page behind stays interactive (non-modal); no scrim on `md+`;
  on mobile, dim scrim + sheet.

### 7.2 Tab strip

- Location: `workspace-shell.tsx` between the topbar area and `<main>`
  (`:139`); 36 px tall, horizontal scroll, active tab = `bg-surface` +
  `aria-current="page"`; hover reveals `×`; middle-click closes; dirty state
  (pending autosave) shows a dot until flushed (R29.17).
- Hidden at exactly one tab (R29.14) — the default state, hence zero visual
  change for the existing 60+ e2e tests.
- Empty/limit states: LRU replacement toast at 8 tabs; "reopen closed tab"
  deliberately out of scope (O29.3).

### 7.3 Shortcut map (ownership table — the anti-collision artifact)

**Existing / owned by others — recorded, NOT edited by this change:**

| Combo | Action | Evidence | Owner |
| --- | --- | --- | --- |
| `Ctrl/Cmd+K` | Open Quick find → B43 palette | `workspace-shell.tsx:81-90`; e2e `search.spec.ts:156,167` | **B43** |
| `Ctrl/Cmd+P` | Quick find (matrix row 587 — *browser-reserved risk, see G9*) | `FEATURE_MATRIX.md:587` | B43 (row untouched) |
| `Ctrl/Cmd+N` | New page (row 588 — *browser new-window risk, G9*) | `FEATURE_MATRIX.md:588` | B43 (row untouched) |
| `Ctrl+\` | Toggle sidebar (row 590; no desktop collapse exists — §2.1) | `FEATURE_MATRIX.md:590` | B43 (row untouched) |
| `Ctrl/Cmd+D` | Duplicate page / duplicate block (rows 593, Actions menu — *Chromium reserves `Ctrl+D` for bookmark, G9*) | `actions-menu.ts:65`; `FEATURE_MATRIX.md:593` | B43/B11 (rows untouched) |
| `Ctrl+Alt+L`, `Ctrl+Shift+P`, `Ctrl+Z` | Copy link / Move to / Undo | `actions-menu.ts:50,74,156`; `page-title.tsx:221-236` | B11 |
| `Ctrl+B/I/U`, `Alt+↑/↓`, `/` | Formatting / block move / slash menu | matrix rows 591, 592, 595 (✅) | core/editor |
| `Escape` | Close topmost overlay | many (see scope order) | B29 defines order (R29.22), B45 owns modal traps |

**B29-owned (this spec, matrix rows 583-585 only):**

| Combo | Action | Scope | Requirement |
| --- | --- | --- | --- |
| `Ctrl/Cmd+Alt+P` | Toggle side peek | global (not in editable) | R29.7 |
| `Escape` | Close topmost (modal → peek → menus) | ordered | R29.4, R29.22 |
| `Alt+↑` / `Alt+↓` | Peek previous / next item | peek (focused) | R29.6 |
| `Alt+Shift+←` / `Alt+Shift+→` | Back / forward | global (not editable/modal) | R29.11 |
| `Alt+1`…`Alt+9` | Activate tab N | tabs | R29.18 |
| `Alt+PageUp` / `Alt+PageDown` | Previous / next tab | tabs | R29.18 |
| `Ctrl+Alt+T` | Open current page as new tab | tabs | R29.18 |
| `Ctrl+Alt+W` | Close active tab | tabs | R29.18 |

**Never bind (browser-owned):** `Ctrl+T`, `Ctrl+W`, `Ctrl+N`, `Ctrl+Tab`,
`Ctrl+PageUp/PageDown`, `Ctrl+1…9`, `Ctrl+Shift+T`, `Ctrl+P`, `Ctrl+D`,
`Ctrl+R`/`F5`, `Alt+←/→`, `Alt+Home`, `Alt+Backspace`, `Alt+F4`. (Enforced by
R29.24's test.)

### 7.4 Breadcrumb & sidebar (audit-only — no rows edited here)

- **Header breadcrumb (row 580, 🟡):** the trail is already fetched
  (`page.tsx:53-56`) but the header shows two static crumbs
  (`page-title.tsx:324-328`). The low-risk fix — render ancestors as links
  using `breadcrumbTrail` — touches `page-title.tsx`, **owned by B11**,
  so it is recorded as a follow-up (O29.4), not specified as a B29
  requirement. The interactive-crumb implementation to mirror already exists in
  `breadcrumb.tsx:58-75`.
- **Sidebar collapse (rows 581/590):** no desktop collapse exists
  (`workspace-shell.tsx:106-110`) and tree/tab state resets every load
  (`sidebar.tsx:70-75`). The collapse *shortcut* row is B43's; a collapse
  *state* feature would need shell ownership coordination — out of B29 scope,
  listed in MISSING_FEATURES terms as a known gap (G7).

## 8. Edge cases

| Edge | Behavior |
| --- | --- |
| `?peek=` targets a trashed/deleted/foreign-workspace id | Drawer shows the same "not found" empty state the route shows (`page.tsx:44-51` guards still run first); no existence oracle, no crash. |
| Peek open → user edits a row → switches tab | Row edit is an action call (already server-persisted via `setValue`); tab switch only flushes the **editor** debounce (R29.17); nothing client-only is lost. |
| Reload while peek open | R29.2: drawer re-opens from the URL; width restored from `noema:peek-width`. |
| Browser Back with 2 tabs active | R29.13: Back acts on the active tab's stack only; switching tabs swaps stacks. |
| sessionStorage disabled (private mode) | `try/catch` like `database-view.tsx:166-172`: tabs still work for the session, just not restorable; no crash. |
| >8 tabs requested | LRU eviction + toast (R29.14); never silently drops the *active* tab. |
| Tab close while `runSave` in flight | Flush handshake (R29.17); if the save rejects, the tab closes but the error toast already surfaced via `safeAction` (`page-editor.tsx:118`). |
| Editor focused + `Alt+↑` | Editor's block-move wins (scope order R29.22: editor above peek only when the editor has focus; peek arrow keys require drawer focus). |
| Modal open (share dialog, Actions menu) + `Escape` | Modal closes; peek/global do not act (topmost-first). |
| Collab mode (opt-in, `realtime-collab.md`) + tab switch | Two tabs = two clients on possibly the same room — allowed (same as two browser tabs today); the flush handshake is irrelevant there because collab persistence is server-owned (R9.11 of that spec). |
| Reduced motion / RTL | Slide-in disabled under `prefers-reduced-motion`; drawer uses logical `border-inline-end`/`inset-inline-end` so Arabic flips it (matrix row 602). |

## 9. Test plan

**Unit (vitest, red-first — pure libs first, the sandbox rule)**

1. `src/lib/peek-url.test.ts` — `clampPeekWidth`, `serialize/deserializePeek`
   round-trip, malformed input (R29.1, R29.2).
2. `src/lib/nav-history.test.ts` — stack model: push/replace/back/forward/
   bounds/50-cap/per-tab independence (R29.10, R29.12, R29.13, R29.20).
3. `src/lib/tabs-state.test.ts` — reducer (open/dedupe/activate/close/LRU/cap)
   + `decodeTabs` garbage/over-cap/version-mismatch (R29.14, R29.15).
4. `src/lib/shortcuts.test.ts` — registry invariants + **negative control**:
   inserting a `browserReserved` combo must fail the test (R29.21, R29.24);
   scope resolution matrix (R29.22).
5. Flush-guard state machine (R29.17) and `stepPeek` boundary math (R29.6).

**e2e (Playwright — new own file `e2e/navigation-ux.spec.ts`, dedicated
prisma-created pages + `try/finally` cleanup; targeted `-g` runs on dev `:3201`
in targeted mode; never edits `e2e/noema.spec.ts` or `e2e/search.spec.ts`)**

6. Peek: open from row → URL has `?peek=` → reload re-opens → Escape closes →
   focus restored (R29.2, R29.4).
7. Peek history: open → `page.goBack()` closes drawer, same route (R29.3).
8. Page peek content: heading visible in drawer while parent route stays
   (R29.5).
9. Back/forward buttons + `Alt+Shift+←/→` (R29.10, R29.11) with an editable
   focused negative case.
10. Tabs: second tab reveals strip; reload restores; close flushes typed text;
    `Alt+2` activates; strip hides at one tab (R29.14-R29.18).
11. Non-regression: `npx playwright test -g "Ctrl"` (search spec's `Ctrl+K`)
    stays green (R29.26).

**Gates (docs-only):** `check:tsc`, `check:lint`, unit baseline unchanged,
`npm run check:coherence` → **COHERENT**. No build, no full e2e (FAST tier,
). Implementation adds `check:a11y` and
targeted e2e per slice.

## 10. Milestones (M1–M3)

1. **M1 — Side peek** (R29.1–R29.9): shared shell + `?peek=` + keyboard/a11y +
   content preview. Delivers matrix rows 583 and 234 (Notes already appended by
   this change; glyph flips land with the code).
2. **M2 — History + registry** (R29.10–R29.13, R29.21–R29.24): stack model,
   nav buttons, `Alt+Shift+←/→`, `src/lib/shortcuts.ts` with the collision
   gate. Delivers row 584.
3. **M3 — Tabs** (R29.14–R29.20): reducer + strip + persistence + scroll
   restore + flush handshake (coordinates with the editor slot) + per-tab
   history. Delivers row 585.

Milestones are sequenced so each ships independently (one row flips per
milestone) and so M3's editor flush handshake lands **after** the current phase
releases `page-editor.tsx` (see Risk 1).

## 11. Delivery plan (tasks ↔ requirements)

> Test-first rule: every task's acceptance is a
> red test citing its requirement IDs **before** implementation.

**M1 — Side peek (~1.5 days)**

- T29.1 [R29.1, R29.9] Extract `side-peek.tsx` shell from
  `database-view.tsx:1044-1124`; database view becomes a consumer. Red: unit 1
  + e2e 6 skeleton.
- T29.2 [R29.2, R29.3, R29.8] URL sync + history entry discipline. Red: unit 1
  (reducer) + e2e 7.
- T29.3 [R29.4, R29.6, R29.7] Escape/focus return, `focus-visible` trigger,
  `Alt+↑/↓`, `Ctrl+Alt+P`. Red: e2e 6 keyboard part; unit 5.
- T29.4 [R29.5] Page-kind peek via `DocRenderer` + `getAncestorTrail` crumbs.
  Red: e2e 8.

**M2 — Back/forward + shortcut registry (~1 day)**

- T29.5 [R29.10, R29.12] `nav-history.tsx` + stack model, mounted in
  `workspace-shell.tsx`. Red: unit 2 + e2e 9.
- T29.6 [R29.11] `Alt+Shift+←/→` + editable/modal suppression. Red: unit 4
  (scope matrix) + e2e 9 negative case.
- T29.7 [R29.21, R29.22, R29.23, R29.24] `src/lib/shortcuts.ts` + dispatcher;
  wire B29 combos only; `<Kbd>` hints from the registry. Red: unit 4 incl.
  negative control.

**M3 — Tabs (~2 days)**

- T29.8 [R29.14, R29.15] Reducer + `sessionStorage` codec + strip UI in
  `workspace-shell.tsx`. Red: unit 3 + e2e 10.
- T29.9 [R29.16, R29.19] Activation = `router.push` + scroll save/restore;
  nav-in-tab replaces active route. Red: e2e 10.
- T29.10 [R29.17] Flush handshake with the editor slot (`pagehide` +
  close-path), dirty dot. Red: unit 5 + the close-within-600 ms e2e.
- T29.11 [R29.18, R29.20] Tab keyboard map from the registry + per-tab
  stacks. Red: unit 2 (per-tab) + e2e 10.

**Exit criteria per milestone:** `tsc` 0, eslint 0 errors, unit green (new
tests cited), targeted `npx playwright test -g` on dev `:3201` green,
`check:a11y` green, `check:coherence` COHERENT, matrix glyph flipped for the
rows that milestone actually delivered (Notes already contain the spec path —
do not re-append), evidence recorded in the pull request.

## 12. Risks & open questions (honest)

**Risks**

1. **Editor-slot coupling (highest for M3).** R29.17 needs a flush hook in
   `page-editor.tsx` — the editor slot is committed to concurrent suites (B18
   this phase; `e2e/noema.spec.ts` is editor-owned). Mitigation: the handshake is
   a `CustomEvent` the editor already has the pieces for
   (`runSave`, `page-editor.tsx:107-118`); if the slot is busy, M3 ships with
   the `pagehide` flush only and an honest partial on row 585's persistence
   note.
2. **App-Router/history desync.** Mixing raw `pushState` with `router.push`
   can desync Next's router. Mitigation: only the peek param uses
   `router.replace/push` (R29.12 forbids manual `pushState` elsewhere); e2e 7
   is the tripwire.
3. **B43 moves underneath this spec.** `command-palette.tsx` did not exist at
   audit time; B43 may replace QuickFind entirely or rebind `Ctrl+K`.
   Mitigation: the registry's ownership assertions (R29.21 c) fail loudly if
   combos move, forcing an update to §7.3 instead of a silent collision; no
   B29 binding depends on QuickFind's survival.
4. **Browser-reserved shortcuts in existing rows (G9).** `Ctrl+P`/`Ctrl+N`/
   `Ctrl+D` in the matrix and in `actions-menu.ts` labels may never fire in
   Chromium. Out of B29's edit scope; flagged for B43/B11 (§7.3) — if a future
   change touches those rows, §7.3 must be updated with it.
5. **Tab strip vs. existing e2e geometry.** A strip that renders at one tab
   would shift `main` and break selector-based tests. Mitigation is structural:
   R29.14 hides it below two tabs (default state = byte-identical layout).

**Open questions**

- **O29.1:** `sessionStorage` (session-persisted) vs `localStorage`
  "restore tabs next time I open the browser". Decision: sessionStorage now;
  a per-workspace preference toggle can flip the key later without touching the
  reducer (codec already versioned).
- **O29.2:** Peek on **mobile** as full sheet (Radix modal) vs drawer —
  full-sheet chosen (R29.1) but the breakpoint behavior is a visual-review
  question, not an invariant.
- **O29.3:** "Reopen closed tab" (`Ctrl+Shift+T` is browser-owned) — deferred;
  would need `Ctrl+Alt+Shift+T` or a strip context menu. Not in M1–M3.
- **O29.4:** Header breadcrumb interactivity (G6) — needs `page-title.tsx`
  (B11's file) or a shell-level crumb component; propose follow-up work
  after B11 lands, reusing `getAncestorTrail` + `breadcrumb.tsx:58-75` styles.
- **O29.5:** Desktop sidebar collapse (G7) — pairs with B43's `Ctrl+\` row;
  needs a persisted `noema:sidebar` width/collapsed key in the shell. Recorded,
  not specified here (row 590 is B43's cell).

## 13. Traceability — FEATURE_MATRIX rows

**Rows appended by this change (Notes-only, glyph untouched, exactly four):**

| Row | Matrix line | Text after this change |
| --- | --- | --- |
| Side peek | `FEATURE_MATRIX.md:583` | `… \| 🧭 \| Planned. Spec: docs/specs/navigation-ux.md. \|` |
| Back/forward navigation | `FEATURE_MATRIX.md:584` | `… \| 🧭 \| Planned; router-driven. Spec: docs/specs/navigation-ux.md. \|` |
| Tabs for pages | `FEATURE_MATRIX.md:585` | `… \| 🧭 \| Planned; optional UX. Spec: docs/specs/navigation-ux.md. \|` |
| Open row in side peek (section 3) | `FEATURE_MATRIX.md:234` | `… \| 🧭 \| Planned; needs drawer shell. Spec: docs/specs/navigation-ux.md. \|` (row explicitly asks for the shell this spec designs) |

**Rows deliberately NOT touched (ownership):**

- **B43** — command palette (`:462`, `:608`) and every shortcut row
  (`:586`–`:593`, incl. quick find `:587`, new page `:588`, search `:589`,
  toggle sidebar `:590`, duplicate block `:593`). This spec only *records*
  their combos in §7.3 to prevent collisions and flags the browser-reservation
  risks (G9).
- **B11** — topbar/Actions rows (`:609`–`:625`).
- **Audit-only** — breadcrumbs (`:580`), page tree (`:581`), sidebar
  navigation (`:578`), focus management (`:600`, B45), reduced motion
  (`:606`): findings G6/G7 recorded in §2.3/§7.4, no cell edits.

**Requirement → milestone → row:** R29.1–R29.9 → M1 → `:583`, `:234`;
R29.10–R29.13 + R29.21–R29.24 → M2 → `:584`; R29.14–R29.20 → M3 → `:585`.
Counts/gaps regeneration stays maintainer-only.
