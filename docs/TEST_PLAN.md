# Noema — test plan (spec · UX · UI), exhaustive

> How the app is proven, and everything that should be proven before a feature is
> called done. Written against `docs/AUDIT.md` findings so every open weakness has
> a test that would catch its regression.

## 0. Levels and gates

| Level | Tool | Where | Gate |
| --- | --- | --- | --- |
| Unit (pure logic) | Vitest | `src/**/*.test.ts` | `npm test` — 131 tests, must stay green |
| Contract / API | node scripts | `scripts/check-*.mjs` | `npm run check:*` — 16 suites |
| Journey (browser) | Playwright | `e2e/noema.spec.ts` | `npx playwright test` — 18 tests |
| Accessibility | check script + audit | `scripts/check-a11y.mjs` | 44/44 |
| Types / lint | tsc + eslint | repo | zero errors |
| Visual | screenshots reviewed by hand | manual | no review = not done |
| Coherence | inventory | `scripts/audit-inventory.mjs` | 0 dead controls, 0 orphan actions after F-07 |

Environment: server on `:3200`, Postgres on `:5433`, demo login `demo@noema.local / password123`, mock IdP `:4321`, mock Notion `:4322`, mock ICS `:4323`, mock SMTP `:2525`. Tests must never require the internet (AI suites skip cleanly when keys are absent).

---

## 1. Cross-cutting test matrix (run for **every** feature)

| # | Dimension | Cases that must pass | Status |
| --- | --- | --- | --- |
| C1 | **Empty state** | First-run view explains what to do; no blank pane, no broken layout | partial |
| C2 | **Loading state** | Skeleton or pending affordance; buttons disable while a transition runs | ✅ |
| C3 | **Error state** | A failing action shows a message and re-enables the control; the page never hangs | ✅ (F-09 widens) |
| C4 | **Optimistic UI** | The change appears immediately and reconciles with the server value | ✅ chat, favorites |
| C5 | **Permission denied** | Viewer role sees no edit affordance; crafted calls return an error, not data | ✅ |
| C6 | **Stale session** | Session expiry redirects to `/login` mid-action without data loss | manual |
| C7 | **Double submit** | Clicking twice creates one entity (no duplicate pages/tickets) | ✅ |
| C8 | **Keyboard only** | Every control reachable by Tab; Enter/Space activate; Escape closes overlays; focus returns to the trigger | partial |
| C9 | **Screen reader** | Every control has an accessible name; landmarks and `aria-current` present; live regions for async results | ✅ check-a11y |
| C10 | **Contrast / dark mode** | AA contrast in both themes; no hard-coded light colours | ✅ |
| C11 | **Responsive** | 375 / 768 / 1440 widths: no horizontal scroll, sidebar collapses, panels go full-screen | ✅ |
| C12 | **i18n + RTL** | Switching locale changes chrome; `ar` mirrors the layout | ✗ (F-08) |
| C13 | **Slow network** | 3G throttling: optimistic state visible, no double-send, spinner not frozen | manual |
| C14 | **Offline / failure** | Killed request surfaces a toast and lets the user retry | manual (F-09) |
| C15 | **Very long input** | 10 000-char title/comment/answer: truncated or validated, never a crash | ✅ (answer capped at 20 000) |
| C16 | **Unicode / emoji / RTL text** | Titles, comments and search with emoji and Arabic text round-trip | partial |
| C17 | **Rapid navigation** | Jumping between 10 pages leaves no stale panel or zombie subscription | partial |
| C18 | **Tab restore** | Reloading deep-links restores the same view (`?chat=`, page id, filters) | ✅ (`?chat=`) |

---

## 2. Chat / AI — the surface with the most interaction paths

Right-click on a chat answer is a first-class requirement (shared action set for mouse, keyboard and touch).

