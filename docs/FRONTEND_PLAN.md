# Noema — Frontend Feature & Design Plan (A → Z)

> Status legend: **✅ have** · **🟡 partial / needs polish** · **⬜ to add**
> Reference: Notion's web app. Goal: **smooth** (60 fps, no layout shift, everything
> reversible) and **predictable** (same interaction everywhere).
>
> Companion doc: [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) — the tokens, the rules,
> the primitive kit (§11) and the design report (§12). This file tracks status;
> that file defines *how things look and move*.

---

## 0. Design foundations (tokens) — do this FIRST

Everything else is cheaper once the tokens exist. Colour, spacing, radius,
elevation, motion and layering live in `src/app/globals.css` +
`src/app/tokens.css` (declared for light / dark / high-contrast) and are exposed
to TSX by `src/lib/design-tokens.ts` (`Z`, `DUR`, `EASE`, `RADIUS`, `SHADOW`,
`SPACE`, `BREAKPOINT`, `TAG_HUES`).

| # | Feature | Status | Design spec |
|---|---|---|---|
| 0.1 | Colour tokens (light / dark / high-contrast) | ✅ | All landed in `tokens.css`: `--bg --sidebar --surface --surface-2/3 --border/-strong --fg --fg-subtle --muted --accent --accent-fg --accent-soft --ring --selection --danger(-fg/-soft) --success(-soft) --warning(-soft) --overlay` + the 10-hue tag palette (text/bg/border). See DESIGN_SYSTEM §2 |
| 0.2 | Typography scale | ✅ | Canonical scale is codified as Tailwind classes in DESIGN_SYSTEM §3 (`text-xs` … `text-[28px]`, tighter heading tracking). No numeric `--text-*` vars — the class names are the contract |
| 0.3 | Spacing scale | ✅ | `--space-*` in `tokens.css` (2,4,8,12,16,20,24,32,40,48,64); 4px grid. Ad-hoc `p-[13px]` is banned by §1/§10 |
| 0.4 | Radius scale | ✅ | `--radius-xs 3 / sm 4 / md 6 / lg 10 / xl 14` (+ `RADIUS.full`). Mapped in `globals.css` |
| 0.5 | Elevation | ✅ | `--shadow-1` (cards) `--shadow-2` (popover) `--shadow-3` (modal) `--shadow-focus`; soft, low-opacity, never pure black |
| 0.6 | **Motion tokens** | ✅ | durations `--dur-1 120ms / 2 180ms / 3 240ms / 4 320ms`; easings `--ease-smooth` (default), `--ease-in-out-soft`, `--ease-spring` (popovers/drag settle); named `--animate-*` utilities. Mirrored in `design-tokens.ts` (`DUR`, `EASE`) |
| 0.7 | Iconography | 🟡 | lucide-react at 14/16/20px, `stroke-width 1.75`. Sizes not yet centrally enforced; always pair with a text label or `aria-label` |
| 0.8 | Z-index scale | ✅ | `--z-base 0 / sticky 10 / sidebar 30 / overlay 40 / popover 50 / modal 60 / toast 70 / tooltip 80 / drag 90` + `Z.*` in `design-tokens.ts` — no magic numbers |
| 0.9 | Breakpoints | ✅ | `BREAKPOINT` in `design-tokens.ts` (sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536). Sidebar: drawer < md, resizable ≥ md |
| 0.10 | Density modes | ⬜ | Comfortable / compact (row height 32/28px, font 14/13px) persisted per user |
| 0.11 | Theming API | 🟡 | light/dark/system ✅, high contrast ✅; cover gradient set ✅, page font (sans/serif/mono) ✅ partially, page width (default/wide) ✅ per page; accent picker still ⬜ |
| 0.12 | Reduced motion | ✅ | global `prefers-reduced-motion` neutraliser in `globals.css` — keep it and never regress |

---

## 1. UI primitives (the kit every screen reuses)

