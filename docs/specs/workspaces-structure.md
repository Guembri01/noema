# Spec — Workspaces & structure (teamspaces vs spaces, page tree, invite lifecycle)

> **Status: spec complete, implementation pending.** Document-only: no
> production code was changed. Every claim about the
> current code cites file + line. Requirement IDs (`R80.x`) are the traceability
> anchors: §11 lists delivery tasks 1:1 against them, and tests must cite the
> IDs they cover. Matrix edits for this change are Notes-only entries in
> `docs/FEATURE_MATRIX.md` §9 plus the blocked row at `:345`; glyphs stay
> maintainer-owned. **B42 (trash)
> and B44 (favorites) own their code — this change read their files
> and changed nothing** (§13).

---

## 1. Problem statement

Section 9 of the matrix ("Workspaces & structure") is the most drift-prone area
in the status summary: rows disagree with each other (`Move page 🧭` at `:432` vs
`Page re-parenting ✅` at `:363`), rows disagree with the code (`Quick find 🧭`
at `:425` although `src/components/quick-find.tsx` ships and is guest-scoped),
and the two structural concepts the product is built on — **workspace** and
**teamspace** — are documented in `docs/GLOSSARY.md:9-10` as an access-scoping
mechanism that the code only half-enforces (it scopes guests, it does not scope
members).

Meanwhile three feature clusters in this section are genuinely unfinished and
need a written plan before implementation picks them up:

1. **Teamspace semantics vs spaces.** What a teamspace *is* (grouping? access
   boundary? both?), where it stops being a "space" and starts being a
   permission, and which of the current checks are load-bearing.
2. **Page-tree features.** Bulk move does not exist at all (the only bulk
   action in the app is `bulkUpdateTicketsAction`, `src/server/actions/tickets.ts:445`);
   `movePageAction` accepts a cross-workspace parent server-side; duplicate does
   not clone children despite the matrix parity claim; `Template from selection`
   (`:345`) is an explicitly ⛔ row that must be triaged, not silently forgotten.
3. **Guest & invite lifecycle.** Two invite models (`Invite`, `TeamspaceInvite`)
   with different token columns, different accept writers, different revoke
   surfaces — and accepts that are check-then-write without a transaction
   (already recorded as a defect in `docs/specs/engineering-hardening.md:78`).