| # | Scenario | Steps | Expected | Automated |
| --- | --- | --- | --- | --- |
| A1 | **Right-click an answer** | hover an assistant message → right-click | Context menu appears at the cursor with *Copy answer · Copy as plain text · Save as new note · Ask a follow-up* | ✅ e2e |
| A2 | **Same actions without a mouse** | focus the message's `⋯` button → Enter | Dropdown with the identical items | ✅ (same component) |
| A3 | **Keyboard context menu** | focus message → `Shift+F10` (or the Menu key) | Context menu opens; arrows navigate; Escape closes and returns focus | manual |
| A4 | **Copy answer** | activate *Copy answer* | Clipboard holds the Markdown; toast confirms | manual |
| A5 | **Copy as plain text** | activate | Clipboard holds text with no `**`/`#`/`|` | manual |
| A6 | **Save as new note** | activate | A page is created with the same title as the answer's heading, content as real blocks (heading/list/table/code), toast names it, the menu switches to *Open "…"* | ✅ e2e |
| A7 | **No duplicate saves** | save, reload, right-click again | The item offers *Open*, not a second save; `meta.savedPageId` persisted | ✅ e2e |
| A8 | **Saved page fidelity** | open the saved page | Heading, bullets, table, fenced code all render as blocks; no raw Markdown | manual |
| A9 | **Right-click text** | right-click a paragraph outside any answer | No chat menu (the menu is scoped to messages) | manual |
| A10 | **Escape closes the panel** | press Escape with the composer focused | Panel closes; no message lost | ✅ implemented, test pending |
| A11 | **Deep link** | open `/w/<slug>?chat=<threadId>` | Panel opens on that thread; reload keeps it | ✅ e2e |
| A12 | **Unknown thread id** | open `?chat=does-not-exist` | Empty "new conversation" state; no error, no data leak | manual |
| A13 | **Follow-up** | activate *Ask a follow-up* | Composer prefilled, focus in the composer, not auto-sent | manual |
| A14 | **Streaming** | ask a long question | Tokens appear progressively; cancel is possible | ✗ (F-14) |
| A15 | **Provider failure** | exercise with an invalid key | Toast explains the failure; the user's draft is restored; composer re-enabled | ✅ check:ai |
| A16 | **Grounding** | ask "what are my projects?" | Answer cites workspace data with note chips; no invented projects | ✅ check:ai |
| A17 | **Markdown rendering** | answer with heading/bold/list/table/code/ref | All render as HTML; `**x**` and `## x` never reach the screen | ✅ e2e |
| A18 | **XSS attempt** | answer containing `<img onerror=…>` / `javascript:` link | Rendered as text; no script execution | ✅ unit |
| A19 | **Thread list** | create, rename, delete a conversation | Sidebar list and panel stay in sync; deleting the open thread falls back to the empty state | partial |
| A20 | **Tool activity** | ask an intent-routed question | The answer header lists the tools used and the model | ✅ |

---

## 3. Editor & blocks

| # | Scenario | Expected |
| --- | --- | --- |
| E1 | Type, save on blur, reload | Content identical; no `$T`/attrs crash |
| E2 | Markdown paste | Headings/lists/tables become real blocks |
| E3 | LaTeX `$x^2$` inline and block | Renders KaTeX; click opens the equation dialog with live preview |
| E4 | Slash menu | Keyboard navigable, inserts each block type, Escape closes |
| E5 | Drag handle + context menu | Move up/down respects nesting; duplicate/delete/colour work |
| E6 | Mentions | `@` search inserts a mention chip; deleted target degrades to text |
| E7 | Tables | Add/remove row & column, header toggle, cell navigation |
| E8 | Undo/redo | `Ctrl+Z` / `Ctrl+Shift+Z` across block types |
| E9 | Version history | Every save snapshots; restore reverts content and reports who/when |
| E10 | Locking | Locked page is read-only for everyone but admins; the toggle is in the `⋯` menu |
| E11 | Concurrency | Two tabs editing the same page do not resurrect deleted blocks |
| E12 | Very long doc | 1 000 blocks stay responsive when scrolling and typing |

## 4. Databases

| # | Scenario | Expected |
| --- | --- | --- |
| D1 | Seven view types | Each renders, switches without losing filters |
| D2 | Filters / sorts / groups | Combined predicates; group colours persist per view |
| D3 | Properties | Every type edits inline; system properties are read-only |
| D4 | Formulas / rollups / relations | Recomputed on change; cycles rejected with a message |
| D5 | Templates + recurrence | Apply template; cron materialises due rows once (see §7) |
| D6 | CSV import/export | Round-trip preserves headers and types |
| D7 | Side peek | Opens without losing scroll; Escape closes; edits save |
| D8 | Keyboard grid | Arrow navigation, Enter to edit, Escape to cancel, Tab adds a row |
| D9 | Search inside a view | Filters rows as you type; empty result explains itself |