| # | Component | Status | Notes |
|---|---|---|---|
| 1.1 | Button (primary/secondary/ghost/danger, sm/md, loading) | ✅ | `ui/button.tsx` — `loading` + `iconOnly` landed |
| 1.2 | Input / Textarea / Field wrapper with label+error+help | ✅ | `ui/input.tsx` — `Field` ships consistent label + inline error + help |
| 1.3 | Select / Combobox (searchable) | ✅ | `ui/select.tsx` — single/multi, grouped, virtualized, tags, full keyboard |
| 1.4 | Checkbox / Radio / Switch | ✅ | `ui/checkbox.tsx` (tri-state), `ui/radio.tsx`, `ui/switch.tsx` (optimistic) |
| 1.5 | Dialog / Sheet (side panel) / Confirm dialog | ✅ | `ui/dialog.tsx`, `ui/sheet.tsx` (left/right/bottom), `ui/confirm-dialog.tsx` (type-to-confirm + two-step) |
| 1.6 | Popover / Dropdown menu / Context menu | ✅ | `ui/popover.tsx`, `ui/dropdown-menu.tsx`, `ui/context-menu.tsx` — shared item/hover/selected classes |
| 1.7 | Tooltip | ✅ | `ui/tooltip.tsx` — 500 ms delay, instant on repeat |
| 1.8 | Tabs / Segmented control | 🟡 | `ui/segmented.tsx` landed (2–6 way); a generic `Tabs` primitive is still missing |
| 1.9 | Avatar + AvatarGroup | ✅ | `ui/avatar.tsx` on `lib/avatars` (presence stack, `+N`, status ring) |
| 1.10 | Badge / Chip / Tag (selectable, closable) | ✅ | `ui/badge.tsx` (tones, count caps), `ui/tag.tsx` (removable + hues) |
| 1.11 | Card / Panel / Section header | ✅ | `ui/card.tsx`, `ui/section.tsx` |
| 1.12 | Skeleton / Spinner / Progress bar / Progress ring | ✅ | `ui/skeleton.tsx`, `ui/spinner.tsx`, `ui/progress.tsx` (bar + ring) |
| 1.13 | Toast (success/error/info/undo action) | 🟡 | `ui/toaster.tsx` has the `undo` variant + action slot; still to wire to reversible actions |
| 1.14 | Empty state (icon + title + hint + action) | ✅ | `ui/empty-state.tsx` (full/compact) |
| 1.15 | Scroll area with custom scrollbars + edge fades | ✅ | `ui/scroll-area.tsx` + `.edge-fade-*` |
| 1.16 | Date picker / Calendar popover / Time picker | ✅ | `ui/date-picker.tsx` (date/range/time/datetime + presets), `ui/calendar-grid.tsx` |
| 1.17 | Slider / Stepper (number) | ✅ | `ui/slider.tsx` (single + range), `ui/stepper.tsx` |
| 1.18 | Color picker (swatches + custom) | 🟡 | bubble toolbar has swatches; extract a primitive |
| 1.19 | Emoji picker with frecency | ✅ | `ui/emoji-picker` |
| 1.20 | Command palette | ✅ | extend with context-aware sections |
| 1.21 | Resizable split / drag handles | 🟡 | sidebar ✅; generalize for columns/panels |
| 1.22 | Virtualized list/grid | 🟡 | `lib/virtual-list`, page tree ✅; unify into a primitive |
| 1.23 | Kbd chips | ✅ | `ui/kbd.tsx` |
| 1.24 | File drop zone + upload progress | 🟡 | upload works; add progress + per-file retry |
| 1.25 | Chart primitives (bar/line/pie/donut) | 🟡 | database chart view exists; extract + add hover tooltips |

---

## 2. App shell

| # | Feature | Status | Design spec |
|---|---|---|---|
| 2.1 | Sidebar: resizable by drag | ✅ | 200–520px, persisted, double-click reset, keyboard nudge |
| 2.2 | Sidebar: hide/show | ✅ | button + Ctrl+\ + floating restore |
| 2.3 | Sidebar: collapse to icon rail | ⬜ | Notion's "hover to peek" rail on narrow screens |
| 2.4 | Sidebar: hover-peek when hidden | ⬜ | slide-in overlay on edge hover, dismiss on leave |
| 2.5 | Top bar: page title, icon, actions, presence | ✅ | |
| 2.6 | Top bar: breadcrumb with overflow menu | ✅ | |
| 2.7 | Top bar: scroll-linked shrink (title fades in on scroll) | ⬜ | signature Notion micro-interaction |
| 2.8 | Open-page tabs / recently opened strip | ✅ | workspace-shell tabs |
| 2.9 | Split view (two pages side by side) | ⬜ | drag a page to the right edge |
| 2.10 | Mobile top bar + drawer nav | ✅ | |
| 2.11 | Bottom status bar (sync state, word count, block count) | ⬜ | |
| 2.12 | Global loading bar for route transitions | ✅ | `ui/route-progress.tsx` (2px accent bar) mounted in `workspace-shell.tsx`; never a full-page spinner |
| 2.13 | Offline / sync indicator | ✅ | `offline-indicator` |
| 2.14 | Multi-window / pop-out page | ⬜ | low priority |

---

## 3. Navigation & wayfinding

| # | Feature | Status | Notes |
|---|---|---|---|
| 3.1 | Quick Find (Ctrl+K style inline switcher) | ✅ | |
| 3.2 | Command palette (Ctrl+Shift+P) with actions | ✅ | |
| 3.3 | Full-screen search (Ctrl+Shift+F) | ✅ | |
| 3.4 | Keyboard shortcuts help sheet (`?`) | 🟡 | shortcuts exist; add a discoverable cheat-sheet modal |
| 3.5 | Back / forward in-app | ✅ | router-driven; add visible arrows? (Notion: no) |
| 3.6 | Breadcrumbs + "jump to ancestor" | ✅ | |
| 3.7 | Recent pages (per workspace) | ✅ | |
| 3.8 | Favourites / Starred | ✅ | |
| 3.9 | Deep-link copy (page link, block link, comment link) | 🟡 | add "copy link to block" |
| 3.10 | Scroll position restore per page | 🟡 | `lib/scroll-anchor` exists; wire per page |
| 3.11 | Unsaved-changes guard | 🟡 | editor autosaves; verify navigation during upload |

