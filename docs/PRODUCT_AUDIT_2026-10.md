# Noema — product, design and architecture audit

**Audited:** 2026-10-22 · local `main` at `d3da779`
**Scope:** public landing, authentication, workspace shell, editor chrome,
database views, settings, design tokens, component kit, frontend architecture.
**Method:** source inspection, repository documentation, committed screenshots,
live localhost rendering, static audits, typecheck/lint/tests/build.
**Constraint:** no remote changes. The audit is local-only.

---

## 1. Executive summary

Noema is not a generic CRUD app with a Notion skin. It is a serious,
server-first workspace with a coherent “everything is a page” domain, a deep
primitive kit, a tested editor and database surface, and an unusually strong
accessibility/security posture for a project of this size.

The product problem is **identity and density**, not capability:

1. The public and account surfaces did not carry the product's own mark or
   visual language. The first impression was a generic form and a generic hero.
2. The strongest surface — the workspace — is visually calm, but it becomes
   cramped on mobile and the database toolbar becomes a wall of controls.
3. Several token-level accessibility edges were real: form-control borders
   were too quiet for WCAG 1.4.11, and the status inks (especially amber) did
   not clear AA on the surfaces they were used on.
4. The architecture is a sound modular monolith, but a handful of files carry
   too much responsibility (database view, page title, page editor, queries),
   which is where future change will be expensive.

Phase 1, implemented in this working tree, addresses the brand discontinuity,
the account surface, the token accessibility edges, the database row/table
legibility bugs, and the mobile touch targets that could be fixed without
redesigning interaction flows.

---

## 2. Evidence and limits

### Verified

- `npm run typecheck` — passed.
- `npm run lint -- --quiet <changed files>` — passed.
- `npm run check:design` — passed (0 raw hex, 0 arbitrary z-index/duration/
  radius/shadow, 0 legacy palette hits across 190 files).
- `npm run audit:frontend` — **0 DEFECT, 0 INCONSISTENCY**; 114 recorded DEBT
  items (legacy CSS, duplicated catalogues, hand-built popovers).
- `npm test` — **12,101 passed / 12,101**, 549 files.
- `npm run build` — compiled successfully; `BUILD_EXIT:0`.
- Live `localhost:3000`: `/`, `/login`, `/signup` return 200.
- Playwright at 1440×1000 and 390×844, light and dark: no console errors, no
  horizontal overflow, no unlabelled focusable controls, one `h1` per page.
- Form-control border resolves to `rgb(143, 143, 136)` in light mode and
  `rgb(112, 112, 112)` in dark mode.

### Authenticated verification

- The local database was provisioned with the repo's embedded PGlite adapter
  (no Docker), the Prisma schema pushed and the demo workspace seeded.
- `npm run check:a11y` against `localhost:3000`: **44/44 checks passed**
  (login, signup, a workspace page and settings; labels, landmarks, names,
  images, light/dark contrast).
- Playwright signed in as the demo user and loaded home, editor, database and
  settings at 1440, plus editor/database at 390: **no console errors, no
  horizontal overflow, one h1 per page**.
- This used the embedded database, not the external Postgres documented in
  `.env`; production DB behavior is unchanged and still covered by the DB-free
  unit suite + the existing integration scripts.

### Not verified here

- SMTP, live AI providers, OAuth against an external IdP, and the desktop
  WebView shell were not exercised in this pass.
- User research is unavailable; personas and journeys below are explicitly
  provisional.
- Authenticated visual snapshots are not yet wired into a committed CI script
  (the ad-hoc Playwright run is recorded here, not in the repository).

---

## 3. Product and users

### Purpose (from repository evidence)

A self-hosted, local-first workspace for notes, docs and databases, with an
optional desktop build. The product promises ownership of data, no required
cloud account, and a Notion-class block/database surface without the SaaS
lock-in.

### Provisional personas — **assumptions, not research**

| Persona | Context | Primary job | What they need from the UI |
|---|---|---|---|
| **The operator** | Self-hosts for a small team; owns Postgres, backups, AI keys | Install, invite, keep it healthy | Clear setup, trustworthy settings, visible security/permission state |
| **The knowledge worker** | Writes docs, runs projects, searches constantly | Capture a thought, find it again, connect it | Fast capture, calm editor, strong search and navigation |
| **The database owner** | Tracks work in tables/boards/tickets | Change structure without fear | Legible tables, discoverable view controls, safe bulk actions |
| **The guest/collaborator** | Sees only shared pages/rows | Read or edit exactly what was shared | Obvious scope, no accidental leakage, clear empty/error states |

### Jobs to be done

