# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Status:** 565 feature rows — 482 implemented · 61 partial · 0 planned · 22 deliberately out of scope.

This file lists the **61** rows that are not finished, area by area, plus 22 intentional divergences.

## Read this first — highest-leverage gaps

| # | Gap | Why it matters | Area |
| --- | --- | --- | --- |
| 1 | **SAML SSO** | Login, per-workspace connections, domain auto-join, metadata rotation, SLO, settings/activity UI, invite precedence and SCIM Users/Groups→teamspaces+roles are implemented; a dry test-connection action and split per-IdP pages remain. | 8. Sharing & permissions |
| 2 | **Undo/redo (global)** | Page rename/icon/cover/move/archive/favorite/layout and property edits are undoable; bulk row actions and a history list remain. | 16. Navigation & UX |
| 3 | **Self-hosting & auth** | Packaging, provider-agnostic sign-in and documented deployment remain. | 17. Data model & platform |

## By area

### 1. Editor & blocks

90 done · 9 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Template button block | Reusable set of blocks inserted on click. | 🟡 | Planned; depends on template subsystem. |
| Button block | Interactive button triggering configured actions. | 🟡 | Planned; depends on automations. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🟡 | Planned; depends on AI layer and provider keys. |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Drag to another page | Move a block into a different page. | 🟡 | Planned. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

21 done · 0 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 3. Databases

51 done · 2 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Form view | Public/Internal form that creates rows. | 🟡 | The internal FORM view is wired end-to-end: ViewType.FORM (schema, canonical type list, view menu and action guards), the respondent renderer, validation, an inline builder (title/description/questions/required/order/accepting/submit copy) and atomic row creation through submitFormAction (server re-authorization, stored-schema revalidation, per-user/per-address throttles, row + cells in one transaction). Public forms publish one view through ShareLink.viewId at /s/<token>: the builder creates/copies/revokes the link and shows response count, the route handles password/expiry/unlock, and submitPublicFormAction applies per-address/link throttles plus stored-schema revalidation and an atomic row+cells write. Public links intentionally hide PEOPLE/FILES/VERIFICATION questions because those editors need a signed-in session; internal forms keep them. |
| Recurring templates | Create rows on a schedule. | 🟡 | Planned; depends on a scheduler. Core (resolver/nextRun/cron driver) owned by docs/specs/templates.md (R31.18-R31.23); database-side surfacing + system-actor materialization spec'd: docs/specs/database-deep.md (R89.17). |

### 4. Properties

34 done · 1 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
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

19 done · 7 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Real-time multiplayer editing | Multiple users edit simultaneously. | 🟡 | Planned; local-first CRDT then sync. Spec: docs/specs/realtime-collab.md. |
| CRDT data model | Conflict-free replicated structures. | 🟡 | Planned (automerge/Yjs-style). Spec: docs/specs/realtime-collab.md. |
| Presence | See who is viewing a page. | 🟡 | Planned. |
| Live cursors | Remote carets and selections. | 🟡 | Planned; needs presence transport. |
| Inline comments | Comments anchored to a text range. | 🟡 | The bubble toolbar and the block context menu both resolve the top-level block id (`blockIdAt` / `blockAnchorId`) and dispatch `{ quote, blockId }`; the panel keeps the anchor in composer state, forwards it to `addCommentAction` for roots only (replies inherit their thread), the page route projects `blockId`, and a stored anchor renders a **Jump to block** button that scrolls the editor to `[data-block-id]`. The persisted shape still has no selection `from`/`to` offsets and no inline highlight, so exact range rendering remains open. R79.3. |
| Comment mentions | Mention people in comments. | 🟡 | `@Name`, `@first`, `@ada@example.com` notify matching workspace members (`page.mention`); matching is a tested pure helper. Targets are the current `workspaceMember` rows, the author is skipped, and a guest target is filtered through `guestReadablePageIds` so a guest outside the page read scope receives neither the notification nor its `pageId`. Still open: no cross-event coalescing, edits do not re-dispatch, and inline `@user` nodes in page content dispatch nothing. R79.4. |
| Coarse edit locks | Prevent simultaneous structural edits. | 🟡 | Planned fallback before full CRDT. |

### 8. Sharing & permissions

21 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Move pages across workspaces | Relocate content between workspaces. | 🟡 | Planned; id-remap complexity. |

### 13. Integrations & API

18 done · 4 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Slack integration | Unfurl and post links. | 🟡 | Planned. |
| GitHub integration | Link commits/PRs. | 🟡 | Planned. |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |

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

46 done · 2 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Undo/redo (global) | App-wide undo beyond editor. | 🟡 | The global provider runs server effects attached to commands. Page rename, icon, cover, move, archive/restore, favorite, full-width, lock and database property edits now record invertible steps that persist through the server and refresh; rapid property edits coalesce into one step. Still open: bulk row actions and a visible history list. |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

### 17. Data model & platform

26 done · 11 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Incremental syncing | Sync only changed blocks. | 🟡 | Planned; op-log approach. |
| Offline cache | Local store for offline use. | 🟡 | Planned (IndexedDB/SQLite). |
| Sync conflict handling | Merge concurrent edits. | 🟡 | Planned; CRDT. |
| Transactions / atomic writes | All-or-nothing updates. | 🟡 | Planned; Prisma transactions. Spec: docs/specs/engineering-hardening.md. |
| Multi-tenancy | Isolate workspaces. | 🟡 | Workspace scoping modeled. |
| Observability | Logs, metrics, traces. | 🟡 | Planned; OpenTelemetry. |
| Error tracking | Capture and triage errors. | 🟡 | Planned. |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Session management | Expire and revoke sessions. | 🟡 | Sessions stored; revocation partial. Spec: docs/specs/engineering-hardening.md. |
| SSO / SAML | Enterprise single sign-on. | 🟡 | OIDC authorization-code + JWKS verification, and an **env-level SAML 2.0 connection** (`AUTH_SAML_*`): start/ACS/metadata/SLO routes, `@node-saml/node-saml` signature/audience/destination/condition validation with 120 s skew, a Postgres assertion replay cache, signed RelayState (no SameSite-cookie dependency on the cross-site POST), JIT users and verified-only account linking (B07). Both refuse an unverified local account with `?error=sso_email_taken`. Env-level directory auto-join maps `AUTH_SAML_GROUPS_ATTRIBUTE` through `AUTH_SAML_ROLE_RULES` into `AUTH_SAML_WORKSPACE_ID` (highest rule wins, OWNER is never granted, an existing owner is never demoted). Per-workspace `SsoConnection` rows, admin CRUD actions, `?connection=` start/metadata/ACS resolution and `VerifiedDomain` DNS verification are implemented; a verified email domain auto-joins its workspace when the env connection has no fixed workspace. Metadata-URL refresh parses the IdP document and rotates the signing certificate with a 24-hour previous-certificate overlap. SLO validates POST/redirect logout messages while always ending the local session. The **SSO settings section** manages connections, metadata refresh and verified domains (admin-only). SCIM **Users** endpoints are implemented with hashed bearer tokens, JIT user/membership creation, pagination, lookup, active=false deprovisioning and owner protection. SCIM **Groups** map to teamspaces (list/get/create/add/remove/replace members/delete), and group membership recomputes the mapped workspace role from the connection's `roleRules` (OWNER is never demoted). Login email-domain chooser, invite precedence for JIT users and the recent-SSO activity view are implemented. Remaining polish: a dry “Test connection” action and split per-IdP setup pages (docs/specs/saml-sso.md). Setup: docs/integrations/saml.md. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. Spec: docs/specs/engineering-hardening.md. |

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