---

## 4. Sidebar & page tree

| # | Feature | Status | Notes |
|---|---|---|---|
| 4.1 | Nested tree, expand/collapse, persisted | ✅ | |
| 4.2 | Virtualized for 1000+ nodes | ✅ | |
| 4.3 | Drag to reorder / re-nest with drop indicator | ✅ | add auto-scroll while dragging |
| 4.4 | Multi-select + bulk move | 🟡 | shift/cmd select, "move selected" |
| 4.5 | Inline rename (double-click, F2) | ✅ | |
| 4.6 | Context menu (duplicate, move, delete, copy link, export) | ✅ | |
| 4.7 | Hover actions (+ new sub-page, ⋯) | ✅ | |
| 4.8 | Teamspaces / private / shared sections | ✅ | |
| 4.9 | Sidebar search filter (type to filter tree) | ⬜ | Notion filters the tree inline |
| 4.10 | Sidebar sections collapse + reorder | 🟡 | |
| 4.11 | Trash entry + recently deleted | ✅ | |
| 4.12 | Workspace switcher | ✅ | add "create workspace", avatars per workspace |
| 4.13 | Sidebar footer: user, settings, theme, logout | ✅ | |
| 4.14 | Resize split between sidebar and tree? n/a | — | |

---

## 5. Editor — blocks (A → Z)

| # | Block / feature | Status | Notes |
|---|---|---|---|
| 5.1 | Paragraph, headings H1–H3 | ✅ | add H4–H6 toggles |
| 5.2 | Toggle heading / toggle list | ✅ | smooth expand animation |
| 5.3 | Bulleted / numbered / to-do (checkbox) list | ✅ | add click-on-drag-subtree |
| 5.4 | Quote, pull quote | ✅ | |
| 5.5 | Callout (icon + colour + background tint) | ✅ | |
| 5.6 | Divider, page break | ✅ | |
| 5.7 | Code block (syntax, language, line numbers, caption, wrap, copy) | ✅ | add language search + copy button |
| 5.8 | Equation — inline + block (LaTeX) | ✅ | KaTeX rendering wired; polish edit/preview |
| 5.9 | Table (rows/cols, header, cell colour, resize, merge) | 🟡 | merge/split out of scope per matrix |
| 5.10 | Columns (2–5) with drag resize | ✅ | add "move block into column" affordance |
| 5.11 | Board-style kanban *inside* a page? (via inline DB) | ✅ | |
| 5.12 | Image (drag-resize, caption, alt, full-width, replace, download) | 🟡 | add resize handles |
| 5.13 | Video / audio / file blocks with players | ✅ | add waveform for audio? low priority |
| 5.14 | PDF preview block | ✅ | |
| 5.15 | Bookmark / link card with favicon, title, description | ✅ | add "change preview to text/cover" |
| 5.16 | Embed (YouTube, Figma, CodePen, Drive, Maps, X) via providers | ✅ | |
| 5.17 | Synced block (source + instances, detach) | ✅ | |
| 5.18 | Template button block | ✅ | |
| 5.19 | Button block (actions) | ✅ | |
| 5.20 | Ask-AI block | ✅ | |
| 5.21 | Table of contents block | ✅ | add active-heading highlight |
| 5.22 | Breadcrumb block | ✅ | |
| 5.23 | Inline database block | ✅ | |
| 5.24 | Linked view of a database | ✅ | |
| 5.25 | Sub-page / page link inline mention | ✅ | |
| 5.26 | Mention: person / page / date / block reference | ✅ | add date picker on click |
| 5.27 | Emoji as page icon + cover image/gradient | ✅ | add cover reposition ✅, resize ⬜ |
| 5.28 | Block drag handle (⋮⋮) + click-to-select | ✅ | add "duplicate/drag above-below" menu |
| 5.29 | Multi-block selection (shift+click, shift+arrows) + bulk actions | ✅ | add drag-move of a selection |
| 5.30 | Slash menu (`/`) with fuzzy search + groups | ✅ | add "recently used" group |
| 5.31 | Bubble toolbar on selection (marks, colour, link, maths, AI, comment) | ✅ | add "turn into" submenu |
| 5.32 | Block context menu (turn into, colour, duplicate, move, copy link, delete) | ✅ | |
| 5.33 | Markdown input rules (`# `, `- `, `[] `, ``` `, `> `, `---`) | ✅ | |
| 5.34 | Paste: rich / plain / markdown / HTML sanitise / source cleanup | ✅ | add paste-as-markdown shortcut |
| 5.35 | Drag & drop blocks + file drop with drop indicator | ✅ | add auto-scroll + column drop targets |
| 5.36 | Nested page-in-page (sub-page cards) | ✅ | |
| 5.37 | Full-width toggle, small text, page font | ✅ | |
| 5.38 | Page lock (read-only) + schema lock | ✅ | |
| 5.39 | Backlinks panel (linked / unlinked mentions) | ✅ | |
| 5.40 | Word/block count + reading time in footer | ⬜ | |
| 5.41 | Find in page (Ctrl+F overlay with highlight + next/prev) | 🟡 | engine `lib/find-in-page.ts` + bar `editor/find-bar.tsx` shipped; mounting it in `page-editor.tsx` + binding Ctrl+F/Ctrl+Shift+F is the remaining wiring |
| 5.42 | Editor focus mode / zen (dim other blocks) | ⬜ | |
| 5.43 | Placeholder / last-edited-by footer | ✅ (last-edited) | |
| 5.44 | Scroll to top / "jump to block" affordances | ⬜ | |
| 5.45 | Block-level comments (inline anchor) | ✅ | |