This spec audits all three against the real files, freezes the semantics as
numbered requirements, and triages every remaining planned row of §9 so the
maintainers can reconcile glyphs from evidence instead of from memory.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Workspace model | `prisma/schema.prisma:120-151` (`Workspace`), `:152-164` (`WorkspaceMember`, unique per user, roles OWNER/ADMIN/MEMBER/GUEST) | Solid; a user may hold N memberships (no single-workspace constraint anywhere). |
| Workspace switcher | `src/components/sidebar.tsx:119-125` renders `WorkspaceSwitcher`; `src/components/sidebar/workspace-switcher.tsx:25-70` lists `workspaces`, current-check, role chip, "New workspace"; `/app` (`src/app/app/page.tsx:10-17`) redirects to the first workspace or offers creation (`createWorkspaceAction`, `src/server/actions/workspaces.ts:30`) | **Ships.** Matrix `:412/:413` say 🧭 "Planned; single-workspace first" — stale. Remaining gaps are organizational (no cross-workspace roll-up), not existence. |
| Teamspace model | `schema.prisma:495-508` (`Teamspace`), `:510-521` (`TeamspaceMember`, `role WorkspaceRole @default(MEMBER)`), `:525-540` (`TeamspaceInvite`: `tokenHash` unique, `@@unique([teamspaceId, email])`, `acceptedAt/acceptedById/expiresAt`); `Page.teamspaceId` `:197` with `onDelete: SetNull` `:222` | Modeled end-to-end. |
| Teamspace actions | `src/server/actions/teamspaces.ts` — create `:8-29` (workspace `canManageMembers` only; creator becomes teamspace `OWNER` `:23`), delete `:31-47`, add/remove member `:49-89`, `setPageTeamspaceAction` `:92-109` | All gated on workspace role (`src/lib/permissions.ts` `canManageMembers` = OWNER/ADMIN, `:31-33`; `canEditContent` = non-GUEST, `:27-29`). **No action validates that the *target* (userId, teamspaceId) belongs to the same workspace.** |
| Teamspace UI | `src/components/teamspace-manager.tsx` (create `:83`, member chip toggle `:138-160`, invite input `:203`, pending list `:255-271` + revoke `:271`); sidebar grouping `src/components/sidebar/page-tree.tsx:436-455` — teamspace headers over **root** pages only, unassigned roots under "Private pages" `:449-454` | Works. Any workspace member (including guests) can be chip-toggled in — server side does not check the target is even a member (R80.3). |
| Teamspace semantics enforcement | `src/lib/guest-access.ts:84-90` `pageScopeFor` returns `null` for every non-GUEST role; `guestVisiblePageIds` `:46-75` grants guests: `PagePermission` ∪ pages of *their* teamspaces ∪ pages they created, plus ancestors `:74` | **Asymmetric by design today:** teamspace membership *adds* visibility for guests; it *denies* nothing to members. GLOSSARY `:10` ("scopes access to its pages") overstates this. |
| TeamspaceMember.role | Writes: `teamspaces.ts:63,86`, `teamspace-invites.ts:84,183`; reads: `guest-access.ts:55` (selects `teamspaceId` only) | **No authorization path ever reads the role column** — it is inert (R80.5). |
| Workspace invite lifecycle | Create: `sendWorkspaceInviteAction` `src/server/actions/email.ts:237-317` (admin-gated, role whitelist `:250`, owner-address rejected `:256-258`, pending duplicates purged, `token = hashToken(raw)` stored, 14-day TTL, raw link only in the email, kind `workspace-invite`); list: `listWorkspaceInvites` `:332` → `settings/page.tsx:118,314`; revoke: `revokeWorkspaceInviteAction` `:319` → wired `email-settings.tsx:314`; **read**: `resolveWorkspaceInvite` `:404` behind `previewWorkspaceInviteAction` `:471`, rendered by `/invite/[token]` (`src/app/invite/[token]/page.tsx:50` — read-only, so a GET may be fetched by scanners and prefetchers); **accept**: the card's form POSTs to `acceptWorkspaceInviteAction` `:492` (`page.tsx:26,96`) | Complete loop: create → email → preview → accept/revoke. Both halves share `resolveWorkspaceInvite`: invalid/used/expired/email-match, then `workspaceMember.upsert` (**role from invite on create, existing role preserved**), optional `projectMember` CLIENT, `acceptedAt`, `revalidatePath("/w","layout")` (legal now that acceptance is a POST). Not transactional; `Invite` has no `acceptedById` (schema `:166-192`). |
| Teamspace invite lifecycle | `src/server/actions/teamspace-invites.ts` — TTL `:13`, admin gate `:29-41`, invite `:50-135` (existing workspace member/owner → **instant add** `:64-94` including guests; otherwise hashed single-use link, upsert revives and resets `acceptedAt` `:107-114`, SMTP kind `teamspace-invite` `:129`, raw link always returned for hand-share `:134`), revoke `:138-149`, **read**: `resolveTeamspaceInvite` `:171` behind `previewTeamspaceInviteAction` `:211`, **accept**: `acceptTeamspaceInviteAction` `:230-256` (invalid/used/expired/email-match `:192-205`, implies workspace membership `:238-244`, teamspace membership with invite role `:245-249`, `acceptedAt+acceptedById` `:250-253`) via `/invite/teamspace/[token]` (`src/app/invite/teamspace/[token]/page.tsx:43` reads, `:21,83` posts) | Complete loop, three non-atomic writes (defect D3). Roles are `MEMBER\|ADMIN` only (`:53,:62`; API route coerces the same, `src/app/api/invites/route.ts:55-70`, rate-limited 20/min). |
| Guest invite path | UI role select `GUEST\|MEMBER\|ADMIN` `src/components/members-manager.tsx:62,226-233`; API `POST /api/invites` maps `GUEST` on workspace target only; guest teardown: role change `workspaces.ts:136` (guest branch `:257-259`), removal `:178` (cleans `PagePermission` `:209`), leave `:215` (cleans own `PagePermission` `:235`) | Works; e2e coverage `e2e/noema.spec.ts:661-756` (role change/removal/owner protection) + guest scoping suite `:1098+`. **Gap:** neither removal path cleans `TeamspaceMember` rows (grep of `prisma.teamspaceMember.` shows only 5 sites — invites, add/remove teamspace, guest read). |
| Guest visibility query | `guestVisiblePageIds` `guest-access.ts:46-75`; used by tree/search/page route; **backlinks bypass it** — `getBacklinks(workspace.id, page.id)` called without the optional `visiblePageIds` third argument (`src/app/w/[slug]/[pageId]/page.tsx:56`; query at `src/server/queries.ts:369-389`) | Real scoping gap (D6). |
| Page tree — pure lib | `src/lib/page-tree.ts`: `groupByParent :14`, `visibleChildren :31`, `flattenVisible :50`, `toggleExpanded :71`, `moveCandidates :88-108` (fix-point descendant block, capped at 12); 22 tests over a 1000-node synthetic tree in `src/lib/page-tree.test.ts` (B66, matrix `:418`) | The sandbox for every new tree algorithm (the domain sandbox). |
| Page tree — move | Server: `movePageAction` `src/server/actions/pages.ts:285-323` — authorize + `canEditContent`, self-parent, cycle walk `:297-313`, position append `:315-320`. **No same-workspace check on `parentId`, no trashed-parent check.** UI: sidebar "Move to" `page-tree.tsx:373` (targets pre-filtered in `page-menu.ts:168-180`) and page menu `page-title.tsx:204` | Works from the UI; the server action trusts the client for workspace containment (D2). |
| Page tree — bulk | Nothing: the only bulk action in `src/` is tickets (`bulkUpdateTicketsAction`, `tickets.ts:445-480`); no multi-select/checkbox state in `sidebar/page-tree.tsx` | **Bulk move absent** (D1). |
| Page tree — duplicate | `duplicatePageAction` `src/server/actions/page-menu.ts:229-281`: copies one row (title/icon/content/teamspace/project/searchText), same parent — **no children walk, no relation remap**, despite matrix `:431` "Clone a page with children … Works; relation remap partial" (D4). | Partial; parity claim overstated. |
| Recent pages | No visit source anywhere: grep for `lastVisited\|visitedAt\|PageVisit\|recentlyVisited` over `src/` + `prisma/` → 0 hits; the only "recent" surface is "Recently deleted" (`settings`/home, `src/app/w/[slug]/page.tsx:48`, i18n `:414`) | 🧭 `:420` is honest — needs a data source first. |
| Quick find | `src/components/quick-find.tsx` (cmdk) + `quickFindAction` `src/server/actions/search.ts:20-36` — `pageScopeFor` scoped, take 8; sidebar entry with `Ctrl K` `sidebar.tsx:126-136`; shell wiring `workspace-shell.tsx:54,158` | **Ships and is guest-scoped.** Matrix `:425` 🧭 stale (row `:421` already credits the entry point). |
| Backlinks / linked references | `getBacklinks` `queries.ts:369-389` (workspace-wide scan, `take: 1000`, in-process `docMentionsPage`), `Backlinks` panel `src/components/backlinks.tsx:5-6`, rendered `page.tsx:213`, i18n `linkedReferences` `i18n.ts:589`; probe script `scripts/check-backlinks.mjs` asserts the panel + mention chip | **Ships.** Matrix `:426/:427` 🧭 stale. Gaps: guest scoping (D6), O(workspace) scan per render, silent 1000-page cap (D7). |
| Workspace settings | `src/app/w/[slug]/settings/page.tsx` composes Members, Teamspaces, AI, Email, Labels, API tokens, 2FA, Sessions, OAuth apps, Webhooks, Activity, Danger zone (imports `:1-36`); e2e `noema.spec.ts:363-377` covers teamspace create+invite there | Substantially built; "billing" (matrix `:433`) does not exist and belongs to `docs/specs/plans-licensing.md`. |
| Template from selection | Matrix `:345` ⛔ "Uncommon flow; skip initially"; already triaged as a non-goal in `docs/specs/templates.md:308-310` (needs editor-slot block-selection capture) | Deliberately blocked — this spec confirms and cross-links the block (§4, Non-goals). |
| SSO ↔ teamspaces | `scripts/check-sso-teamspaces.mjs` (8 KB check), future mapping `docs/specs/saml-sso.md:208` | Out of scope here; referenced only. |