## 5. Tickets, projects, planning

| # | Scenario | Expected |
| --- | --- | --- |
| T1 | Create with estimate + dates | Key assigned in order; appears in the chosen column |
| T2 | Board drag | Status changes, `completedAt` stamped when closed, activity logged |
| T3 | Timeline | Dated bars with today marker; undated tickets flagged |
| T4 | Labels | Toggle on/off; workspace label usage counts follow |
| T5 | Relations & comments | Links are workspace-scoped; comments record author/time |
| T6 | Bulk edit | Status/priority/assignee/project applied to every selection |
| T7 | Archive | Disappears from views and rollups; restorable |
| T8 | Project rollup | Project page counts and estimate sums match the tracker |
| T9 | Milestones + Gantt | Status transitions, date markers, client invites |
| T10 | Accessibility | Every control labelled; board columns announce counts |

## 6. Sharing, permissions, admin

| # | Scenario | Expected |
| --- | --- | --- |
| S1 | Share link | Public read; password gate; expiry enforced; revoke kills access |
| S2 | Page permissions | Member levels honoured; viewers cannot edit via crafted calls |
| S3 | Teamspaces | Members see and search only their teamspaces |
| S4 | Roles | Admin-only settings hidden for editors; server enforces the same |
| S5 | OIDC SSO | Login → callback → session; state/PKCE verified; replays rejected |
| S6 | API tokens | Scoped to the user; revoke invalidates immediately |
| S7 | Webhooks | HMAC signature matches; delivery log records status + attempts |
| S8 | OAuth apps | Authorize → code → token; code replay rejected |
| S9 | Trash | Restore, delete forever, empty trash; restoring a child of a trashed parent re-parents to root |
| S10 | Audit trail | Every change to a ticket records actor + kind + detail |

## 7. Operations & reliability

| # | Scenario | Expected |
| --- | --- | --- |
| O1 | Cron without secret | 401 (secret set) or 503 (secret missing) — never processes |
| O2 | Cron with secret | Materialises due templates once, advances `nextRunAt`, rate limited |
| O3 | Uploads | Size/type limits honoured (415 unsupported), served safely from `/api/files` |
| O4 | Export | Markdown/HTML/JSON/PDF/zip round-trip without loss |
| O5 | Import | MD/JSON/HTML/PDF/CSV/zip/Trello/docx/Notion all produce pages |
| O6 | Mail | SMTP send, templates, delivery log, invite flow (mock SMTP) |
| O7 | Search | Titles + bodies ranked; deleted and unauthorised pages excluded |
| O8 | Backup/restore | `pg_dump`/restore reproduces the workspace (manual, documented) |
| O9 | Migration | `prisma db push`/migrate on an empty database then `db:seed` |
| O10 | Health | Every route returns non-5xx under crawl (`check:routes`) |

## 8. Accessibility checklist (WCAG 2.2 AA, per surface)

Keyboard reachability · visible focus · accessible names on icon-only controls · `aria-current` on the active nav item · headings in order · landmark structure · 4.5:1 text contrast in both themes · 3:1 for UI borders · no motion without a reduced-motion fallback · escape closes overlays · error text associated with its field · focus trapped in dialogs and restored on close · live region announces async results (toasts are `aria-live`).

## 9. Definition of done (per feature)

1. `FEATURE_MATRIX.md` row updated (status matches reality) and `npm run docs:gaps` regenerated.
2. Backend: action authenticates, checks role, validates input, revalidates, logs where relevant.
3. UI: reachable control, empty/loading/error states, keyboard path, responsive, dark mode.
4. Tests: unit for pure logic, an e2e journey, a `check-*` probe for the API contract.
5. `npx tsc --noEmit`, `npm test`, `npx playwright test`, `npm run check:*` all green.
6. The relevant rows of §1 have been exercised by hand at least once (screenshot for visual work).

## 10. Gaps in this plan (tested by nobody yet)

- C12 (i18n/RTL) — blocked on F-08.
- A14 (streaming) — blocked on F-14.
- C13/C14 (throttled/offline) — currently manual only; automate with Playwright route interception once F-09 lands.
- C6 (session expiry mid-action) and C17 (rapid navigation) — manual, no automation.
- O8 (backup/restore) — documented, never rehearsed in CI.