---

## 6. Text formatting

| # | Feature | Status |
|---|---|---|
| 6.1 | Bold / italic / underline / strikethrough / inline code | ✅ |
| 6.2 | Text + background colours (full palette) | ✅ |
| 6.3 | Links (edit, hover title, open in new tab, unlink) | ✅ |
| 6.4 | Case transforms (upper/lower/title) | ✅ |
| 6.5 | Subscript / superscript | ✅ |
| 6.6 | Highlight pen (multi-colour) | ✅ |
| 6.7 | Comment mark + resolved state | ✅ |
| 6.8 | Smart typography (quotes/dashes) | ✅ |
| 6.9 | Clear formatting | ✅ |

---

## 7. Databases

### 7.1 Views
| # | View | Status |
|---|---|---|
| 7.1.1 | Table (sticky header, row numbers?, resize, reorder, pin, footer aggregates) | ✅ |
| 7.1.2 | Board (group by any property, WIP limits, drag between columns) | ✅ |
| 7.1.3 | Gallery (cover, fit/aspect, badges, excerpt) | ✅ |
| 7.1.4 | List (nesting, indent/outdent) | ✅ |
| 7.1.5 | Calendar (month grid, multi-day spans, drag to reschedule) | 🟡 drag-to-reschedule ⬜ |
| 7.1.6 | Timeline / Gantt (zoom week/month/quarter, dependencies, drag bars) | 🟡 drag/resize ⬜ |
| 7.1.7 | Chart (bar/line/pie/donut, grouping, aggregation, legend, tooltips) | 🟡 tooltips ⬜ |
| 7.1.8 | Form (builder, public submit, validation, success state) | ✅ |
| 7.1.9 | Map view | ⬜ |
| 7.1.10 | Dashboard view (compose widgets) | ⬜ |
| 7.1.11 | View switcher (tabs with icons, add view, rename, duplicate, delete) | ✅ |
| 7.1.12 | Saved views / presets (personal + shared) | ✅ |

### 7.2 Configuration
| # | Feature | Status |
|---|---|---|
| 7.2.1 | Filters (flat + AND/OR tree builder) | ✅ |
| 7.2.2 | Sorts (multi-key, drag order) | ✅ |
| 7.2.3 | Groups (by property, order, hide, collapse, aggregate per group) | ✅ |
| 7.2.4 | Search within view | ✅ |
| 7.2.5 | Conditional formatting / row colour rules | ✅ |
| 7.2.6 | Properties visibility, order, width, pin | ✅ |
| 7.2.7 | Row height (short/medium/tall), wrap text | 🟡 |
| 7.2.8 | Show/hide closed rows, quick filter from header | ✅ |
| 7.2.9 | Chart/footer/aggregation config | ✅ |
| 7.2.10 | Calendar/Timeline date property + scale selector | 🟡 |
| 7.2.11 | View sharing (share a view, not the whole DB) | ⬜ |

### 7.3 Properties & cells
| # | Feature | Status |
|---|---|---|
| 7.3.1 | Text, number (format/percent/currency), select, multi-select, status, date (+range, +reminders, +timezone), checkbox, URL, email, phone, files, people, relation (+two-way), rollup, formula, created/edited time+by, unique id, button, place, verification, AI autofill | ✅ |
| 7.3.2 | Cell editors with keyboard nav (arrows, Enter, Esc, Tab) | ✅ polish |
| 7.3.3 | Inline property creation from the header (+ property menu) | ✅ |
| 7.3.4 | Property type change with safe conversion warnings | 🟡 |
| 7.3.5 | Drag columns to reorder; resize to persist width | ✅ |
| 7.3.6 | Bulk edit selected rows (status/priority/assignee/labels/dates) | ✅ |
| 7.3.7 | Row peek (side panel) + open-as-page | ✅ |
| 7.3.8 | Row expand (full-page modal) | ✅ |
| 7.3.9 | Sub-items (nest rows, roll up) | ✅ |
| 7.3.10 | Dependencies (blocking/blocked-by, cycle guard) | ✅ |
| 7.3.11 | CSV import (mapping UI, preview, error report) + export | ✅ |
| 7.3.12 | Templates (create from row, default, recurring) | ✅ |
| 7.3.13 | Row count + load more / pagination | ✅ |