- “When I open the app, I want to resume the page I was in, not hunt for it.”
- “When a table gets wide, I want the row identity to stay readable.”
- “When I invite someone, I want to know what they can see before they see it.”
- “When I write, I want the chrome to disappear and the document to be the
  interface.”
- “When I self-host, I want the product to look like it was designed for my
  machine, not like a demo of someone else's SaaS.”

### Journeys that matter most

1. **First visit → account → first page.** Landing must explain the product and
   hand off to a trustworthy account surface.
2. **Resume → navigate → write.** Workspace shell, tabs, sidebar, page title and
   editor must feel like one continuous surface.
3. **Open a database → change a view → edit a cell.** The table toolbar must
   expose power without turning into a cockpit.
4. **Share → guest opens link → reads only what was shared.** Scope must be
   visible, not just enforced.
5. **Self-host → configure AI/storage/backups → recover.** Settings must be
   calm, explicit and reversible.

---

## 4. What is already strong

- **Domain clarity.** “Everything is a page” is visible in the model, routes,
  editor and database views. This is a genuine product idea, not a template.
- **Primitive depth.** Buttons, inputs, selects, dialogs, sheets, menus,
  tooltips, calendars, steppers, virtual lists, empty states, skeletons and
  toasts already exist with tests.
- **Token discipline.** The design gate finds zero raw hex, arbitrary radius,
  shadow, duration or z-index in components. That is rare.
- **Motion and accessibility vocabulary.** Reduced-motion kill switch, focus
  rings, high-contrast mode, `aria-current`, skip link and labelled navs are
  already present.
- **Test culture.** 12k unit tests and a large feature matrix; the build is
  clean; the app has real screenshots and design documentation.
- **Security posture.** The recent audit trains fixed real authorization,
  session, upload, SVG, webhook and budget issues. The architecture already
  centralizes authorization and validates at the server boundary.

---

## 5. Findings, ranked

Severity is a product judgement; confidence is the strength of the evidence.

| # | Finding | Severity | User impact | Confidence | Effort | Status |
|---|---|---|---|---|---|---|
| 1 | Public/auth surfaces did not use the product mark; login/signup were generic centred cards with no brand context | High | First impression reads “unfinished clone”; weak trust for a self-hosted product | High — source + screenshot | M | **Fixed** |
| 2 | Form-control borders (`#e9e9e7`) failed WCAG 1.4.11 (1.2:1); checkbox/radio/switch/select boundaries were similarly quiet | High | Low-vision users cannot reliably locate controls | High — computed style + contrast | M | **Fixed** |
| 3 | Status inks failed AA on white/sidebar/surface: warning `#cb912f` = 2.75:1, danger `#d44c47` = 4.26:1; dark variants inherited light inks | High | Error/warning copy and password-strength feedback can be unreadable | High — measured contrast | S | **Fixed** |
| 4 | Mobile workspace chrome: 7 icon actions in a 28px row, 16px tab close, 32px menu; tab strip clipped without affordance | High | Mis-taps, hard-to-close tabs, cramped first screen | High - 390px screenshot | M | **Fixed** (copy-link and presence hidden on phones; 40px menu, 32px actions, 24px close, no scrollbar) |
| 5 | Database table: first column too narrow, long row titles clipped; status cell rendered chip **and** a second native select with the same text | High | Users cannot identify rows at a glance; status looks duplicated/broken | High — 1440px screenshot + source | S | **Fixed** |
| 6 | Database toolbar: 20+ controls across three rows | Medium | Cognitive overload; primary action ("New row") competes with advanced configuration | High - screenshot | L | **Fixed** (five common controls inline; advanced controls behind one View options disclosure; row actions behind More) |
| 7 | Auth pages lacked a shared frame; login and signup duplicated layout decisions | Medium | Drift and inconsistent first impression | High — source | S | **Fixed** |
| 8 | `audit:frontend` reported three dialog close buttons as unnamed because it stripped `{t(...)}` copy | Medium (tooling) | False defects hide real ones and erode trust in the gate | High — script + source | S | **Fixed** |
| 9 | Architecture concentration: `view-settings.tsx` 2.4k lines, `database-view.tsx` 2.0k, `view-settings-model.tsx` 1.3k, `page-editor.tsx` 1.5k, `view-parts.tsx` 1.4k, `queries.ts` 66-line barrel | High (maintainability) | Every database/editor change is a high-risk review; ownership is unclear | High - measured line counts + git churn | L | **Seams fixed** (query domains, cells, peek/actions/tabs/toolbar, all database layouts and editor pure layers extracted; remaining concentration is the `ViewSettings` composition) |
| 10 | 95 block-content selectors (`.notion-*` / `.noema-*`) formed a second style system; 12 duplicated colour catalogues; 7 hand-built popovers | Medium (debt) | Drift, specificity fights, harder theming | High - audit report | L | **Fixed** — selectors converted to Tailwind v4 utilities, catalogues consolidated, popovers moved to the shared placement engine |

