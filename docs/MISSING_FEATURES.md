# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Scoreboard:** 563 feature rows — 527 implemented · 14 partial · 0 planned · 22 deliberately out of scope.

This file lists the **14** rows that are not finished, area by area, plus 22 intentional divergences.

## Read this first — highest-leverage gaps

| # | Gap | Why it matters | Area |
| --- | --- | --- | --- |
| 1 | **Filter tree UI** | The AND/OR filter tree already evaluates; the nested group builder UI is not exposed. | 3. Databases |
| 2 | **Conditional formatting** | ColorRule is modelled and evaluated; the rule-authoring and render path are partial. | 3. Databases |
| 3 | **Form view** | No ViewType.FORM yet; the builder + public submit path are spec'd but unwired. | 3. Databases |
| 4 | **Linked database views** | The read-only node exists; view identity and per-instance overrides are missing. | 3. Databases |
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

95 done · 3 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Linked view of a database | Re-display an existing database elsewhere. | 🟡 | Planned; requires stable view model. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

21 done · 0 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 4. Properties

32 done · 3 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| Button property | Trigger actions from a row. | 🟡 | Planned. |
| Verification property | Verified-by-owner marker. | 🟡 | Planned; wiki-oriented. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

### 6. Templates

9 done · 0 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. B80 blocked-row triage: docs/specs/templates.md:308 + docs/specs/workspaces-structure.md §4 (editor-slot dependency). |

### 7. Collaboration

25 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Avatars | Per-user avatars in the UI. | 🟡 | Avatar field exists; presence UI pending. |

### 8. Sharing & permissions

19 done · 3 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Workspace roles | Owner/admin/member/guest roles. | 🟡 | Roles modeled; enforcement partial. |
| Owner role | Full control of the workspace. | 🟡 | Modeled; transfer flows missing. |
| Admin role | Manage members and settings. | 🟡 | Modeled; UI partial. |

### 9. Workspaces & structure

22 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page tree | Hierarchical page nesting. | 🟡 | Nesting works; B66 extracted the pure logic (flatten/group/expand/moveCandidates) to `src/lib/page-tree.ts` with 22 unit tests over a synthetic 1000-node tree — cycle guard, expand-state invariants, perf smoke (render plan 0.6 ms median ≪ 100 ms). React DOM render at 1000 nodes still unmeasured (no e2e by design). B80: bulk move + `movePageAction` containment guards specced (R80.7/R80.8) — docs/specs/workspaces-structure.md. |

### 12. Import & export

21 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Export Markdown | Page as `.md`. | 🟡 | Basic export; nested content partial. Spec: docs/specs/import-export.md. |

### 15. Media & embeds

19 done · 2 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| Animated GIF/devices | Play GIFs and device previews. | 🟡 | Planned. |

### 16. Navigation & UX

47 done · 0 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

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