---

## 8. Pages, workspaces, lifecycle

| # | Feature | Status |
|---|---|---|
| 8.1 | Create page/database from sidebar, `/`, quick find, command palette | ✅ |
| 8.2 | Duplicate page / duplicate with sub-pages | ✅ |
| 8.3 | Move page (drag, menu, cross-workspace) | ✅ |
| 8.4 | Archive / delete → trash → restore / delete forever / empty trash | ✅ |
| 8.5 | Trash retention + "auto-deletes in N days" | ✅ |
| 8.6 | Version history with diff + restore (visual diff) | ✅ add side-by-side diff view ⬜ |
| 8.7 | Page templates gallery + save-as-template | ✅ |
| 8.8 | Import (Notion, Trello, CSV, Markdown, HTML, Asana, Evernote, GDocs, Confluence, PDF) with preview + progress | ✅ |
| 8.9 | Export (Markdown, HTML, PDF, CSV, workspace zip) | ✅ |
| 8.10 | Project / milestone / Gantt surfaces | ✅ |
| 8.11 | Tickets board (list/board/timeline, filters, saved views, bulk, archive, delete) | ✅ (delete in flight) |
| 8.12 | Cycles / sprints board | ✅ |
| 8.13 | Roadmap (cross-project timeline) | ✅ |
| 8.14 | Audit log page + CSV | ✅ |
| 8.15 | Library / home gallery | ✅ |

---

## 9. Collaboration

| # | Feature | Status |
|---|---|---|
| 9.1 | Presence: avatars in topbar + hover card | ✅ |
| 9.2 | Live cursors + selections (coloured by user) | 🟡 transport wired; paint cursors |
| 9.3 | Comments: create, reply, thread, resolve/unresolve, reactions, mentions | ✅ |
| 9.4 | Inline comment mark + margin indicator | ✅ |
| 9.5 | Suggestions mode (propose edits, accept/reject) | ✅ |
| 9.6 | Follow page (bell) + follower notifications | ✅ |
| 9.7 | Mention autocomplete (people, pages, dates) | ✅ |
| 9.8 | Share dialog: invite by email, roles, link sharing, allow edit/duplicate, indexing, expiry, password | ✅ |
| 9.9 | "Who has access" panel | ✅ |
| 9.10 | Guests (scoped external access) | ✅ |
| 9.11 | Coarse edit locks (structural edit guard) | ✅ |
| 9.12 | Activity feed per page | ✅ |
| 9.13 | Reactions on comments (emoji picker) | ✅ |

---

## 10. Notifications

| # | Feature | Status |
|---|---|---|
| 10.1 | Inbox page (unread, grouped by day, mark read / all read) | ✅ |
| 10.2 | Inbox item labels for every event type | ✅ |
| 10.3 | Per-user preferences (channels, per-type, quiet hours, digests) | ✅ |
| 10.4 | Email digest (daily/weekly) | ✅ |
| 10.5 | Desktop/push notifications | ⬜ |
| 10.6 | Notification bell with unread badge | 🟡 |
| 10.7 | Toast + inbox consistency rules | 🟡 |

---

## 11. Search

| # | Feature | Status |
|---|---|---|
| 11.1 | Quick find (page switcher) | ✅ |
| 11.2 | Full search page (snippets, highlight, type chips, filters, load more) | ✅ |
| 11.3 | Postgres FTS + trigram typo tier + ranking knobs | ✅ |
| 11.4 | Search filters (type, author, date, workspace) UI | 🟡 |
| 11.5 | Command palette "search in page/database" | 🟡 |
| 11.6 | Empty/no-result states with suggestions | 🟡 |
| 11.7 | Keyboard navigation everywhere | ✅ |

---

## 12. AI surfaces

| # | Feature | Status |
|---|---|---|
| 12.1 | Chat panel with streaming + markdown + citations | ✅ |
| 12.2 | **Always-on workspace grounding** (counts, milestones, tickets, messages) | ✅ |
| 12.3 | Chat action proposals (create/move/delete via confirm button) | 🟡 in flight |
| 12.4 | Writing skills (improve, proofread, shorten, translate, summarize, explain, continue, simplify) | ✅ |
| 12.5 | Inline AI in bubble toolbar + block menu | ✅ |
| 12.6 | AI autofill property (row → value) | ✅ |
| 12.7 | Summarize page/section with word budget | ✅ |
| 12.8 | Translation (5 locales) | ✅ |
| 12.9 | Transcription (audio → page) | ✅ |
| 12.10 | Prompt library (save/apply/render variables) | ✅ |
| 12.11 | AI provider settings (BYO key, local models, budgets, boundaries) | ✅ |
| 12.12 | Chat history list + rename/delete threads | ✅ |
| 12.13 | Streaming cancel + regenerate + copy | 🟡 |
| 12.14 | AI cost/usage meter in UI | ✅ settings page |

