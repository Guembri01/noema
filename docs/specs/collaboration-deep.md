# Spec — Collaboration deep: thread depth, anchors, mentions, follow, activity

> **Status: spec complete, implementation pending.** Covers the FEATURE_MATRIX §7
> remainder. This document is the deliverable; no production code was changed
> and **no e2e was run** — `e2e/comments.spec.ts` and `e2e/inbox.spec.ts` cover
> those flows elsewhere, so every component this spec touches is **read-only**. Every claim about the current code cites file + line.
> Requirement IDs (`R79.x`) are the traceability anchors: §7 lists tasks 1:1
> against them, and tests must cite the IDs they cover. Sibling specs own parts
> of this surface and are **cited, not restated** (§9): notification delivery →
> `docs/specs/notifications.md` R82.1-R82.13, block-id minting →
> `docs/specs/engineering-hardening.md` DEC28.1 / R28.1-R28.5, presence →
> `docs/specs/realtime-collab.md`.

---

## 1. Problem statement

Matrix §7 marks comment threads, resolve, reactions, mentions, the activity
trail and notification read-state as ✅ — and that is largely true at the
*happy path*. The deep audit found the surface works for the flow the e2e suite
exercises (top-level comment → reply → resolve → inbox mark-read) and degrades
outside it:

- **Thread depth is enforced by the UI and the read query, never by the
  server.** A reply whose `parentId` is itself a reply, or points at a comment
  on a different page, is written successfully and is then invisible forever —
  silent loss of user content.
- **`Comment.blockId` has never held a value.** Both comment entry points
  dispatch only `{ quote }`, the panel never forwards `blockId`, and the editor
  has no stable block id to forward. "Inline comments ✅" is really
  "quote-only comments ✅"; anchors cannot be rendered, scrolled to, or deep-
  linked.