### 2.2 What the product class (Notion) does

1. **Teamspaces are real spaces** — a teamspace has its own membership, its own
   default access, and *denies* non-members: a workspace member sees only the
   teamspaces they belong to plus their private pages.
2. **Private / Teamspaces / Shared sections** in the sidebar, with drag between
   sections changing ownership semantics (private ↔ teamspace), not just a
   grouping label.
3. **Multi-select in the tree**: shift/⌘-click, then bulk move / duplicate /
   delete with one confirmation and a visible target picker.
4. **Duplicate clones the subtree** (and says so: "Duplicate with children").
5. **Recent** is a first-class sidebar section fed by visit history, and
   **Quick find** is the ⌘P-style switcher over the same recents.
6. **Invite lifecycle**: pending list with role, expiry countdown, revoke, and
   "resend"; accepts are single-use and idempotent; guests are invited to
   *pages/spaces*, never implicitly promoted.

### 2.3 Defects in the current path (must be fixed by this feature)

- **D1 — no bulk tree operations.** Multi-page select/move/duplicate simply
  does not exist (§2.1); every re-org is N manual drags.
- **D2 — `movePageAction` trusts the client for containment.** `pages.ts:285-323`
  validates cycles but not that `parentId` is a non-trashed page *of the same
  workspace*. A foreign `parentId` orphans the page from every sidebar render
  (grouping filters on membership of the fetched tree, `page-tree.tsx:436-454`).
- **D3 — invite accepts are check-then-write, non-atomic.**
  `acceptTeamspaceInviteAction` performs three sequential writes
  (`teamspace-invites.ts:176-191`), `acceptWorkspaceInviteAction` performs up
  to three (`email.ts:344+`); the `acceptedAt` guard is read-then-write, so two
  concurrent accepts can both pass. Already logged at
  `docs/specs/engineering-hardening.md:78`.
- **D4 — duplicate lies about children.** `page-menu.ts:229-281` copies one
  page; matrix `:431` claims subtree cloning.
- **D5 — teamspace targets unvalidated.** `setPageTeamspaceAction`
  (`teamspaces.ts:92-109`) accepts any `teamspaceId` (cross-workspace → the
  page matches no sidebar group and vanishes); `addTeamspaceMemberAction`
  (`:49-70`) accepts any `userId` (non-member rows that no UI can manage).
- **D6 — backlinks are not guest-scoped.** `page.tsx:56` omits the
  `visiblePageIds` argument that `getBacklinks` already supports
  (`queries.ts:369-374`): a guest reading a shared page sees titles + icons of
  *every* page that mentions it, including pages they may not open.
- **D7 — backlink scan is O(workspace) and silently capped.** 1000-page scan
  with in-process mention parsing per page render; no index, no pagination.
- **D8 — stale teamspace rows on member removal.** Removing a member from the
  workspace (`workspaces.ts:178`) or leaving (`:215`) never deletes
  `TeamspaceMember` rows (grep: 5 write sites, none in `workspaces.ts`).
- **D9 — documented semantics drift.** GLOSSARY `:10` promises teamspace access
  scoping that exists only for guests (`pageScopeFor` short-circuit,
  `guest-access.ts:84-90`); matrix rows `:412,:413,:425,:426,:427,:432` contradict
  shipped code.

## 3. Decision

| Option | Fit | Verdict |
| --- | --- | --- |
| **A. Keep teamspace as *additive* visibility + organizational grouping; make the invariant explicit and tested** (scopes guests, denies no member) | Matches every existing read path (`pageScopeFor` null for members is load-bearing for performance: no per-page filtering for the common case); zero schema change; guests — the population that needs scoping — already get it | **Chosen for this spec.** Documented in GLOSSARY fix + guarded by R80.1's test. |
| B. Notion-style enforcement (members denied outside their teamspaces) | Would flip `pageScopeFor` for *all* roles, adding an id-filter to every tree/search/page query, and changes visible behavior for every existing member (pages would "disappear" for non-members of a teamspace) | Rejected as default; recorded as **O80.1** — a deliberate future product decision with its own benchmark, not a side effect of this change. |
| C. Merge teamspace into plain folders (drop the concept) | Deletes a shipped ✅ area (matrix `:417,:395`), an e2e (`noema.spec.ts:363+`), the SSO check harness, and the guest-visibility source | Rejected — worse parity. |