---

## 13. Templates

| # | Feature | Status |
|---|---|---|
| 13.1 | Template gallery (search, rank, tags, preview, apply) | ✅ |
| 13.2 | Save page as template / duplicate | ✅ |
| 13.3 | Database row templates (default, recurring, lock) | ✅ |
| 13.4 | Template variables `{{name}}` with preview | ✅ |
| 13.5 | Starter templates on empty workspace | 🟡 |

---

## 14. Sharing & public surfaces

| # | Feature | Status |
|---|---|---|
| 14.1 | Public page `/s/<token>` render (read-only, comments off) | ✅ |
| 14.2 | Publish/unpublish + settings (indexing, duplicate, export, password, expiry) | ✅ |
| 14.3 | Shareable database view (public table/board) | ⬜ |
| 14.4 | oEmbed / link preview cards | ✅ |
| 14.5 | Sitemap + RSS for published pages | ✅ |
| 14.6 | Invite acceptance page | ✅ |
| 14.7 | Print stylesheet (clean typography, page breaks) | ✅ |

---

## 15. Settings & admin

| # | Feature | Status |
|---|---|---|
| 15.1 | Profile (name, avatar, locale, theme, density) | 🟡 density ⬜ |
| 15.2 | Workspace (name, icon, domain/slug, delete) | ✅ |
| 15.3 | Members & roles (invite, change role, remove, ownership transfer) | ✅ |
| 15.4 | Teamspaces | ✅ |
| 15.5 | Labels manager | ✅ |
| 15.6 | Notifications preferences | ✅ |
| 15.7 | API tokens (scoped) | ✅ |
| 15.8 | Sessions (list, revoke, revoke all) | ✅ |
| 15.9 | Two-factor / security | ✅ |
| 15.10 | SSO (OIDC; SAML strategy layer) | ✅ |
| 15.11 | OAuth apps | ✅ |
| 15.12 | Webhooks | ✅ |
| 15.13 | Email/SMTP config | ✅ |
| 15.14 | AI providers + budgets + prompts | ✅ |
| 15.15 | Billing / plans / usage | ✅ |
| 15.16 | Data & privacy (export, erasure) | ✅ |
| 15.17 | Audit log | ✅ |
| 15.18 | Diagnostics / readiness / feature flags | ✅ |
| 15.19 | Move pages across workspaces | ✅ |
| 15.20 | Settings search (find a setting) | ⬜ |
| 15.21 | Settings nav with sections + sticky sub-nav | ✅ |

---

## 16. Onboarding & empty states

| # | Feature | Status |
|---|---|---|
| 16.1 | First-run workspace with template gallery | ✅ |
| 16.2 | Empty state per surface (board, gallery, search, inbox, trash, audit, roadmap) | 🟡 make every one actionable |
| 16.3 | Sample/demo data option | ⬜ |
| 16.4 | Coach marks / product tour | ⬜ |
| 16.5 | Keyboard-shortcut onboarding card | ⬜ |
| 16.6 | "What's new" changelog panel | ⬜ |
| 16.7 | Inline hints (placeholder text, "type / for commands") | 🟡 |

---

## 17. States & feedback (the "smooth" core)

| # | Pattern | Status | Spec |
|---|---|---|---|
| 17.1 | Loading: skeletons matching final layout | ✅ | `ui/skeleton.tsx` (sized to the real layout) adopted by lists/panels; never spinners for lists |
| 17.2 | Optimistic updates + rollback on error | ✅ | `useAction()` (`actions-client.ts`) + `ActionErrorGuard`; migrate the remaining unwrapped call sites |
| 17.3 | Error boundaries per pane (not whole app) | 🟡 | |
| 17.4 | Inline field validation (error under field, red ring) | ✅ | `Field` renders the error under the field with a danger ring |
| 17.5 | Destructive confirmations (non-blocking, two-step or dialog) | ✅ | `ui/confirm-dialog.tsx` (two-step + type-to-confirm) |
| 17.6 | Undo in toast for reversible actions (delete/archive/move) | ⬜ | `lib/undo-redo` + the toast `undo` variant exist — wire them together |
| 17.7 | Disabled + pending buttons (no double submit) | ✅ | `Button loading`, `Switch`/`ConfirmDialog` pending guards |
| 17.8 | Offline state + queued mutations banner | ✅ | |
| 17.9 | Retry with backoff for failed fetches | 🟡 | |
| 17.10 | "Saving…/Saved" indicator | ✅ | `page-editor.tsx` footer shows saving / saved / error |
| 17.11 | Long-op progress (import/export/AI) | 🟡 | |
| 17.12 | No layout shift (reserve space, CLS ≈ 0) | 🟡 | audit required |

---

## 18. Accessibility

