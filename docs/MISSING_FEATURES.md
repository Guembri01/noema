# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Status:** 563 feature rows — 455 implemented · 86 partial · 0 planned · 22 deliberately out of scope.

This file lists the **86** rows that are not finished, area by area, plus 22 intentional divergences.

## Read this first — highest-leverage gaps

| # | Gap | Why it matters | Area |
| --- | --- | --- | --- |
| 1 | **Filter tree UI** | The AND/OR filter tree already evaluates; the nested group builder UI is not exposed. | 3. Databases |
| 2 | **Conditional formatting** | ColorRule is modelled and evaluated; the rule-authoring and render path are partial. | 3. Databases |
| 3 | **Form view** | No ViewType.FORM yet; the builder + public submit path are spec'd but unwired. | 3. Databases |
| 4 | **Linked database writes** | View identity, filters/sorts and overrides shipped; write-through and the in-block override editor are pending. | 3. Databases |
| 5 | **Synced blocks** | Mirror one block's content in many places with a canonical source marker. | 1. Editor & blocks |
| 6 | **Suggestions mode** | Propose edits for approval with a diff overlay. | 7. Collaboration |
| 7 | **Comment depth** | Server-side depth validation, block anchors and dispatch scoping on page threads. | 7. Collaboration |
| 8 | **Notification inbox & preferences** | Per-user delivery preferences, digests and PageFollow dispatch are missing. | 7. Collaboration |
| 9 | **Pagination everywhere** | Databases, tickets and audit lists load bounded sets; cursor pagination is pending. | 17. Data model & platform |
| 10 | **Audit log UI** | Activity is recorded per ticket/page; a workspace-wide, filterable audit view is missing. | 8. Sharing & permissions |
| 11 | **Object storage & backups** | Uploads and scheduled backups to S3-compatible storage. | 17. Data model & platform |
| 12 | **SAML SSO** | OIDC is implemented and tested; SAML needs a provider-agnostic strategy layer. | 8. Sharing & permissions |
| 13 | **Undo/redo (global)** | App-wide undo beyond the editor's local history. | 16. Navigation & UX |
| 14 | **Self-hosting & auth** | Packaging, provider-agnostic sign-in and documented deployment remain. | 17. Data model & platform |

## By area

### 1. Editor & blocks

86 done · 12 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Synced block | Mirror one block's content in many places. | 🟡 | Planned via reference ids; editing propagation needs care. |
| Synced block source marker | Visual marker of the canonical source. | 🟡 | Planned. |
| Template button block | Reusable set of blocks inserted on click. | 🟡 | Planned; depends on template subsystem. |
| Button block | Interactive button triggering configured actions. | 🟡 | Planned; depends on automations. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🟡 | Planned; depends on AI layer and provider keys. |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Linked view of a database | Re-display an existing database elsewhere. | 🟡 | The editor node binds to a chosen source view, applies that view’s filters/sorts, and persists synced/detached overrides per node; a stale view id falls back to the source’s first view. Per-instance filter/sort editing and write-through are still pending. |
| Drag to another page | Move a block into a different page. | 🟡 | Planned. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

21 done · 0 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 3. Databases

44 done · 9 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| AND/OR filter groups | Boolean combination of filters. | 🟡 | Planned as a filter tree. FilterNode tree already evaluates (database-query.ts:66); tree UI spec'd: docs/specs/database-deep.md (R89.2). |
| Nested filter groups | Arbitrary-depth boolean nesting. | 🟡 | Planned after flat groups. Spec'd with the tree UI: docs/specs/database-deep.md (R89.2). |
| Conditional formatting | Color rows/cells by rule. | 🟡 | Planned. ColorRule already modelled in view config (database-query.ts:68); rule editor + evaluation spec'd: docs/specs/database-deep.md (R89.5). |
| Row color rules | Two-tone row backgrounds. | 🟡 | Planned subset of conditional formatting. Spec'd: docs/specs/database-deep.md (R89.5). |
| Linked database | Reuse a database elsewhere. | 🟡 | Source-view binding, filters/sorts, view picker, synced/detached overrides and stale-id fallback shipped; linked-mode row writes and the in-block override editor remain (R89.14/R89.15). Covered by `linked-database.fix04.test.ts` and the guest-scope action test. |
| Sub-items / sub-tasks | Parent-child rows inside a database. | 🟡 | Planned; tree ordering needed. Page.subOfId (depth cap 1) spec'd independent of relations: docs/specs/database-deep.md (R89.30). |
| Dependencies | Blocking/blocked-by between rows. | 🟡 | Planned; mainly for timeline. RowDependency join model with cycle guard spec'd: docs/specs/database-deep.md (R89.31). |
| Timeline dependencies | Draw dependency arrows on timeline. | 🟡 | Planned. Arrow rendering inside the gantt depth spec: docs/specs/database-deep.md (R89.31 with R89.11). |
| Recurring templates | Create rows on a schedule. | 🟡 | Planned; depends on a scheduler. Core (resolver/nextRun/cron driver) owned by docs/specs/templates.md (R31.18-R31.23); database-side surfacing + system-actor materialization spec'd: docs/specs/database-deep.md (R89.17). |