- **Dispatch is comment-only, membership-wide.** Comment-body `@mentions`
  notify (good), but editor `@user` mention nodes in the page body notify
  nobody, editing a comment to add a mention notifies nobody, targets are every
  workspace member regardless of whether they may open the page, and the
  `page.shared` inbox label has no writer. *(Delivery semantics for all of
  these are normative in `notifications.md` R82.3, R82.10-R82.13 — this spec
  audits them, cites those IDs and owns the comment-side sources, per that
  spec's §14.)*
- **Following a page does nothing.** `PageFollow` rows are written and read for
  the bell's own state, and no mutation in the codebase ever consults them —
  the notification seam the feature implies does not exist (`notifications.md`
  R82.12 is where the delivery rule is specified; §2.4 is the evidence).
- **The audit trail stops at creation.** `comment.resolved` is declared in the
  `ActivityAction` union but has zero writers and no Settings label; edit,
  delete, resolve, follow and mention events are not recorded; `row.edited`
  bypasses the union with a raw `prisma.activity.create`.

Goal: close those five gaps with numbered, testable requirements that the next
implementation work can pick up independently, without disturbing the flows
`e2e/comments.spec.ts` and `e2e/inbox.spec.ts` already cover.

## 2. Current state audit (evidence)

### 2.1 Threads & resolve

| Area | Evidence | State |
| --- | --- | --- |
| Data model | `prisma/schema.prisma:330-349` | `Comment` with optional `parentId` → self-relation `"CommentReplies"` (`:343-344`), `blockId` (`:336`), `quote` (`:337`), `resolved` (`:338`). Depth is **not** constrained by the schema. |
| Create | `src/server/actions/comments.ts:14-110` | Validates shape via `commentSchema` (`validation.ts:131-137`), permission via `getWorkspaceAccess` + `canEditContent` (`comments.ts:38-41` → guests cannot comment), then **creates the row first** (`:43-53`). The parent is fetched only afterwards and only for the reply notification, selecting `authorId` alone (`:55-59`): **no existence check, no same-page check, no depth check**. |
| Reply notify | `comments.ts:55-69` | Creates `comment.reply` for the parent author when it is not the actor. Parent-author-only (not the whole thread). |
| Read path | `src/server/queries.ts:120-134` | `comments: { where: { parentId: null }, … replies: { … } }` — exactly one level, `createdAt asc`, **no `resolved` filter** (`:121-122`). Anything at depth ≥ 2 (or with a foreign-page parent) is never returned to any client. |
| Panel | `src/components/comment-panel.tsx:20-34, 129-295` | Top-level row: reactions (`:197-201`), Reply (`:202-210`), Resolve/Reopen gated by `canComment` (`:211-220`), Edit/Delete gated on author (`:221-242`), resolved badge (`:141-145`). Reply rows render **author + time + body only** (`:245-270`) — no reactions, no edit, no delete, no reply composer (the composer mounts only for a top-level `comment.id`, `:272-291`). |
| Reply mapping | `src/app/w/[slug]/[pageId]/page.tsx:101-107` | Replies' `reactions` **are** fetched and `groupReactions`-ed, but `CommentNode.replies` (`comment-panel.tsx:28-33`) has no `reactions` field, so the computed chips are dropped before render. Replies can hold `CommentReaction` rows (`comments.ts:113-144` accepts any `commentId`) that no UI ever shows. |
| Resolve | `comments.ts:173-192` | Flips `resolved` on the **single row**; permission same as comment; `revalidatePath("/w", "layout")`. **No `logActivity`** even though `"comment.resolved"` is a declared action (`src/lib/activity.ts:31-32`). |
| Edit / delete | `comments.ts:147-171, 194-211` | Edit: author or OWNER/ADMIN (`:163-166`); delete: author or any member who can edit (`:205-207`). **Neither logs activity, neither re-runs mention dispatch, neither touches notifications.** Deleting a top-level comment cascades replies (`schema.prisma:343`). |
| Tests | `src/lib/comments.test.ts` (pure helpers), `e2e/comments.spec.ts:131,177,227,264` (B40: create+reply, edit-in-place, resolve/reopen, delete thread+reply) | Depth-≥2 and cross-page `parentId` are **untested** (both silently succeed today). |

### 2.2 Comment anchors (block anchoring)

| Area | Evidence | State |
| --- | --- | --- |
| Column + schema | `schema.prisma:336`, `validation.ts:135` | `Comment.blockId String?` and `commentSchema.blockId` exist and are persisted (`comments.ts:26,47`). |
| Dispatch A | `src/components/editor/bubble-toolbar.tsx:270-281` | Selection → `textBetween(from, to)` → `COMMENT_EVENT` with **`{ quote }` only** (`:273-277`). |
| Dispatch B | `src/components/editor/block-context-menu.tsx:345-349` | Block → `node.textContent` → `COMMENT_EVENT` with **`{ quote }` only** (`:347-348`). |
| Listener | `comment-panel.tsx:65-77, 79-106` | Reads `detail.quote` (`:68`), and `submit` sends `pageId/body/parentId/quote` (`:83-88`) — **`blockId` is never in the payload**, so the column stays `NULL` for every row written by the UI. |
| Block identity | grep `data-block-id\|attrs.id` in `src/components/editor` | **No stable block id exists** on paragraph/heading/list nodes; `addAttributes` is per-feature only (`bookmark.tsx:30,165`, `image-block.tsx:25`, `custom-blocks.tsx:61,142`, …). Nothing in `src/` renders or consumes an anchor, and `CommentNode` (`comment-panel.tsx:20-34`) does not carry `blockId` at all. |
| Inbox deep link | `src/app/w/[slug]/inbox/page.tsx:55-58` | `href` derives from `payload.pageId` only; the `commentId` that the create-actions already put in the payload (`comments.ts:65,89`) is ignored → "Open" lands on the page top, not the thread. |
| Scope boundary | `docs/specs/realtime-collab.md:222-224` | CRDT spec explicitly lists "comment anchoring changes" as a **non-goal** → this spec owns anchoring. |

### 2.3 Mentions → inbox

| Area | Evidence | State |
| --- | --- | --- |
| Pure helpers | `src/lib/comments.ts:29-53` | `extractMentions` (regex, de-duped, lowercased) + `mentionMatches` (email, email-local, compact full name, first name) — tested in `comments.test.ts`. |
| Dispatch | `comments.ts:71-93` | Comment-body mentions → `prisma.notification.createMany` type **`page.mention`**, payload `{ pageId, commentId }`; actor excluded (`:81`), one row per matched member. Runs **only in `addCommentAction`** — `editCommentAction` never dispatches (`:147-171`). |
| Target selection | `comments.ts:75-78` | `workspaceMember.findMany({ workspaceId })` — **no page-visibility filter** (`pageScopeFor` / `guestVisiblePageIds` / `PagePermission` are not consulted), so a member (including a `GUEST`) who cannot open the page still receives a notification whose payload leaks `pageId`. |
| Editor mentions | `src/lib/mentions.ts:52-54` (`userMention`), `src/components/editor/extensions/mention.ts:15`, `src/server/actions/mentions.ts:17-75` | Inline `@user` nodes are first-class in the document and in the suggestion menu (guest-scoped, `mentions.ts:28-46`), but **no server action turns a user mention node into a `Notification`** — a `@Ada` in the page body notifies nobody. |
| Inbox | `src/app/w/[slug]/inbox/page.tsx:17-99` | Renders `getNotifications(user.id)` (`queries.ts:426-432`, newest-first, `take 50`), unread dot (`:64-70`), `LABELS` map (`:11-15`), per-item Mark read + Mark all (`:79-88, 39-45` → `notifications.ts:7-23`), badge fed by `getUnreadNotificationCount` (`queries.ts:434-436`) through `layout.tsx:43,85` → `home-links.tsx:94-96`. |
| Dead label | `inbox/page.tsx:14` vs `src/server/actions/share.ts:108,141` | `page.shared` has a label but **no writer**: sharing logs activity only. |
| i18n | `inbox/page.tsx:11-15` vs `:37,42,85` | Page chrome uses `t()`; the three notification **labels are hardcoded English** → non-`en` users see English for every notification. |
| Tests | `e2e/inbox.spec.ts:99,181,251` (B41: mention notifies, mark-read, follow persists) | Coverage exists for the happy path only; scoping/edit-time/content-mention dispatch are untested. |

### 2.4 Follow

| Area | Evidence | State |
| --- | --- | --- |
| Data | `schema.prisma:468-479` | `PageFollow` unique `(userId, pageId)` + `@@index([pageId])`. |
| Toggle | `src/server/actions/pages.ts:463-481` | Creates/deletes the row after `getWorkspaceAccess` (`:468-469`). No activity, no notification, no webhook. |
| UI | `src/components/page-title.tsx:90, 338-356` | Bell with `following` state, `aria-label` "Follow/Unfollow page", toast "Following page/Unfollowed". |
| Read | `src/app/w/[slug]/[pageId]/page.tsx:58-61` | `pageFollow.findUnique` → `initialFollowing`. **This and the toggle are the only three `pageFollow` references in `src/`** (grep: `pages.ts:470,474,478`, `page.tsx:58`). |
| Dispatch | — | `updatePageAction` (`pages.ts:200-280`), `share.ts`, `comments.ts`, archive/restore/delete (`pages.ts:549-630`) **never query followers**. Following is a dead letter box: the row proves intent, nothing consumes it. |
| Tests | `e2e/inbox.spec.ts:251` | Only asserts the toggle persists across reload. |

### 2.5 Activity trail

| Area | Evidence | State |
| --- | --- | --- |
| Union | `src/lib/activity.ts:11-32` | 22 declared actions incl. `comment.created` (`:31`) and `comment.resolved` (`:32`). |
| Writer discipline | `activity.ts:34-56` | `logActivity` swallows failures (`:53-55`) — correct: an audit line must never break its mutation. |
| Comment coverage | `comments.ts:95-102` vs `:173-192, :147-171, :194-211` | **`comment.created` only.** `comment.resolved` has **zero writers** (grep across `src/`); edit and delete log nothing. |
| Union drift | `src/server/actions/database.ts:206-215` | `row.edited` written with a raw `prisma.activity.create` because the action is **not in the union** (`activity.ts:11-32`) — the type-level single-source-of-truth is already breached once. |
| Labels | `src/app/w/[slug]/settings/page.tsx:41-54` | `ACTIVITY_KEYS` covers 12 actions incl. `comment.created` (`:53`) but **not** `comment.resolved`, `page.created`, `ticket.*`, `label.*`, `cycle.*`, `row.edited` → those rows render the raw action string (fallback), i.e. the Settings → Activity view would show `comment.resolved` as an unformatted token even if it were written. |
| Non-events | — | Follow toggle, notification read, reaction toggle produce no activity — defensible (noise), but currently *implicit*, not decided. **R79.6d** records the decision. |

### 2.6 What the product class (Notion) does

1. **One-level threads with full parity** — replies are first-class: react,
   edit, delete, and quoting another reply is expressed as text, not depth.
2. **Anchored comments** — a comment carries its block anchor; clicking the
   thread scrolls and flashes the block; anchors survive block moves and
   degrade to a quote when the block is gone; notifications deep-link to the
   thread.
3. **Mentions notify everyone who can see the thing**, in the inbox, coalesced,
   including mentions that arrive by editing a comment or in page content.
4. **Follow = subscription** — followers get a coalesced "page updated" inbox
   item per change burst, never for their own edits.
5. **Resolved threads leave the default view** and the audit trail records
   resolve/edit/delete, not just creation.

## 3. Decision summary

| Gap | Decision |
| --- | --- |
| Thread depth | Keep **depth 1** (matches UI, query and product class); enforce it **server-side** in `addCommentAction` (validation error, no row). No schema change. |
| Reply affordances | Give replies the affordances the schema already allows (reactions, edit, delete) instead of promoting to depth N. |
| Resolve semantics | Thread-scoped: resolving the top-level comment resolves its replies for display; `Comment.resolved` on the parent remains the stored truth. |
| Block anchors | Consume a **stable `id` attribute on top-level block nodes** — minting/backfill is owned by `engineering-hardening.md` DEC28.1 + R28.1-R28.5 (`ensureBlockIds`, `scripts/backfill-block-ids.mjs`); this spec owns forwarding it as `blockId` through `COMMENT_EVENT`, rendering/scrolling/flash, and notification deep-link arrival. No `Page.content` migration (`pageContentSchema` tolerates arbitrary node attrs, `validation.ts:35-38`). |
| Mention dispatch | **Delivery semantics live in `notifications.md`** (R82.3 visibility, R82.7 dedupe, R82.10 comment mention, R82.11 editor chip, R82.13 share): this spec owns the comment-side source wiring and the two items that spec does not claim — edit-time dispatch (R79.4c) and anchor-aware arrival UX (R79.3e). |
| Follow dispatch | Specified as `notifications.md` R82.12 (24 h dedupe, actor exclusion via R82.4) on the `notify()` seam R82.1; this spec supplies the audit evidence (§2.4) and the requirement that the bell's UX truth matches delivery (R79.5). |
| Activity | Write resolve/edit/delete through `logActivity`; fold `row.edited` into the union or an explicit allow-list; every union member gets an `ACTIVITY_KEYS` entry (or a tested raw-fallback). |

## 4. Requirements (numbered, testable)

### Thread depth & replies

- **R79.1** — `addCommentAction` **rejects** a `parentId` that (a) does not
  exist, (b) belongs to a different `pageId`, or (c) itself has a non-null
  `parentId` (depth > 1), returning `{ error }` with distinct messages and
  **writing no row**. Today `comments.ts:43-53` writes before it looks at the
  parent at all (`:55-59`). Rationale: such rows are unreachable —
  `queries.ts:121` only ever selects `parentId: null` — so each one is silently
  lost user content. The check must live behind a pure, unit-tested helper
  (e.g. `validateReplyTarget({ parentId, parent, pageId })`) so the matrix of
  {missing, foreign-page, depth-2, ok} is pinned without a DB.
- **R79.2** — Within depth 1, replies reach **affordance parity** with
  top-level comments:
  (a) reaction chips render on replies — the data is already fetched and
  grouped (`page.tsx:106`) but `CommentNode.replies` (`comment-panel.tsx:28-33`)
  has no field for them, so the chips are computed and dropped;
  (b) edit and delete actions are available on replies under the same
  permission rules as the server already enforces (`comments.ts:163-166,
  205-207`);
  (c) resolve is **thread-scoped**: the Resolve control on a top-level comment
  marks the thread, and replies of a resolved thread render with the inherited
  state (rows keep `resolved = false` on children);
  (d) resolved threads are hidden from the default list behind a
  "Show resolved (N)" toggle (today `queries.ts:121` returns them unfiltered
  and the badge at `comment-panel.tsx:141-145` is the only signal).

### Comment block anchors

- **R79.3** — Comments anchor to blocks, end to end:
  (a) **Stable block ids exist** — minting, backfill and enforcement are owned
  by `engineering-hardening.md` DEC28.1 / R28.1-R28.5 (`id` attr on every block
  node, idempotent `ensureBlockIds` on load, `scripts/backfill-block-ids.mjs`);
  this spec **consumes** them. `pageContentSchema` (`validation.ts:35-38`)
  already accepts arbitrary attrs, so stored JSON needs no migration;
  (b) **Dispatch** — both entry points send the id with the quote
  (`bubble-toolbar.tsx:273-277`, `block-context-menu.tsx:345-349` currently send
  `{ quote }` only), the `COMMENT_EVENT` listener stores it
  (`comment-panel.tsx:65-77`) and `submit` forwards it (`:83-88`) →
  `Comment.blockId` (`schema.prisma:336`) stops being dead;
  (c) **Render + navigate** — the thread shows a clickable anchor chip; clicking
  it scrolls the editor to that block and flashes it (reverse of the existing
  `COMMENT_EVENT` channel); the anchor is id-based, so **moving the block keeps
  the anchor**;
  (d) **Degradation** — block deleted → the chip renders "Anchor removed" and
  the `quote` (`schema.prisma:337`) remains the surviving context; a thread
  never becomes unrenderable;
  (e) **Deep links** — notification payloads already carry `commentId`
  (`comments.ts:65,89`) but the inbox ignores it (`inbox/page.tsx:55-58`); "Open"
  must land on `/<page>#comment-<id>` → scroll + flash the thread;
  (f) **CRDT-safe** — ids are node attributes, so Yjs merges preserve them;
  collab builds on `realtime-collab.md` (whose §4 non-goals explicitly exclude
  comment anchoring) must not strip them.
  Tests citing R79.3 go into `e2e/comments.spec.ts` / `e2e/inbox.spec.ts`
  **owned by B40/B41** — this change is read-only on those files.

### Mention → inbox dispatch

- **R79.4** — Mention → inbox dispatch: **the semantics are specified in
  `notifications.md` and cited here** (per its §14: "collaboration-deep should
  cite these IDs rather than restating semantics"):
  (a) **visibility scoping** of mention targets → **R82.3** (evidence for why
  it is needed: `comments.ts:75-78` targets every `workspaceMember`, so a guest
  or a member without `PagePermission` receives a payload leaking `pageId`);
  (b) **content mentions** (inline `@user` node in the doc, `lib/mentions.ts:52-54`)
  → **R82.11** (today: zero dispatches outside `comments.ts`);
  (c) **edit-time dispatch — owned by this spec**: `editCommentAction`
  (`comments.ts:147-171`) re-parses nothing, so adding `@Ada` by editing a
  comment notifies nobody. R82.10 covers comment mentions as a source but does
  not state whether an edit re-dispatches; T79.4 either amends R82.10 or lands
  this itself — the requirement stands: *a mention that exists in the final
  body notifies its target exactly once, whenever the body was written*;
  (d) **coalescing/idempotency** → **R82.7** (`dedupeKey`), evidence
  `comments.ts:84-92` runs its own `createMany` per comment;
  (e) **self-mention never notifies** → **R82.4** (today true at
  `comments.ts:81`; keep and pin with a test);
  (f) **`page.shared` label gets a writer** → **R82.13** (today
  `inbox/page.tsx:14` is an orphan label: `share.ts:108,141` logs activity
  only) — a lying label is this audit's finding, that spec's fix;
  (g) **label i18n** → **R82.21-R82.26** (`inbox/page.tsx:11-15` hardcodes
  English while its chrome uses `t()`); new keys must still be added through
  the B07/B08 anchor-line discipline (coverage may rise, hardcoded strings in a
  translated page may not).
  **B79-owned residue**: (c) plus the invariant tests in §6 that pin the
  current helper behavior so R82.10 cannot regress it.

### Follow → notification dispatch

- **R79.5** — Following a page actually delivers updates. **The delivery rule
  is normative in `notifications.md` R82.12** (`page.updated` to followers,
  ≤ 1 row per page per follower per 24 h, unfollow stops it, `PageFollow`
  unchanged, not presence-follow) on the single `notify()` seam (**R82.1**)
  with actor exclusion (**R82.4**) and dedupe (**R82.7**). This spec owns:
  (a) **the audit finding that makes it necessary** — zero code paths read
  `PageFollow` for delivery (§2.4: only `pages.ts:470,474,478` and
  `page.tsx:58` exist in `src/`);
  (b) **call-site coverage**: title edit, content save, share, archive/restore
  and a comment added by someone else must all reach the seam — R82.12 names
  "title or content edit" only, so the remaining sources are this spec's
  requirement (they must not bypass `notify()`, R82.1/R82.14);
  (c) **bell UX truth**: the bell's `following` state (`page-title.tsx:338-356`)
  must mean "I get updates" — it only becomes honest once (b) lands; until
  then the matrix row stays 🧭 (§8 O79.5);
  (d) **visibility re-check at dispatch** (follower revoked, page trashed → no
  row) — same semantics as **R82.3**, restated here only because the follower
  set is read from `PageFollow` at dispatch time;
  (e) **non-fatal dispatch** — a failing insert never fails the mutation
  (**R82.8**, same swallowing discipline as `logActivity`, `activity.ts:53-55`).

### Activity trail

- **R79.6** — The audit trail covers the comment lifecycle:
  (a) `resolveCommentAction`, `editCommentAction` and `deleteCommentAction`
  each call `logActivity` with `targetType: "comment"`, `targetId` and
  `meta: { pageId }` — `comment.resolved` is already a union member with **zero
  writers** (`activity.ts:31-32`), edit/delete need new union members
  (`comment.edited`, `comment.deleted`);
  (b) `ACTIVITY_KEYS` (`settings/page.tsx:41-54`) contains an entry for **every**
  `ActivityAction` member, or the render path documents + tests a raw fallback —
  today `comment.resolved`, `page.created`, `ticket.*`, `label.*`, `cycle.*`
  would render as unformatted tokens;
  (c) `row.edited` stops being a raw `prisma.activity.create`
  (`database.ts:206-215`): either it joins the `ActivityAction` union (and
  `logActivity` becomes the only writer) or it moves to an explicitly documented
  allow-list — one of the two, in code comments and here;
  (d) **Documented non-events**: follow toggles, notification read-state and
  reaction toggles produce no activity rows (noise decision, recorded in §6 so
  the next auditor does not "fix" it);
  (e) `comment.created` keeps its webhook (`comments.ts:104-107`); resolve does
  **not** gain a webhook in this spec (open question O79.3).

## 5. Data model & contract deltas

- **No schema change.** Everything required already exists: `Comment.parentId /
  blockId / quote / resolved` (`schema.prisma:333-338`), `CommentReaction`
  (`:407-419`), `Notification { type, payload, read }` (`:362-373`),
  `PageFollow` (`:468-479`), `Activity` (`:438-453`).
- **Notification payload / deep-link shape** is normative in
  `notifications.md` **R82.2** (adds `workspaceId`, `actorId`, `blockId?`,
  `commentId?`, `actorName`, `title`; their D9 records today's thin
  `{ pageId, commentId }` at `comments.ts:65,89`). This spec owns only the
  **consumption** side: inbox `href` logic (`inbox/page.tsx:55-58`) must use
  `commentId` to land on `#comment-<id>` and scroll/flash the thread (R79.3e).
- **Document shape**: top-level block nodes gain `id` — minted/backfilled per
  `engineering-hardening.md` R28.1-R28.5; accepted by `pageContentSchema`
  as-is (`validation.ts:35-38`); markdown export/Notion import
  (`src/lib/markdown.ts`, `server/actions/notion-import.ts`) ignore unknown
  attrs — verify in the implementation task, not here.
- **Pure helpers** (the sandboxed, unit-testable core):
  B79 owns `validateReplyTarget` (R79.1), `anchorFor` (R79.3c-d) and the
  comment-side invariants of §6; the visibility resolver and dedupe key belong
  to `notify()`'s module (`notifications.md` R82.1, R82.3, R82.7) — B79 cites
  them, it does not reimplement them.

## 6. Test plan

**Unit (vitest, red-first — cite the R79.x id)**

1. `validateReplyTarget` matrix: missing parent / foreign page / depth-2 /
   depth-1-ok → error codes (R79.1).
2. **Comment mention source invariants**: `extractMentions`/`mentionMatches`
   regressions stay green (`lib/comments.test.ts`), self-mention exclusion
   (R79.4e), and the *final-body* rule for edits (R79.4c). Visibility scoping
   and dedupe are **R82.3/R82.7 territory** — their unit tests live in
   `notifications.md` §11; B79 only pins the source-side inputs.
3. `anchorFor`: resolve id → position; deleted id → `{ degraded: true }` with
   quote (R79.3c-d).
4. Activity coverage guard: every `ActivityAction` member has an `ACTIVITY_KEYS`
   entry or is on the documented non-event/raw-fallback list (R79.6b-d) — a
   pure test over the two exported shapes.
5. *Deferred, cited:* follower fan-out and dedupe keys — R79.5b's call sites
   on top of `notifications.md` R82.7/R82.12 (their unit 3 owns the key
   matrix); visibility-filtered recipients are R82.3's test.

**e2e (Playwright — B40/B41 own the files; this change is read-only)**

6. Existing coverage to stay green: `e2e/comments.spec.ts:131,177,227,264`
   (create+reply, edit-in-place, resolve/reopen, delete thread) and
   `e2e/inbox.spec.ts:99,181,251` (mention notifies, mark-read, follow
   persists).
7. New coverage lands **in those files, as a follow-up**:
   depth-2 reply rejected with a toast and no row (R79.1), reply reaction chip
   visible (R79.2a), comment on a selection → anchor chip → click scrolls to
   the block (R79.3b-c), inbox "Open" lands on `#comment-<id>` (R79.3e),
   mention of a member without page access creates **no** notification
   (R79.4a → R82.3), follower of an edited page gets exactly one `page.updated`
   and the editing follower gets none (R79.5b → R82.12/R82.4), resolve writes
   an activity row that Settings renders with a label (R79.6a-b).

**Scope note.** This spec covers flows already exercised by
targeted e2e; the change itself changed **zero components**, ran **no playwright**, and
its only gates are the FAST tier (tsc + eslint + targeted unit + coherence).

## 7. Delivery plan (tasks ↔ requirements)

> Red-first: each task's acceptance is a failing test citing its requirement
> IDs before implementation.

- **T79.1 [R79.1]** — pure `validateReplyTarget` + wire into
  `addCommentAction` before the create. Red: unit 1.
- **T79.2 [R79.2]** — reply affordances in `comment-panel.tsx` +
  `CommentNode` shape (reactions/edit/delete), thread-scoped resolve display,
  show-resolved toggle (server filter). Red: unit for the pure display-state
  helper + e2e 7.
- **T79.3 [R79.3]** — consume stable block ids (minted per
  `engineering-hardening.md` R28.1-R28.5) + dispatch `blockId` + anchor chip +
  scroll/flash + inbox `#comment-<id>` arrival. Red: unit 3 + e2e 7.
  **Heaviest task — touches `page-editor`-adjacent files, so it queues behind
  the editor slot.**
- **T79.4 [R79.4]** — comment-side sources only: edit-time mention dispatch
  (R79.4c) plus wiring `addCommentAction` onto the shared seam when
  `notifications.md` T82.3 lands (`comments.ts:61-68, :85-92` migrate to
  `notify()`); `page.shared` writer and label i18n are **T82.12/T82.6** — do
  not duplicate. Red: unit 2 + e2e 7.
- **T79.5 [R79.5]** — call-site coverage onto the same seam: share,
  archive/restore and comment-added sources that R82.12 does not already name
  (title/content edits are **T82.11**); bell UX truth lands with them. Red:
  cited unit 3 (`notifications.md` §11) + e2e 7.
- **T79.6 [R79.6]** — activity writes for resolve/edit/delete, `ACTIVITY_KEYS`
  completion, `row.edited` union decision. Red: unit 4.

Sizing: T79.1+T79.6 are small (one slot each), T79.2 medium,
T79.3 heavy (own slot, serialized with the editor-slot owner), T79.4+T79.5 are
medium and **sequence behind B82's `notify()` seam** (their M1) — execute as
micro-slices, not one change.

## 8. Risks & open questions (honest)

**Risks**

1. **Concurrent e2e (highest, immediate).** B40/B41 hold `e2e/comments.spec.ts`
   and `e2e/inbox.spec.ts` and a shared dev server + DB. Any implementation of
   this spec that touches those flows must coordinate through the build serialization and
   must not edit those files while that work is live (tier rule: one writer
   per file).
2. **Anchor drift.** If block ids are added but some path rewrites content
   without preserving attrs (markdown import, version restore
   `page-versions.ts:48-54`), anchors silently die. Mitigation: degradation
   path (R79.3d) plus a test that restore keeps ids.
3. **Notification fan-out.** A popular page with many followers × content saves
   can flood inboxes; mitigated by `notifications.md` R82.6 (200-recipient cap)
   + R82.7 (dedupe) and the existing `take 50` read cap
   (`queries.ts:426-432`) — but the unread badge counts **all** unread
   (`:434-436`), so without dedupe the badge becomes noise.
4. **Visibility re-check cost.** Scoping every dispatch through
   `pageScopeFor`/guest scoping adds queries to the comment/save hot path;
   dispatch must stay after-commit and non-fatal (R79.5e → R82.8).
5. **i18n ratchet.** New `LABELS` keys must go through the B07/B08 anchor-line
   script; raising coverage is allowed, hardcoded strings in translated files
   are not.

**Open questions**

- **O79.1** — Reply notifications target the parent author only
  (`comments.ts:55-69`); `notifications.md` **R82.9** preserves that behavior
  on purpose ("migrated with no behavior change"). Should it instead notify
  every participant of the thread (product-class behavior) — i.e. amend
  R82.9 — and does that change the dedupe key (R82.7)?
- **O79.2** — Default visibility of resolved threads: hidden behind a toggle
  (R79.2d) vs. always visible with a badge (today). Confirm with UX before
  T79.2.
- **O79.3** — Does `comment.resolved` deserve a webhook event
  (`dispatchWebhooks` already runs for `comment.created`, `comments.ts:104-107`)?
- **O79.4** — R82.7's dedupe keys are per-type, so a follower who is also
  mentioned in the same burst still gets `page.updated` + `page.mention` (two
  rows). Is cross-type suppression wanted (a follower-mention should probably
  win), or is two rows acceptable?
- **O79.5** — Matrix rows 371 ("Following pages 🧭 Planned") and 372
  ("Notification inbox 🧭 Planned") both understate shipped code (bell at
  `page-title.tsx:338-356`; inbox route at `src/app/w/[slug]/inbox/page.tsx`).
  Glyphs are untouched here (Notes-only); maintainers should re-baseline
  those two rows after T79.5.
- **O79.6** — Notification preferences (row 373) is 🧭 but specified:
  `notifications.md` **R82.15-R82.18** resolve page → workspace → default and
  gate inside `notify()` (R82.5). Question for T79.5 sequencing: is
  `page.updated` a `respect` class from day one (R82.5 lists it), and should
  preferences land before the extra call sites in R79.5b?

## 9. Relationship to other specs (coherence)

- **`docs/specs/notifications.md` (B82, landed first)** — its §14 declares the
  seam: "@mention dispatch to inbox" and "follow notification dispatch" are
  **specified there as R82.10-R82.13**; this spec cites those IDs (R79.4,
  R79.5) and keeps ownership of the comment-side event sources' UX plus the
  unclaimed residue (edit-time dispatch R79.4c, anchor-aware arrival R79.3e).
  Neither spec restates the other's semantics; both edit matrix Notes
  as Notes-only entries.
- **`docs/specs/engineering-hardening.md` (B28)** — DEC28.1 / R28.1-R28.5 own
  block identity (`id` attr, `ensureBlockIds`, backfill script); its §2.1 audit
  independently reaches the same verdict this spec does on `Comment.blockId`
  ("a schema-shaped hole with no writer"). Note: its citation `validation.ts:65`
  is stale — `commentSchema.blockId` is at `validation.ts:135` today (their
  row to correct).
- **`docs/specs/realtime-collab.md` (B09)** — non-goals `:222-224` exclude
  comment anchoring (→ R79.3 owns it) and `:224` leaves `PageFollow`
  notification semantics to `notifications.md` (R82.12); R9.24 presence-follow
  stays out of scope here. R79.3f keeps anchor ids CRDT-safe for it.
- **`docs/specs/automations.md` (R27.9)** — automation `notify` writes the same
  `Notification` table through `notify()`; unrelated to comment sources but
  shares the seam and the inbox renderer.
- **Matrix rows (B79, Notes-only, glyphs untouched)**: §7 rows *Page
  comments* (`:357`), *Inline comments* (`:358`), *Comment threads* (`:359`),
  *Resolve comment* (`:365`), *Comment reactions* (`:367`), *Comment mentions*
  (`:368`), *Following pages* (`:371`), *Notification inbox* (`:372`), *Activity
  trail* (`:375`). Rows 372/373 also carry B82's notes — both landed intact.
- **Live coverage**: B40 owns `e2e/comments.spec.ts`, B41 owns
  `e2e/inbox.spec.ts` — read-only throughout this change; their 7 tests are the
  non-regression floor for every task above.

## 10. Non-goals (this spec)

- **Delivery semantics for mention/follow/share notifications** — normative in
  `docs/specs/notifications.md` (R82.1-R82.13); cited here, never restated.
- **Minting, backfill and enforcement of stable block ids** — owned by
  `docs/specs/engineering-hardening.md` (DEC28.1, R28.1-R28.5).
- CRDT/presence/multiplayer, follow-*mode* (watching someone's cursor) — owned
  by `docs/specs/realtime-collab.md` (R9.16-R9.24), which explicitly excludes
  comment anchoring (`realtime-collab.md:222-224`).
- Suggestions/review mode, workspace chat, notification preferences
  implementation (R82.15-R82.18), retracting already-delivered notifications
  when a mention is edited away.
- Retrying or re-running the B40/B41 e2e suites (they own their evidence).