| # | Feature | Status |
|---|---|---|
| 18.1 | Visible focus ring everywhere (`:focus-visible`) | ✅ |
| 18.2 | Focus trap in every overlay (dialog, drawer, palette, menus) | ✅ |
| 18.3 | Full keyboard operation (tree, cells, menus, tabs, drag alternatives) | 🟡 |
| 18.4 | ARIA: roles, live regions for toasts/status, labelled icons | 🟡 |
| 18.5 | Screen-reader announcements for async results | ⬜ |
| 18.6 | RTL / bidi correct layouts + mirrored icons | ✅ |
| 18.7 | High-contrast theme | ✅ |
| 18.8 | Reduced motion honoured | ✅ |
| 18.9 | Skip-to-content link | ✅ |
| 18.10 | Colour contrast AA for all tokens (incl. tags) | 🟡 |
| 18.11 | Zoom 200% without loss | 🟡 |
| 18.12 | a11y test suite in CI | ✅ (`check:a11y`) |

---

## 19. Interaction & motion design (make it feel Notion-smooth)

| # | Pattern | Spec |
|---|---|---|
| 19.1 | Hover states on every interactive surface | 120ms `ease-out`, background tint only |
| 19.2 | Press state (scale 0.98 or darker bg) | 80ms |
| 19.3 | Menu/popover enter | 120ms fade + 4px rise, `ease-spring` on close |
| 19.4 | Dialog enter | 160ms fade + scale 0.98→1 |
| 19.5 | Drawer/peek slide | 240ms `ease-out` from the right |
| 19.6 | Sidebar resize | **no** transition while dragging (must track cursor 1:1) |
| 19.7 | Block insert/remove | 140ms height+opacity, neighbours move smoothly |
| 19.8 | Drag & drop | 1:1 cursor tracking, drop indicator 2px accent line, spring settle, auto-scroll near edges |
| 19.9 | Checkbox tick | 160ms draw + strikethrough fade |
| 19.10 | Toggle/callout expand | 180ms height, chevron rotate 90° |
| 19.11 | Skeleton shimmer | 1.4s ease-in-out loop (exists) |
| 19.12 | Toast enter/exit | slide+fade 200ms, stack collapse |
| 19.13 | Scroll: no rubber-band jank, sticky headers, edge fade | |
| 19.14 | Route transition | 120ms content fade; sidebar never re-mounts |
| 19.15 | Cursor affordances (`grab`, `col-resize`, `pointer`) per surface | |
| 19.16 | Selection (text + blocks) | accent tint, no outline flicker |
| 19.17 | Never animate width/height on scroll-driven UI | |

---

## 20. Performance & perceived speed

| # | Item | Status |
|---|---|---|
| 20.1 | Route-level code splitting + prefetch on hover | 🟡 |
| 20.2 | Virtualize every long list/grid (tree ✅, rows ✅, search ✅, chat ⬜) | 🟡 |
| 20.3 | Image lazy loading + responsive `srcset` + blur placeholder | 🟡 |
| 20.4 | Debounced inputs (search, autosave, resize) | 🟡 |
| 20.5 | Memoised heavy renders (database rows, editor) | 🟡 |
| 20.6 | Instant interactions (<100ms) even when network is slow (optimistic) | 🟡 |
| 20.7 | Bundle budget + Lighthouse budget in CI | ⬜ |
| 20.8 | Web vitals reporting | ⬜ |
| 20.9 | Font loading strategy (no FOUT/CLS) | 🟡 |
| 20.10 | Offline cache + background sync | ✅ |

---

## 21. Quality gates / tooling (keep it from regressing)

| # | Item | Status |
|---|---|---|
| 21.1 | Unit tests for every pure UI mapping | ✅ |
| 21.2 | Live check scripts (24 `scripts/check-*.mjs`: a11y, design-system, coherence, use-server, routes, search, tickets, …) | ✅ |
| 21.3 | a11y audit in CI (`check:a11y`) | ✅ |
| 21.4 | Coherence/lint ratchets (no blocking dialogs, no orphan actions, i18n coverage) | ✅ |
| 21.5 | **Visual regression screenshots** (Playwright + baseline diff) | ⬜ |
| 21.6 | **Storybook / `/dev/ui` component gallery** for the UI kit | ⬜ |
| 21.7 | Interaction tests for drag & drop, resize, keyboard | 🟡 — Playwright `e2e/` covers drag/resize/keyboard (`media-parity`, `properties-parity`, `focus`); no dedicated design-interaction suite |
| 21.8 | Design-token linting (no raw hex / arbitrary px in components) | ✅ — `scripts/check-design-system.mjs` (`check:design` / `design:report`); not yet wired into CI |
| 21.9 | Motion audit (all animations use tokens, reduced-motion safe) | ⬜ — `check:motion` not yet written |
| 21.10 | i18n string extraction workflow | ✅ |

### How we verify design work

1. **Unit + SSR tests** (`npm test`) — every primitive carries a `*.test.ts` that
   pins its pure mapping; components that render markup are exercised with
   `renderToStaticMarkup` in the node environment (`vitest.config.mts`), so a raw
   hex or a bad class fails without a browser.