### 4. Properties

27 done · 8 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Relation property | Link rows across databases. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (single) | One linked row. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (multi) | Many linked rows. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Two-way relation | Reciprocal relation property. | 🟡 | Planned; requires pair metadata. Spec: docs/specs/relations-rollups.md. |
| Rollup property | Aggregate across a relation. | 🟡 | Planned; depends on relations. Spec: docs/specs/relations-rollups.md. |
| Rollup functions | Count, sum, average, min/max, join, etc. | 🟡 | Planned function set. Spec: docs/specs/relations-rollups.md. |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| AI autofill property | AI-generated value per row. | 🟡 | Planned; depends on AI layer. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

### 5. Formulas

15 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Formula editor | Author expressions with autocomplete. | 🟡 | Planned; expression parser first. Spec: docs/specs/formula-engine.md. |

### 6. Templates

6 done · 3 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page templates | Duplicate a page for reuse. | 🟡 | Duplicate-page works; gallery UI missing. Spec: docs/specs/templates.md. |
| Recurring templates | Scheduled row creation. | 🟡 | Planned; needs scheduler. Spec: docs/specs/templates.md. |
| Template duplication | Clone a template into a page. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. B80 blocked-row triage: docs/specs/templates.md:308 + docs/specs/workspaces-structure.md §4 (editor-slot dependency). |

### 7. Collaboration

21 done · 5 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Real-time multiplayer editing | Multiple users edit simultaneously. | 🟡 | Planned; local-first CRDT then sync. Spec: docs/specs/realtime-collab.md. |
| CRDT data model | Conflict-free replicated structures. | 🟡 | Planned (automerge/Yjs-style). Spec: docs/specs/realtime-collab.md. |
| Presence | See who is viewing a page. | 🟡 | Planned. |
| Live cursors | Remote carets and selections. | 🟡 | Planned; needs presence transport. |
| Coarse edit locks | Prevent simultaneous structural edits. | 🟡 | Planned fallback before full CRDT. |

### 8. Sharing & permissions

20 done · 2 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Owner role | Full control of the workspace. | 🟡 | Modeled; transfer flows missing. |
| Move pages across workspaces | Relocate content between workspaces. | 🟡 | Planned; id-remap complexity. |

### 9. Workspaces & structure

20 done · 3 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Trash / recently deleted | Deleted pages list. | 🟡 | Soft delete exists; trash UI partial. |
| Restore from trash | Undo a deletion. | 🟡 | Planned. |
| Permanent delete | Permanently remove an item. | 🟡 | Planned; purge job needed. |

### 13. Integrations & API

16 done · 6 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Slack integration | Unfurl and post links. | 🟡 | Planned. |
| GitHub integration | Link commits/PRs. | 🟡 | Planned. |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |
| Inbound webhooks | Accept events from outside. | 🟡 | Planned. |
| Public embed oEmbed | Resolve third-party link metadata. | 🟡 | Basic title/favicon fetch. |

### 14. AI

7 done · 9 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| AI autofill property | Generate row values. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Summarization | Summarize a page or section. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Translation | Translate selection or page. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Continue writing | Extend text from context. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Explain/Simplify | Rewrite for clarity. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Local model support | Run models without a cloud. | 🟡 | Planned; aligns with self-hosting. Spec: docs/specs/ai-surface.md. |
| Prompt library | Reusable saved prompts. | 🟡 | Seven built-in AI skills with server-side prompts (`src/lib/ai-skills.ts`); user-defined prompts pending. Spec: docs/specs/ai-surface.md. |
| AI cost controls | Token budgets per workspace. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| AI data boundaries | Guarantee no training on your data. | 🟡 | Planned; documented policy. Spec: docs/specs/ai-surface.md. |

### 15. Media & embeds

19 done · 2 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| Animated GIF/devices | Play GIFs and device previews. | 🟡 | Planned. |

### 16. Navigation & UX