### Why these are the top findings

The first three change whether the product feels trustworthy and whether people
can use it. The next two change whether the core workspace is usable on the
devices people actually use. The architecture findings are expensive but not
user-visible today; they belong in a sequenced roadmap, not a rewrite.

---

## 6. Recommended product and design direction

### Direction: **“Quiet editorial workspace”**

Noema should feel like a well-made desk, not a dashboard. The product already
has the right instincts: a paper-white canvas, warm neutrals, a restrained
blue, small radii and type-led hierarchy. The missing layer is **editorial
confidence** — a recognizable mark, a strong first screen, and a tighter
hierarchy around the work.

Do **not** chase a trend (glassmorphism, neon gradients, giant rounded cards,
AI-first chrome). The product's advantage is calm ownership. The visual system
should express:

- **Paper, not glass.** Solid surfaces, hairline dividers, one accent.
- **Ink, not decoration.** Type and spacing carry hierarchy; icons are support.
- **One blue.** The accent is a tool, not a mood.
- **Warmth without beige.** The sidebar and tags can be warm; the canvas stays
  neutral so documents and data remain the color.
- **Motion as confirmation.** 120–240ms, no scroll animation, no hover layout
  shift.

### Colour system

The token layer stays three-tier (primitive → semantic → component), but the
semantic layer now has explicit control and status responsibilities.

| Role | Light | Dark | Use |
|---|---|---|---|
| Canvas | `#ffffff` | `#191919` | Page and form surfaces |
| Sidebar | `#f7f7f5` | `#202020` | Navigation chrome |
| Surface | `#f1f1ef` | `#2c2c2c` | Inset panels, table headers |
| Ink | `#37352f` | `rgba(255,255,255,.81)` | Primary text |
| Secondary ink | `#62615c` | `rgba(255,255,255,.68)` | Body secondary |
| Tertiary ink | `#6b6b65` | `rgba(255,255,255,.58)` | Captions, hints |
| Accent | `#156cc7` | `#4c9bea` | Actions, links, focus |
| Accent ink | `#ffffff` | `#191919` | Text on accent |
| Control boundary | `#8f8f88` | `#707070` | Inputs, selects, checks |
| Danger | `#c23b36` | `#ff8a85` | Errors, destructive |
| Success | `#3c7355` | `#7bc99a` | Confirmation |
| Warning | `#94640e` | `#e0b45c` | Caution |

Measured AA results (normal text, 4.5:1):

- light ink/secondary/tertiary: **12.26 / 6.21 / 5.36** on white; tertiary still
  **4.74** on surface.
- light accent on white: **5.25**; white on accent: **5.25**.
- light danger/success/warning: **5.29 / 5.56 / 5.14** on white; all clear 4.5
  on sidebar and surface.
- dark ink/secondary/tertiary: **11.29 / 6.56 / 4.76** on canvas.
- dark accent/danger/success/warning: **6.01 / 7.72 / 8.93 / 9.09** on canvas.
- control boundary: **3.25** light / **3.55** dark (≥3:1 for non-text UI).

### Typography

- Keep the system sans stack for speed and self-hosting; do not add a network
  font dependency to a product that promises to run offline.
- Use the existing scale: `text-title` 28px for page titles, `text-xl` 20px for
  sections, `text-sm` 13–14px for UI, `text-base` 16/26 for prose.
- Tighten tracking only on headings (`--tracking-title`, `--tracking-heading`).
- Use `text-wrap: balance` on marketing and page headings, `pretty` on prose
  (already present).
- Numbers in tables use `tabular-nums`; row titles get `truncate` plus `title`.

### Layout and components

- Public: one 6xl container, two-column hero with a real product frame, feature
  grid, one trust/CTA band, quiet footer.
- Account: one brand panel + one form card; single column below `lg`.
- Workspace: keep the current shell. On mobile, the next step is a **single
  “page actions” overflow** rather than seven icon buttons; the tab strip stays
  scrollable but without a visible scrollbar.
- Database: keep the view switcher and “New row” as the primary row; move
  advanced view configuration into one "View options" disclosure (done).
  high-leverage design change.
- Buttons/inputs: `border-control` for form boundaries, `border` for decorative
  edges; `focus-ring` everywhere; 32px minimum hit area, 40px for primary
  mobile chrome.