**Decision: A.** The rest of this spec hardens what exists (R80.1-R80.7,
R80.14-R80.20), ships the missing tree features (R80.8-R80.11), and reconciles
the drift (§13).

## 4. Requirements (numbered, testable)

### Teamspace semantics (vs spaces)

- **R80.1** — The semantics invariant is written down and test-locked:
  *teamspace membership adds visibility (guests) and grouping (everyone); it
  never removes visibility from a non-guest.* Concretely: (a) `docs/GLOSSARY.md:10`
  is corrected to say scoping applies to guests; (b) a unit test asserts
  `pageScopeFor(user, ws, role)` returns `null` for `OWNER/ADMIN/MEMBER` and a
  `Set` for `GUEST` (`guest-access.ts:84-90`); flipping to Notion semantics
  later must break that test on purpose (O80.1).
- **R80.2** — `setPageTeamspaceAction` (`teamspaces.ts:92-109`) rejects, with
  an error and **no write**: (i) a `teamspaceId` that belongs to a different
  workspace than the page, (ii) a trashed page. Red-first: pure helper
  (`assertSameWorkspaceTeamspace(pageWorkspaceId, teamspaceWorkspaceId)` in
  `src/lib/` or exported from the actions' test seam) + action test with a
  foreign teamspace id asserting `page.update` was never called (fixes D5i).
- **R80.3** — `addTeamspaceMemberAction` / `removeTeamspaceMemberAction`
  verify the target `userId` holds a `WorkspaceMember` row in the teamspace's
  workspace before writing (same guard style as `page-permissions.ts:71-76`,
  "That person is not a member of this workspace."). Guests **may** be added —
  that is the explicit path by which a guest joins a teamspace (there is no
  invite path: roles are `MEMBER|ADMIN`, `teamspace-invites.ts:53,62`) — but it
  must be a deliberate, tested call, never an unchecked id (fixes D5ii,
  completes R80.18).
- **R80.4** — `deleteTeamspaceAction` (`teamspaces.ts:31-47`) is contractually
  *non-destructive to pages*: rely on `onDelete: SetNull` (`schema.prisma:222`),
  and make the UI confirm with the number of pages that will fall back to
  Private. Post-condition (e2e): after deleting a teamspace that owned 2 root
  pages, both pages still open and render under "Private pages"
  (`page-tree.tsx:449-454`).
- **R80.5** — `TeamspaceMember.role` is documented as **inert** (no read path —
  audit §2.1) so nobody builds on it accidentally: note in GLOSSARY + a comment
  at `schema.prisma:513`. Promotion to teamspace-scoped roles = O80.2 (M3),
  requiring its own spec slice.
- **R80.6** — One authorization sentence for every teamspace mutation:
  workspace `canManageMembers` (OWNER/ADMIN). The error copy in
  `authorizeTeamspace` (`teamspace-invites.ts:38`, "Only workspace admins can
  manage teamspace members") must match the grant list (owners can too) — fix
  copy, keep behavior; a unit table covers owner/admin/member/guest ×
  create/delete/invite/revoke/add-member.

### Page-tree features

- **R80.7** — `movePageAction` gains server-side containment checks (fixes
  D2): the new parent must exist, be in the same `workspaceId`, and not be
  trashed; otherwise a typed error and the row is unchanged. Red-first: action
  test with a foreign-workspace `parentId` (mocked prisma, pattern of
  `src/server/actions/workspaces.test.ts`), plus the existing cycle-walk tests
  cited by id.
  **Shipped (B08), and widened to every write path.** The check is one
  helper — `assertScopedParent({ workspaceId, parentId, pageId? })` in
  `src/lib/page-parent.ts` — that loads the parent **tenant-scoped**
  (`{ id, workspaceId }`), so a foreign parent is never read and the refusal
  (`That parent page does not exist in this workspace.`) never names it. It
  guards `createPageAction`, `movePageAction`, `POST /api/v1/pages`, the MCP
  tool `create_page`, the template routes and actions, every importer
  (Notion, Docx, Trello, Zip, Markdown, CSV, HTML, PDF), the chat-answer save
  and the page/database duplicate paths. The **invariant** it enforces:
  *a `parentId` always points inside the same workspace*. The read side
  follows: `getDatabase`, the relation database, both export routes, the
  "Deleted rows" panel, the database duplicate and the two chat-context
  blocks (the database block and the current-page block) filter a database's
  rows by the database's workspace — eight read sites in all — so a row that
  was linked across workspaces before the fix no longer surfaces in the
  foreign workspace's views, and the duplicate no longer copies such a row
  **with its content**. The invariant
  is **checked mechanically where the gate can see it**:
  `scripts/check-parent-scope.mjs` finds the `Page.parentId` writes in `src/`
  statically — 31 of them, the same 31 an independent TypeScript-parser
  inventory finds — and fails when one of them stores a value the helper has
  not proved. It is a safety net over the tests, not a proof: a write it
  cannot recognise (a raw SQL write, a write outside `src/`, a member
  assignment such as `data.parentId = …`, the callers of an allow-listed
  helper) is not covered by it.
- **R80.8** — **Bulk move ships as a pure-logic-first feature.** (a) Selection
  model added to `src/lib/page-tree.ts` (multi-select set, shift-range over
  `flattenVisible` order, "all selected editable" predicate) with unit tests
  beside the existing 22; (b) `bulkMovePagesAction(pageIds[], parentId)`:
  rejects > 50 ids, applies the R80.7 checks per id, rejects any selection
  containing an ancestor of another selected id (subsumption), runs in one
  `prisma.$transaction`, and returns `{ moved, skipped: [{id, reason}] }`;
  (c) sidebar selection UI (checkbox/shift-click + a Move to entry reusing the
  existing target dialog, `page-tree.tsx:373`) — **file ownership note:** the
  implementation must queue behind whoever holds the sidebar/editor slot
  (tier rule: one writer per file).
- **R80.9** — Bulk scope boundary (anti-collision): this feature ships **move
  only**. Bulk delete/restore stays with **B42** (trash), bulk favorite with
  **B44**, bulk duplicate is deferred until R80.10 lands (they share the
  subtree-walk helper).
- **R80.10** — `duplicatePageAction` (`page-menu.ts:229-281`) clones the
  subtree: BFS over children in position order, depth-preserving, positions
  re-based per parent, one transaction; relation `PropertyValue`s whose
  `pageId` endpoints are both inside the copied set are remapped to the copies,
  cross-boundary relations stay pointing at the originals (documented rule).
  This makes matrix `:431` ("Clone a page with children") true; the
  "relation remap partial" note is replaced by the explicit rule above.
- **R80.11** — **Recent pages** (`:420`) gets its data source before its UI:
  decision = server-side `Page.lastVisitedAt` (nullable, indexed), written
  debounced (≥ 60 s per page per session) from the page route, M3 and
  **schema-change/Tier HEAVY**. The sidebar "Recent" section then lists top 10 per
  workspace, guest-scoped via `pageScopeFor`. Rejected alternative: localStorage
  recents — device-bound and proven insufficient by the B11 notify-me finding;
  parity needs cross-device. Until M3 the row stays 🧭 honestly.
- **R80.12** — Backlinks become guest-correct (fixes D6): the page route passes
  `pageScopeFor(userId, workspaceId, role)` as `visiblePageIds` into
  `getBacklinks` (`page.tsx:56` → `queries.ts:369-374`, parameter already
  exists). Acceptance: e2e — guest sees the panel with a visible mentioner and
  does **not** see the title/icon of a hidden mentioner (red-first on the
  existing guest-scoping suite, `e2e/noema.spec.ts:1098+`).
- **R80.13** — Backlink honesty (D7): the 1000-page cap is surfaced (result
  count + "showing most recent 1000" when truncated) and the O(workspace) scan
  is documented in the matrix note; the durable fix (mention index table or
  FTS-backed query) is specced as M2 with its own benchmark gate (render-path
  scan must leave the hot render once the table exists) — O80.4.

### Guest & invite lifecycle

- **R80.14** — Both accept paths become **atomic and single-use** (fixes D3):
  wrap the writes in one `prisma.$transaction`, and gate entry with
  `updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt, … } })`
  returning `count === 1` — a second concurrent accept loses the race and gets
  "already been used" instead of double-writing. Red-first: a unit table over
  invite states (valid / used / expired / revoked / email-mismatch) plus a
  two-call concurrency test (mocked `updateMany` returning 0 on the second
  call). Closes `engineering-hardening.md:78` for both models.
- **R80.15** — Workspace-invite acceptance is attributable without a schema
  change: `acceptWorkspaceInviteAction` writes an `Activity` row
  (`member.joined`, actor = acceptor) — `Invite` has no `acceptedById`
  (`schema.prisma:166-192`) and this spec does not add columns (TeamspaceInvite
  already records `acceptedById`, `:537`). Rendered by the existing Settings →
  Activity trail.
- **R80.16** — Revocation symmetry: a revoked token of either kind fails accept
  with the same generic "That invitation link is not valid." as an unknown
  token (no oracle distinguishing revoked vs never-existed), and both pending
  lists (workspace: `settings/page.tsx:118,314`; teamspace:
  `teamspace-manager.tsx:255-271`) drop the row immediately after revoke.
  Red-first: accept-after-revoke unit for both models.
- **R80.17** — Expiry hygiene: pending lists filter `expiresAt > now` (both
  lists currently filter only `acceptedAt: null` / show every pending row), and
  re-inviting an expired address keeps today's revive semantics
  (`teamspace-invites.ts:107-114` resets `acceptedAt`, refreshes TTL) — that
  behavior is asserted by a test so it can't silently regress.
- **R80.18** — Guest role can only be *created* at workspace scope: unit test
  that `inviteTeamspaceMemberAction({ role: "GUEST" })` can never persist a
  GUEST teamspace invite (input type + coercion `:53,:62`), and
  `POST /api/invites` with `target: "teamspace", role: "GUEST"` coerces to
  MEMBER (route `:55-70`). Guests enter teamspaces only via R80.3's explicit
  add — semantics documented in GLOSSARY alongside R80.1.
- **R80.19** — Email-match accept stays (both paths require the signed-in
  address to equal the invited address — `teamspace-invites.ts:171-173`,
  `email.ts:344+`), and the invited-address echo in the error is an accepted,
  documented behavior (the token is the secret; its holder already learns
  nothing beyond the address it was sent to). Requirement: the copy is
  identical across both invite types (single i18n key), so the two flows cannot
  drift.
- **R80.20** — Membership teardown also cleans teamspace rows (fixes D8):
  `removeMemberAction` (`workspaces.ts:178`) and `leaveWorkspaceAction`
  (`:215`) delete that user's `TeamspaceMember` rows for the workspace in the
  same transaction as the `PagePermission` cleanup they already do
  (`:209,:235`). Red-first: action tests asserting `teamspaceMember.deleteMany`
  was called with the workspace filter.

### Multi-workspace & settings (row reconciliation, minimal work)

- **R80.21** — Workspace switching keeps its current contract: switcher links
  are plain `/w/<slug>` navigations (`workspace-switcher.tsx:25-70`) with
  `aria-current` on the active entry; "New workspace" lands the user in the
  created workspace (dialog flow); `/app`'s redirect-to-first behavior
  (`app/page.tsx:10-17`) is documented as intended (it is a fallback, not the
  switcher). No new behavior in M1-M2; glyph reconciliation for `:412/:413` is
  the maintainers' (`docs:counts`/`docs:gaps`).
- **R80.22** — Workspace settings row (`:433`) is scoped honestly: everything
  except billing exists (§2.1); billing belongs to `docs/specs/plans-licensing.md`
  and is cross-referenced from the matrix note, not re-specced here.

### Non-goals (this spec)

- **Template from selection** — matrix `:345` stays ⛔: cross-linked decision
  with `docs/specs/templates.md:308-310` (needs editor-slot block-selection
  capture; nothing in this spec revives it).
- Trash rows (`:422,:423,:424,:434`) and favorites rows (`:419,:430`) — **B42/B44
  own them, code and rows**; this spec reads and cites only.
- Cross-workspace page move (`:402`), permission inheritance (`:404`), custom
  roles (`plans-licensing.md`), SSO↔teamspace mapping (`saml-sso.md:208`),
  quick-find redesign (`:425` behavior change — B78's search area), Notion-style
  member denial (O80.1).

## 5. Data model

- **M1-M2: no schema change.** All correctness requirements (R80.2-R80.7,
  R80.12-R80.20) work off existing models (`Teamspace`, `TeamspaceMember`,
  `TeamspaceInvite`, `Invite`, `Page.teamspaceId`, `Activity`).
- **M3 (R80.11):**

```prisma
model Page {
  // …existing fields…
  lastVisitedAt DateTime?  // per-user? no — see O80.3; start workspace-scoped
}
```

  Honest caveat: a single `lastVisitedAt` is per-page, not per-user — correct
  parity needs per-(user, page) recency. O80.3 weighs a tiny `PageVisit`
  (composite key) against the column; the column ships first only if the
  per-user requirement is waived (default: **waived for M3.1, revisit in M3.2**).
- `TeamspaceInvite` / `Invite` shapes unchanged; R80.14-R80.17 change *writers*,
  not columns.

## 6. Contracts & surfaces

- **Invite accept (both kinds)**: the `GET /invite/<token>` page only *reads* the
  invitation — it renders what is being joined (name, role, optional project) plus
  a form — and the acceptance is the POST that form makes (a Server Action), which
  either redirects `/w/<slug>?joined=…` or re-renders the rejection card. **The GET
  must never mutate**: mail scanners, chat-app link previews and browser prefetches
  fetch invitation links too, and the token is single-use. Both halves share one
  read (`resolveWorkspaceInvite` / `resolveTeamspaceInvite`), so the preview refuses
  exactly what the accept refuses. The page handles the signed-out case by bouncing
  through `login?next=…` (`invite/[token]/page.tsx:41-44`, teamspace twin `:34-37`).
  Contract added by this spec: rejection copy is i18n-keyed identically across kinds
  (R80.19).
- **Invite API**: `POST /api/invites` stays the single programmatic entry
  (`{target: "workspace" | "teamspace", …}`, rate-limited 20/min) — bulk-move
  does **not** get a REST surface (server action only, like `movePageAction`).
- **Authorization**: every new check composes the existing helpers —
  `getWorkspaceAccess` + `canManageMembers`/`canEditContent`/`canPerformWorkspaceAction`
  (`permissions.ts`). No new permission vocabulary (R80.5/O80.2 excluded by
  design).
- **Sidebar tree**: selection state is local to `sidebar/page-tree.tsx`; the
  server sees only `bulkMovePagesAction` — no persisted selection.

## 7. UI spec

- **Move-to (single)**: unchanged (`page-tree.tsx:373` dialog, descendants
  filtered `page-menu.ts:168-180`).
- **Bulk move**: multi-select adds a compact toolbar above the tree —
  "N selected · Move to · Cancel"; the target dialog reuses the single-move
  picker; success toast "Moved N pages"; partial failure lists skips
  (`{id, reason}`) in the toast body. Keyboard: Space toggles selection in
  tree focus order, Escape clears (a11y: `check:a11y` must stay green).
- **Teamspace delete confirm**: shows "N pages will move to Private pages"
  (R80.4) instead of a bare confirm.
- **Pending invites**: both lists gain an expiry hint ("expires in 3 days" /
  hidden when expired, R80.17); revoke behavior unchanged.
- **i18n**: every new string goes through `t()` with all 5 locales; no ratchet
  raise beyond a *measured* count (never shortcut a check).

## 8. Conflict & edge spec

| Edge | Behavior |
| --- | --- |
| Move into a foreign-workspace parent (crafted request) | Typed error, no write (R80.7); the UI never offers the target (same-workspace tree only). |
| Move into a trashed parent | Rejected (trashed parents are hidden from `moveCandidates` today; server catches the crafted case). |
| Bulk move with 51 ids | Rejected up front with a count; no partial application. |
| Bulk selection contains parent + its descendant | Subsumed — descendant is skipped (reported), not moved twice. |
| Bulk move where one id fails authz | Transaction aborts, nothing moves, per-id reasons returned (stop-on-red semantics for data). |
| Duplicate a subtree with an outside-relation | Copy keeps the pointer to the original; inside-subtree relations remap (R80.10 rule, documented in the action's JSDoc). |
| Delete teamspace mid-session | Pages fall to Private (SetNull) — sidebar re-renders groups; a client holding the old `teamspaceId` gets "Teamspace not found." on the next mutation. |
| Guest opens a page whose mentioners are hidden | Panel shows only scoped mentioners (R80.12); empty panel renders nothing rather than an empty-state that implies "no backlinks". |
| Two admins accept the same teamspace invite concurrently | Exactly one wins the `updateMany` gate; loser sees "already been used" (R80.14). |
| Re-invite after accept | Teamspace: upsert revives a fresh link (`:107-114`) — intended, tested (R80.17). Workspace: pending purge then create (`email.ts:273-287` region) — unchanged. |
| Member removed while sitting in 3 teamspace rows | All three rows die with the membership (R80.20); their guest visibility (if demoted to guest first) recomputes on next query. |
| Expired invite clicked | "That invitation has expired." (distinct from invalid — both models already do; kept, tested). |

## 9. Test plan

**Unit (vitest, red-first, in the `src/lib` sandbox)**

1. *Teamspace semantics guard* — `assertSameWorkspaceTeamspace` matrix +
   `pageScopeFor` role table (R80.1, R80.2).
2. *Selection model* — shift-range over a synthetic 1000-node tree,
   subsumption, all-editable predicate, 50-cap (R80.8) — extends the B66 file
   `src/lib/page-tree.test.ts` (keep its synthetic-tree fixture).
3. *Subtree duplicate planning* — pure plan: BFS order, position re-base,
   relation remap classification (inside/outside) (R80.10).
4. *Invite state machine* — valid/used/expired/revoked/email-mismatch ×
   {workspace, teamspace} accept; concurrency gate via mocked `updateMany`
   (R80.14, R80.16, R80.19).
5. *Role coercion* — GUEST never persists on a teamspace invite (R80.18).

**Integration (server actions, mocked-prisma pattern of
`src/server/actions/workspaces.test.ts`)**

6. `movePageAction` foreign/trashed parent → error, `page.update` not called
   (R80.7); `bulkMovePagesAction` transaction abort (R80.8).
7. `addTeamspaceMemberAction` non-member target → error (R80.3);
   `setPageTeamspaceAction` foreign teamspace → error (R80.2).
8. `removeMemberAction` / `leaveWorkspaceAction` call
   `teamspaceMember.deleteMany` scoped to the workspace (R80.20).
9. Accept-after-revoke for both models (R80.16).

**e2e (Playwright — dedicated pages + try/finally cleanup, structural tests
avoid shared accumulation)**

10. Teamspace lifecycle extension in the existing settings block
    (`e2e/noema.spec.ts:363-377`): create → invite (link captured) → accept in
    a second context → page visible to the invitee; revoke path leaves no row.
11. Bulk move: seed 3 dedicated pages, select, move under a target, assert
    tree order + toast (R80.8).
12. Guest backlink scoping: hidden mentioner's title absent from the guest's
    page (R80.12) — runs beside the known-flaky `guest scoping › pages through
    a large result set` (rerun-once rule).
13. Delete teamspace → pages under "Private pages" (R80.4).

**Gates for implementation**: M1 = STANDARD (tsc/eslint/unit/
coherence + targeted e2e on dev :3201); bulk move UI = STANDARD with its own
`e2e/<topic>.spec.ts`; M3 recency = Tier HEAVY (schema push). This docs-only change
owes FAST only: tsc + eslint + unit + `check:coherence` **COHERENT**.

## 10. Migration path (legacy → target behavior)

1. **M1 — correctness, no UX change** (R80.1, R80.2, R80.3, R80.6, R80.7,
   R80.12, R80.14-R80.20). Closes D2, D3, D5, D6, D8; D1/D4/D7 untouched.
2. **M2 — tree features** (R80.4 UI, R80.8-R80.10, R80.13): bulk move,
   duplicate-with-children, backlink surfacing + index design. Requires
   sidebar-slot coordination (R80.8 ownership note).
3. **M3 — recency & role promotion** (R80.11, R80.5 promotion O80.2): schema
   change → Tier HEAVY, then glyph moves are maintainer-owned.

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Red-first rule applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Integrity & lifecycle hardening (~1-2 days)**

- T80.1 [R80.2, R80.7]: containment guards in `setPageTeamspaceAction` +
  `movePageAction`. Red: unit 1, integration 6.
- T80.2 [R80.3, R80.20]: target-membership guard + teardown cleanup. Red:
  integration 7, 8.
- T80.3 [R80.14, R80.16, R80.19]: atomic accepts + revocation symmetry + copy
  unification. Red: unit 4, integration 9.
- T80.4 [R80.1, R80.5, R80.6, R80.18]: semantics doc fix (GLOSSARY), inert-role
  note, copy/grant alignment, role-coercion test. Red: unit 1, 5.
- T80.5 [R80.12]: backlink scoping at the page route. Red: e2e 12.

**M2 — Tree features (~2-3 days, sidebar-slot queued)**

- T80.6 [R80.8, R80.9]: selection lib + `bulkMovePagesAction` + toolbar UI.
  Red: unit 2, integration 6, e2e 11.
- T80.7 [R80.10]: subtree duplicate + relation remap rule. Red: unit 3, then
  the existing duplicate e2e extended.
- T80.8 [R80.4]: delete-confirm page count + e2e 13.
- T80.9 [R80.13]: backlink truncation surfacing; index design note (benchmark
  gate).

**M3 — Recency & roles (~2 days, schema)**

- T80.10 [R80.11]: recency column/visit table (Tier HEAVY), sidebar Recent
  section, guest-scoped.
- T80.11 [O80.2]: teamspace-scoped roles (separate slice, may slip).

## 12. Risks & open questions (honest)

**Risks**

1. **Sidebar slot collision (highest coordination risk).** `sidebar/page-tree.tsx`
   is exactly the file editor/navigation work wants; two changes editing it
   produce false greens (tier rule: one writer per file).
   Mitigation: T80.6 queues; this spec only touches docs today.
2. **Accept-path rewrite touches two live invite flows + an e2e that captures
   links** (`noema.spec.ts:363+`). Mitigation: red tests first (unit 4),
   e2e rerun-once rule.
3. **Backlink scoping changes rendered output for guests** — could trip the
   known-unstable `guest scoping` test; mitigation: rerun-once, then root-fix
   queue (never rerun-triage).
4. **Matrix line drift.** Concurrent suites (B78/B79) append to the same file;
   §13 records lines *as of this change*, and every edit re-matches exact cell
   text instead of line numbers.

**Open questions**

- **O80.1** — Do we ever adopt Notion-style teamspace denial for members
  (Decision B)? Needs a perf benchmark of `pageScopeFor` for all roles before
  the product call.
- **O80.2** — Promote `TeamspaceMember.role` to real teamspace-scoped
  authorization (teamspace admin can invite without workspace admin)? Affects
  R80.6's single-grant rule; deferred, needs a plans/licensing tie-in.
- **O80.3** — Recent pages: `Page.lastVisitedAt` (per-page, wrong per-user) vs
  `PageVisit(userId, pageId, at)` (correct, bigger)? R80.11 ships column-first
  only if per-user recency is waived.
- **O80.4** — Backlink index: mentions table (write-time maintenance, mirror of
  `searchText` pattern) vs reusing FTS? Decide in M2 with the render benchmark.
- **O80.5** — Should the workspace switcher list *pending* workspace invites
  (join a workspace you're invited to from `/app`)? Not modeled today;
  parity-relevant but unclaimed by any matrix row — maintainer call.

## 13. Traceability — FEATURE_MATRIX rows

**Rows appended by this change (Notes-only, glyphs untouched, exactly thirteen):**

| Row | Matrix line | Edit |
| --- | --- | --- |
| Multiple workspaces | `:412` | Note appends audit (data path exists: `app/page.tsx:10-17`) + spec ref |
| Workspace switcher | `:413` | Note appends audit (ships: `sidebar.tsx:119-125`) + spec ref |
| Teamspaces | `:417` | Note appends spec ref (semantics + invite lifecycle) |
| Page tree | `:418` | Note appends spec ref (bulk move, move guards) |
| Recent pages | `:420` | Note appends "no visit source modeled" + spec ref |
| Quick find | `:425` | Note appends audit (implemented, guest-scoped `search.ts:20-36`) + spec ref |
| Backlinks | `:426` | Note appends audit (`queries.ts:369-389`) + scoping gap + spec ref |
| Linked references | `:427` | Note appends audit (panel ships) + spec ref |
| Page history | `:428` | Note appends cross-ref to `version-history-v2.md` (owner of §10 rows) |
| Duplicate page | `:431` | Note appends audit (single-page copy today) + spec ref |
| Move page | `:432` | Note appends audit (shipped, duplicates `:363`) + spec ref |
| Workspace settings | `:433` | Note appends audit (shell exists; billing → plans-licensing) + spec ref |
| Template from selection (§6) | `:345` | Note appends blocked-row cross-links (`templates.md:308` + this spec §4) |

**Rows deliberately NOT touched (ownership):**

- **B42 — trash**: `:422` restore, `:423` permanent delete, `:424`, `:434`
  retention policy, plus the §7 trash row `:364`. Their code
  (`pages.ts` archive/restore/delete/emptyTrash) was **read only**.
- **B44 — favorites**: `:419`, `:430` reorder, plus `toggleFavoriteAction`
  (`pages.ts:443`) — **read only**.
- **B78 — search**: `:421` search entry point, quick-find *behavior* rows in
  §11 (this change only records the §9 glyph staleness of `:425`).
- **B79 — collaboration §7**: `:376` Guests row (audited here for the invite
  lifecycle, no cell edit — section boundary).
- **§8 sharing rows** (`:395` Teamspace/wiki, `:402`, `:404`): audited as
  context, no cell edit — section boundary.
- **Maintainer-only**: counts/gaps regeneration.

**Requirement → milestone → row:** R80.1-R80.6 → M1 → `:417`; R80.7-R80.10 →
M1-M2 → `:418`, `:431`, `:432`; R80.11 → M3 → `:420`; R80.12-R80.13 → M1-M2 →
`:426`, `:427`; R80.14-R80.20 → M1 → `:417` (+ guest lifecycle, §7 `:376`
audit-only); R80.21-R80.22 → audit-only → `:412`, `:413`, `:433`;
`:428` → `version-history-v2.md`; `:345` → blocked, `templates.md:308`.