44 done · 3 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Focus management | Visible focus and traps. | 🟡 | Global `:focus-visible` ring everywhere; B45 hardened `ui/dialog` — Tab/Shift+Tab cycle inside with wrap, explicit `aria-modal="true"`, initial focus in-dialog, and focus restored to the invoker even for trigger-less controlled dialogs — plus `ui/dropdown-menu` (Escape → focus back to its trigger); both locked by `e2e/focus.spec.ts`. Still partial: hand-rolled feature overlays bypass the primitive entirely — `topbar/actions-menu`, `who-has-access`, `version-history`, `tickets/ticket-drawer`, `editor/equation-editor` have no Tab trap, Escape only works in the actions menu and equation editor, and `version-history` / `ticket-drawer` also lack `aria-modal` → feature-level follow-up (feature components are off-limits to B45). |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Undo/redo (global) | App-wide undo beyond editor. | 🟡 | Planned. |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

### 17. Data model & platform

23 done · 14 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page snapshots | Versioned page state. | 🟡 | Planned; basis for history. |
| Incremental syncing | Sync only changed blocks. | 🟡 | Planned; op-log approach. |
| Offline cache | Local store for offline use. | 🟡 | Planned (IndexedDB/SQLite). |
| Sync conflict handling | Merge concurrent edits. | 🟡 | Planned; CRDT. |
| Transactions / atomic writes | All-or-nothing updates. | 🟡 | Planned; Prisma transactions. Spec: docs/specs/engineering-hardening.md. |
| Multi-tenancy | Isolate workspaces. | 🟡 | Workspace scoping modeled. |
| Restore from backup | Recover data. | 🟡 | Planned. |
| Observability | Logs, metrics, traces. | 🟡 | Planned; OpenTelemetry. |
| Error tracking | Capture and triage errors. | 🟡 | Planned. |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Session management | Expire and revoke sessions. | 🟡 | Sessions stored; revocation partial. Spec: docs/specs/engineering-hardening.md. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. Spec: docs/specs/engineering-hardening.md. |
| Background jobs | Async task runner. | 🟡 | Planned; queue for imports/AI. |
| GDPR data controls | Delete/export personal data. | 🟡 | Planned; admin tooling. |

### 18. Pricing & plan-gated features

8 done · 6 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| File upload limits by plan | Cap storage per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| Version-history retention by plan | Longer history on paid plans. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| AI usage limits by plan | Token budget per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| Self-hosted license option | Run enterprise features locally. | 🟡 | Planned; open-core consideration. Spec: docs/specs/plans-licensing.md. |
| Billing integration | Payment provider hooks. | 🟡 | Planned; provider-agnostic. Spec: docs/specs/plans-licensing.md. |
| Usage metering | Track consumption per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |

### 19. Known limitations & quirks

0 done · 0 partial · 0 planned · 15 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Cloud-only history depth | Some tiers limit history length. | ⛔ | Noema keeps configurable local history; divergence. |
| No offline-first guarantee | Some apps require connectivity. | ⛔ | Noema is local-first by design; divergence. |
| Vendor data residency | Content lives on vendor servers. | ⛔ | Self-hosting keeps data on your infra; divergence. |
| Opaque sync conflicts | Silent last-writer-wins behavior. | ⛔ | Noema uses CRDT with visible provenance. |
| Limited export fidelity | Exports lose some structure. | ⛔ | Noema targets lossless round-trips. |
| Steep permissions model | Complex inheritance surprises. | ⛔ | Noema makes inheritance explicit and previewable. |
| Performance on huge pages | Very large pages degrade. | ⛔ | Noema virtualizes blocks and lags less. |
| Formula language quirks | Subtle type/precedence gotchas. | ⛔ | Noema documents semantics precisely. |
| Two-way relation setup friction | Relations confuse new users. | ⛔ | Noema offers guided relation creation. |
| Recurring template scheduler | Limited scheduling control. | ⛔ | Noema exposes cron-style control. |
| Search relevance opacity | Ranking is hard to tune. | ⛔ | Noema exposes ranking knobs. |
| Migration lock-in | Hard to leave the platform. | ⛔ | Noema prioritizes portable data; divergence. |
| AI vendor lock-in | AI options tied to one vendor. | ⛔ | Noema supports BYO/local models; divergence. |
| Third-party tracking | Hosted analytics on public pages. | ⛔ | Noema ships no trackers by default; divergence. |
| Mandatory accounts for sharing | Viewers may need accounts. | ⛔ | Noema plans lightweight guest viewing. |

### 20. Projects, tickets & planning

29 done · 3 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Roadmap view | Timeline across projects. | 🟡 | Project Gantt exists; a cross-project roadmap view is pending. |
| Recurring tickets | Repeat on a schedule. | 🟡 | Planned; template recurrence exists for page templates. Spec: docs/specs/automations.md. |
| Per-project role editor | Fine-grained project roles. | 🟡 | Planned; workspace roles exist today. |