2. **`npm run check:design`** (`design:report`) — the token-conformance ratchet:
   raw hex, magic z-index, ad-hoc duration/radius/shadow and the legacy palette
   are counted per file and must stay at or below the baseline. `npm run design:report`
   prints the per-file detail (quoted in DESIGN_SYSTEM §12).
3. **`npm run check:coherence`** — the "don't regress the feel" gate: no blocking
   dialogs, no orphan server actions, no `window.alert`/`prompt`, i18n coverage.
4. **`check:motion`** *(planned — does not exist yet)* — assert every animation
   uses a `--dur-*` / `--ease-*` token and is neutralised by `prefers-reduced-motion`.
5. **`visual:check`** *(planned — does not exist yet)* — Playwright screenshot +
   baseline diff for the primitive kit and the key surfaces.
6. **`/dev/ui` gallery** *(planned — does not exist yet)* — a live route rendering
   every primitive in every state (light / dark / high-contrast) to eyeball and
   screenshot.

Until 4–6 land, the manual pass is: run `npm run design:report` → open the app →
check light/dark/high-contrast at 200 % zoom + reduced motion → reuse a primitive
from the DESIGN_SYSTEM §11 kit before adding a one-off control.

---

## 22. Suggested build order (highest impact first)

Ordered by what the design report still flags (`npm run design:report`, quoted in
DESIGN_SYSTEM §12) plus the wires the primitives still need.

**P0 — finish the design-system adoption**
1. **Drive every flagged file below baseline.** 29 files still carry a hit;
   worst first: `auth-form.tsx`, `database/view-renderers.tsx`,
   `editor/page-editor.tsx`, `audit-feed.tsx`, `database/database-types.ts`,
   `database/database-view.tsx`, `database/property-options-editor.tsx`,
   `database/view-settings.tsx`, `editor/block-context-menu.tsx`,
   `editor/equation-editor.tsx`, `editor/extensions/block-colors.ts`,
   `editor/extensions/bookmark.tsx`, `editor/extensions/custom-blocks.tsx`,
   `editor/extensions/suggestions.ts`, `editor/formula-editor.tsx`,
   `email-settings.tsx`, `notification-preferences-form.tsx`, `page-title.tsx`,
   `search-results.tsx`, `sidebar/page-tree.tsx`. The two "arbitrary duration"
   hits (`page-title.tsx`, `sidebar/page-tree.tsx`) are the cheapest wins.
2. **Wire find-in-page** (5.41): mount `editor/find-bar.tsx` in `page-editor.tsx`
   and bind Ctrl+F / Ctrl+Shift+F.
3. **Wire undo-in-toast** (17.6): connect `lib/undo-redo` to the toast `undo`
   variant for delete / archive / move.
4. **Remaining primitives**: `Tabs` (1.8), ColorPicker (1.18), Chart primitives
   (1.25, + hover tooltips).

**P1 — parity gaps users notice**
5. Sidebar hover-peek + icon rail (2.3–2.4), topbar scroll-shrink (2.7), split view (2.9).
6. Sidebar type-to-filter (4.9), bulk move (4.4).
7. Calendar drag-reschedule (7.1.5), timeline drag/resize (7.1.6), chart tooltips (7.1.7), view sharing (7.2.11).
8. Live cursors paint (9.2), desktop notifications (10.5).
9. Chat action confirmations (12.3 — in flight).
10. **Design tooling**: `/dev/ui` gallery + `visual:check` + `check:motion` (21.5–21.6, 21.8–21.9).

**P2 — depth & delight**
11. Map view, dashboard view (7.1.9–7.1.10), public DB views (14.3).
12. Density modes (0.10), accent theming (0.11), coach marks (16.4), what's-new (16.6).
13. Bundle/vitals budgets (20.7–20.8), CI wiring for `check:design` (21.8).

---

## 23. "Don't forget" checklist (easy to miss)

- Empty **and** loading **and** error state for *every* list, panel, and view.
- Keyboard path for every pointer path (drag, resize, colour pick, date pick, reorder).
- Hover **and** focus **and** pressed **and** disabled state on every control.
- Undo for every destructive action; confirm only for irreversible ones.
- Persist every user preference (widths, view config, density, theme, collapsed sections, scroll).
- No blocked scroll behind modals; Esc closes; click-outside closes; focus returns.
- Long text: truncate-with-tooltip in rows, wrap in detail views.
- Right-click / context menu parity with the ⋯ menu.
- Multi-select parity (rows, blocks, tree, comments) with shift/cmd semantics.
- Timezone + locale formatting for every date/number (5 locales, RTL).
- Loading skeletons that match the real layout (no jump when data lands).
- Optimistic UI with rollback + toast on failure.
- Mobile: drawer nav, tap targets ≥ 44px, no hover-only affordances, bottom sheet for actions.
- Print: page + database print CSS.
- Copy/paste parity: copy link to block/page, paste as Markdown, copy as CSV in tables.