---

## 7. Architecture: current and target

### Current shape (verified)

```
src/app            routes, server components, route handlers
src/components     UI kit + product surfaces (editor, database, sidebar, topbar)
src/server         queries.ts barrel + queries/* + actions/*
src/lib            domain engines, tokens, validation, security helpers
prisma             schema + migrations
```

Strengths:

- Server Components read through `src/server/queries.ts`; client components call
  server actions. Prisma is not imported into client code.
- Authorization is re-derived per action; the JWT carries only the user id.
- Domain engines (database query, formula, permissions, sharing, import) are
  pure and heavily tested.
- The editor is a client island inside a server-first shell.

Risks:

- `src/server/queries.ts` is a 66-line barrel over `queries/search.ts`,
  `notifications.ts`, `tickets.ts`, `database.ts` and `workspaces.ts`.
- Database UI now has explicit owners: orchestration, tabs, toolbar, action
  row, peek, cells, a shared view model, one file per layout and the settings
  model/filter builder. `view-settings.tsx` remains the largest composition
  file.
- `page-title.tsx` combines chrome, menus, persistence, keyboard handling and
  rendering. `page-editor.tsx` now keeps the editor composition while motion,
  clipboard, block references and suggestions have their own modules.
- `globals.css` still contains a 95-rule legacy layer; the design gate proves
  components are token-clean, but the stylesheet is not yet one system.

### Target shape (incremental, no rewrite)

Keep the Next.js modular monolith. Do not introduce microservices, a second
state library, or a new database.

1. **`src/modules/database/`** — move the pure model (`view-config`,
   `database-query`, `table-ops`, `column-layout`, `footer-calculations`) and
   the React surfaces into:
   - `model/` pure, no React;
   - `use-*` hooks for view/selection/editing state;
   - `render/` table/board/list/gallery/calendar/timeline/chart;
   - `settings/` one `ViewOptions` surface.
2. **`src/modules/page/`** — split `page-title` (chrome), `page-editor`
   (document session), and `page-actions` (menu) behind explicit props; keep
   server actions as the transport.
3. **`src/server/<domain>/queries.ts` + `actions.ts`** — one folder per domain
   (`pages`, `databases`, `workspaces`, `tickets`, `sharing`, `ai`), with a
   shared `authorize` helper. `src/server/queries.ts` becomes a thin barrel or
   disappears.
4. **Design-system enforcement** — keep `check:design`; add a rule that new
   form controls use `border-control` and new status text uses semantic tokens.
   Port legacy `.notion-*` families one at a time, deleting each rule when its
   last consumer migrates.

Each seam must be proved by a test and a lint/type boundary; otherwise it is
just a folder move.

---

## 8. Roadmap

### Phase 0 — baseline (done)

- Typecheck, lint, tests, build, design audit.
- Fix stale Prisma client locally (`prisma generate`) before treating type
  errors as product errors.

### Phase 1 — brand, account, tokens, legibility (done)

- `NoemaWordmark`, `AuthShell`, real product mark on landing/auth.
- Landing hero with product preview, feature grid, trust band.
- `border-control` token + form primitive adoption.
- AA status inks and secondary/tertiary inks; accent darkened for AA.
- Database first-column width + status chip overlay (no duplicate text).
- Mobile menu 40px, page icon actions 32px, tab close 24px, no tab scrollbar.
- Audit false-positive fix.

### Phase 2 - workspace ergonomics (done)

- [x] Mobile page actions: copy-link and presence are hidden on phones; the
  remaining controls are 32px, with Share + the actions menu always available.
- [x] Database toolbar: at <md it is one horizontal rail with no scrollbar
  instead of a multi-row wall; the row-level actions now sit behind one More
  menu (Sub-tickets, lock and New row stay visible).
- [x] Sidebar Home/Chat/Meetings tabs fit at the 240px default width.
- [x] One "View options" disclosure for Builder/Color/WIP/Groups/Summarize/
  Calculations/Layout/Rows/Saved views/Chart/Gallery; the five common controls
  stay inline, with view switcher and New row visible.
- [x] Table density (short / medium / tall) is persisted in the view config
  and exposed in View options alongside the row window.
- [x] Branded 404 (`not-found.tsx`), improved route error boundary, and public
  loading skeletons for shared pages/invitations.
- [x] Audit every authenticated route's empty state with task-specific copy.
  Every collection route now has an actionable empty state: audit, cycles,
  inbox, library, projects, project detail (milestones/tickets/pages/members),
  roadmap (dated work/tracked work/milestones), search, templates, tickets,
  ticket archive, trash, prompts and backlinks. Settings routes that are forms
  have no collection state; the data page names an empty personal-record list
  inline.

### Phase 3 — architecture seam (database complete)

- [x] Extract SELECT/STATUS into `status-cell.tsx`, move `optionTagHue` into
  `database-types.ts`, and add a focused regression test.
- [x] Add `src/components/database/README.md` with the ownership map and next
  extraction order.
- [x] All cell types, view tabs, the view toolbar, the action row and the
  side peek have their own modules. `queries.ts` is a 66-line barrel over
  search, notifications, tickets/activity, database and workspace/page
  domains. Database layouts (`table`, `list`, `board`, `gallery`, `form`),
  `PropertyPanel`, the shared view model and the `ViewSettings` model/filter
  builder are separate files. The editor's motion, clipboard, block-reference
  and suggestions layers are separate files. Public props and
  `@/server/queries` imports stayed stable.

### Phase 4 — quality and measurement (started)

- [x] `npm run check:public-ui` — 16/16 public surfaces pass at 390/1440,
  light/dark, including text and control-border contrast.
- [x] Branded loading/error/not-found states.
- [x] Authenticated `check:a11y` (44/44) and ad-hoc Playwright coverage of home,
  editor, database and settings at 1440/390.
- [x] Local production-build performance baseline recorded (see below).

### Local production baseline (Chromium, 1440, warm localhost)

| Surface | TTFB | LCP | CLS | Transfer |
|---|---:|---:|---:|---:|
| Landing | 15 ms | 116 ms | 0 | 291 KB |
| Workspace home | 54 ms | 268 ms | 0 | 36 KB (cached nav) |
| Editor | 47 ms | 312 ms | 0 | 611 KB |
| Database | 56 ms | 352 ms | 0.0016 | 33 KB (cached nav) |

These are lab numbers on a local production build with a warm cache, not field
measurements. A quick-find click plus four typed characters produced **no long
tasks over 50 ms** and a worst event duration of **24 ms** (20 event entries).
The editor bundle is the next budget to set.

---

## 9. Acceptance criteria

Phase 1 is complete when:

- [x] Landing, login and signup use the Noema mark and wordmark; no duplicated
      auth layout code.
- [x] `/`, `/login`, `/signup` render at 390 and 1440 with no horizontal
      overflow, no console errors and no unlabelled focusable controls.
- [x] Form controls expose a ≥3:1 boundary in light and dark.
- [x] Status inks clear AA on canvas, sidebar and surface.
- [x] Database first column has a readable minimum width; status cells show one
      label, not a chip plus a second native select.
- [x] Mobile menu is 40px; page icon actions are 32px; tab close is 24px.
- [x] `typecheck`, `lint`, `check:design`, full tests and build pass.
- [x] `audit:frontend` reports zero DEFECT and zero INCONSISTENCY.
- [x] `check:public-ui` passes 16/16 public surface/viewport/theme combinations.
- [x] Branded 404, route error retry/back, and public loading skeletons ship.
- [x] All cell types extracted with focused regression tests.
- [x] Authenticated workspace a11y and visual checks on the embedded database.
- [x] Full database toolbar consolidation behind "View options" (Phase 2).
- [x] Database tabs, toolbar, action row and side peek have their own modules;
      `database-view.tsx` keeps orchestration and data flow only.
- [x] The peek closes on Escape from any focus position, fits 390px without
      horizontal overflow, and exposes the same property grid on mobile.
- [x] The action row's More menu (deleted rows, new property, duplicate,
      export/import) is verified in production at 1440 and 390.
- [x] `check:layering` passes: a Select opened inside the ticket drawer paints
      above it, a route-level modal paints above the docked AI panel, and the
      check removes the ticket it creates.

---

## 10. Assumptions and risks

- **Personas are provisional.** No interviews, analytics or support transcripts
  were available. Validate with 5–8 users across operator/knowledge worker/
  guest before locking the roadmap.
- **Committed screenshots may lag the source.** They are evidence of the
  surfaces at the time of capture; source is authoritative for current code.
- **Authenticated evidence came from the embedded PGlite database.** It is the
  same schema and server path as production, but not an external Postgres or
  the desktop WebView shell.
- **Token changes are intentionally conservative.** The darker inks and control
  borders trade a little softness for measurable legibility. If the product
  wants a softer look, add a “soft” theme rather than weakening the default.
- **No destructive architecture changes in this pass.** The large-file
  concentration is real, but a rewrite would risk the tested security and data
  behavior. Extract seams behind tests, one vertical slice at a time.
