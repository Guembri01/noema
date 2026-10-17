# Spec — Notifications (server dispatch, per-page preferences, toast standard)

> **Status: spec complete, implementation pending.** This document is the
> deliverable; no production code was changed.
> Every claim about the current code cites file + line. Requirement IDs
> (`R82.x`) are the traceability anchors: §13 lists tasks 1:1 against them, and
> tests must cite the IDs they cover. Components are **read-only** here —
> the inbox/follow e2e (`e2e/inbox.spec.ts`) is owned elsewhere (**B41**), so
> nothing in this spec may be validated by touching those files.

---

## 1. Problem statement

Noema can *write* `Notification` rows and *read* them back in an inbox, but the
system in between — who gets notified, under which preferences, on which
channel, and how the user hears about it — does not exist:

- **Only two write sites exist in the whole app** (`addCommentAction` reply +
  mention), and neither consults a preference: `Off` and `Mentions only`
  change nothing.
- The **Notify me → Comments submenu ships client-side only** (B11): the level
  lives in `localStorage` under `noema:page-notify:<pageId>` and is read by
  nothing on the server — the matrix row for it is 🟡 for exactly that reason.
- The **follow bell is write-only**: `PageFollow` rows are created and read for
  the button's own state, but no dispatcher ever looks at followers.
- There is **no delivery beyond "revalidate and hope"** — no polling, no SSE,
  no email, no digest; the badge updates when the user happens to navigate.
- The **toast surface is a sprawl**: 202 `toast.*` call sites across 41 files,
  of which 51 are English string literals that never reach `t()`.

The goal is a notification system with **one server-side dispatch entry point**,
**preference resolution (page → workspace → user)** that the same dispatcher
enforces, an inbox/badge that is honest about workspace scope, and a **written
toast standard** that the coherence gate can keep enforcing.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| `Notification` model | `prisma/schema.prisma:362-373` | `id, userId, type String, payload Json?, read, createdAt`, `@@index([userId, read])`. **No `workspaceId`, no `actorId`, no `dedupeKey`, no `readAt`.** Type is a free string, not an enum. |
| Write site #1 — reply | `src/server/actions/comments.ts:61-68` | `prisma.notification.create` `type: "comment.reply"`, payload `{pageId, commentId}`; self-excluded at `:60`. |
| Write site #2 — mentions | `src/server/actions/comments.ts:73-93` | `extractMentions` → all workspace members → name/email match → `createMany` `type: "page.mention"`; actor excluded at `:81`. |
| Mention helpers (pure) | `src/lib/comments.ts:29-53` | `extractMentions` + `mentionMatches`, unit-tested; a good pattern to keep. |
| Mark read | `src/server/actions/notifications.ts:7-23` | `updateMany({ where: { id, userId } })` — IDOR-safe; `markNotificationRead` is now referenced (AUDIT F-04 fixed). |
| Read model | `src/server/queries.ts:426-436` | `getNotifications(userId, take = 50)` — **workspace-blind, hard-truncated at 50**, no cursor; `getUnreadNotificationCount(userId)` likewise global. |
| Inbox route | `src/app/w/[slug]/inbox/page.tsx:11-15,54-94` | Renders labels from a **hard-coded English `LABELS` map** (`:71-72` falls through to the raw enum for unknown types); deep link built as `/w/${workspace.slug}/${payload.pageId}` (`:56-58`) — **uses the *current* workspace slug**, so a row from another workspace links to a page id that does not exist there. |
| Badge plumbing | `src/app/w/[slug]/layout.tsx:55,85` → `src/components/workspace-shell.tsx:53` → `src/components/sidebar/home-links.tsx:94-96` | Unread count is fetched server-side per workspace render and is **global per user**. |
| Follow bell | `prisma/schema.prisma:468-479`; `src/server/actions/pages.ts:463-481`; read at `src/app/w/[slug]/[pageId]/page.tsx:58,133`; UI `src/components/page-title.tsx:338-346` | Toggle persists `PageFollow` and toasts `"Following page"`/`"Unfollowed"`. **No dispatcher reads `PageFollow` — zero notification rows ever reference a follower.** |
| Notify me (B11) | `src/components/page-title.tsx:102-103,127-137,252-262`; type `src/components/topbar/actions-menu.tsx:63`; menu entry `src/lib/actions-menu.ts:196-202` | Level `all \| mentions \| none` persisted per page in `localStorage` only. Comment dispatch never reads it. |
| Person chips in the editor | `src/lib/mentions.ts:7,22,52` (`MentionType`, `collectMentionIds`, `userMention`); menu `src/server/actions/mentions.ts:17-56` | The editor can insert **user** mention nodes; **no notification is written when one is added or saved** — matrix row "Person mention 🟡" (`docs/FEATURE_MATRIX.md:108`) says "notifications on mention minimal", and for chips it is in fact zero. |
| Share → notify | `src/server/actions/share.ts:98-110` | Creates a `ShareLink` and logs **Activity** `page.shared` (`:108`). The inbox ships a `"page.shared"` label (`inbox/page.tsx:14`) with **no production writer** — the only row of that type is an e2e fixture insert (`e2e/inbox.spec.ts:197`). |
| Delivery mechanisms | repo-wide scan: 0 hits for `EventSource`, `socket.io`, `useSWR` | Nothing pushes or polls; `revalidatePath("/w", "layout")` (`comments.ts:108`) only invalidates the acting user's own router cache. |
| Mail capability | `src/lib/mailer.ts:27,105,172` (`resolveMailConfig`, `sendMail`, `emailTemplate`); config `src/server/actions/email.ts:115-182` | SMTP transport + templates exist and are used for invites — **never for notifications**. |
| Cron capability | `src/app/api/cron/templates/route.ts:39-64` (`CRON_SECRET` + `x-cron-secret`, fail-closed 503, `rateLimit(request, "cron", 12, 60_000)`); limiter `src/lib/api-guard.ts:8` | A proven, unit-tested scheduler endpoint shape (`route.test.ts:109-120`) to reuse. |
| Async fan-out pattern | `src/lib/webhooks.ts:213` (`dispatchWebhooks`) | Fire-and-forget with swallowed errors — the pattern dispatch must copy so notifications can never fail a user action. |
| Toasts | `src/components/ui/toaster.tsx:6-24`, mounted once at `src/app/layout.tsx:46` | Sonner, `bottom-right`, CSS-var theme. Centralized positioning exists and is respected today. |
| Toast call sites | repo scan (src, `*.ts`/`*.tsx`) | **202 `toast.*` sites in 41 files**: 51 string literals (English-only), 45 via `t()`, 106 dynamic expressions (server error strings, variables). Worst literals: `page-title.tsx` (12), `database/database-view.tsx` (8), `editor/block-context-menu.tsx` (5), `sidebar/importers.tsx` (5), `sidebar/page-tree.tsx` (5). |
| Error surface | `src/lib/actions-client.ts:129-138` (`guarded`/`safeAction`), `src/components/action-error-guard.tsx:23` | Two legitimate error paths already exist; call sites that hand-roll `toast.error(serverString)` bypass them. |
| Coherence bans | `scripts/check-coherence.mjs:49-53` | `window.prompt`, `window.alert`, **`toast.info`** are gate failures; `:26,82-84` i18n coverage baseline `i18nFiles: 71` may grow, never shrink. |
| Live coverage | `e2e/inbox.spec.ts:99,181,251` (296 lines, **B41-owned**) | mention → notification, single-row mark read, follow toggle persistence. |

### 2.2 What the product class (Notion) does

1. **A single notification stream** per user: mentions, replies, page shared
   with you, page edits you follow, workspace invites — each with *who*, *where*,
   and a deep link that lands on the anchor.
2. **Notify me** with real, per-page levels (All / Mentions / Off) that are
   honored by the server, plus workspace-level defaults.
3. **Live awareness**: the badge changes while you are looking at the app, and
   a mention that arrives in-session surfaces once as a toast/panel entry.
4. **Email digests** (daily/instant) as an opt-in channel, off for chatty
   events, never for self-triggered ones.
5. **Toasts for user-initiated confirmations only** — consistent wording,
   localized, never the sole channel for background events.

### 2.3 Defects this feature must close

- **D1 — bell is write-only.** `toggleFollowAction` (`pages.ts:463-481`) is the
  only consumer of `PageFollow`; following a page notifies nobody (audit in
  `docs/specs/realtime-collab.md:53` agrees).
- **D2 — rows are workspace-blind.** No `workspaceId` (`schema.prisma:362-373`)
  + workspace-blind query (`queries.ts:426-432`) + slug from the *current*
  route (`inbox/page.tsx:56-58`) ⇒ workspace A's inbox shows workspace B's rows
  and 404-links them into A.
- **D3 — labels are English-only.** `inbox/page.tsx:11-15` bypasses `t()` while
  the surrounding page is translated (`:37,42,50,76,85`), and unknown types
  render as raw enum text (`:72`).
- **D4 — `page.shared` has no writer.** Label ships, Activity log exists,
  notification row does not (`share.ts:98-110`).
- **D5 — editor person chips never notify** (2.1), while comment-body tokens do
  ⇒ same intent, two different outcomes.
- **D6 — preferences are decorative.** The only stored preference is in
  `localStorage` (`page-title.tsx:102,255`); the dispatcher would not read it
  even if it existed (B11 finding).
- **D7 — no preference gate at the write sites.** `comment.reply` and
  `page.mention` are written unconditionally (`comments.ts:61-92`) — "Mentions
  only" does not mute replies, "Off" mutes nothing.
- **D8 — no live delivery.** Zero polling/stream hits; badge staleness equals
  the user's navigation cadence (`layout.tsx:55`).
- **D9 — payload too thin.** `{pageId, commentId}` only (`comments.ts:65,89`):
  no workspace, no actor, no excerpt, and the comment's own `blockId`/`quote`
  (`comments.ts:47-48`) are dropped, so the inbox cannot say *who/where* and
  cannot deep-link to the anchor.
- **D10 — no cap, no dedupe, no retention.** A comment mentioning 500 members
  writes 500 rows in one call (`comments.ts:84-92`); nothing ever prunes rows;
  reads truncate at 50 (`queries.ts:430`).
- **D11 — recipients are not visibility-filtered.** Mention targets are every
  workspace member whose name matches (`comments.ts:75-83`), including members
  who cannot open a restricted page — even though `PagePermission` exists
  (`schema.prisma:481-493`) and the mention *menu* already scopes with
  `pageScopeFor` (`mentions.ts:28-31`, `guest-access.ts:84`). A notification
  therefore discloses a page id to a non-viewer.
- **D12 — toast sprawl** (2.1): English literals, ad-hoc wording, no taxonomy;
  the only shared surface is positioning/theme.
- **D13 — no second channel.** Mailer + SMTP config + cron endpoint all exist
  and are unused for notifications; `docs/MISSING_FEATURES.md:19` lists
  "per-user delivery preferences and digests" as an open gap.

**Working well and must not regress:** IDOR-safe mark-read
(`notifications.ts:16-23`), per-item *Mark read* + *Mark all read* (AUDIT F-04
resolved), pure mention helpers with tests
(`src/lib/comments.ts`), the badge plumbing chain (2.1), B41's live e2e, and
the coherence gate's native-dialog/`toast.info` bans.

## 3. Decision

| Option | Fit | Verdict |
| --- | --- | --- |
| **Central `notify()` module + `NotificationPreference` rows + polling badge + sonner catalog** | Reuses the existing table, mailer, cron endpoint shape and webhook-style fire-and-forget; no new infrastructure; every defect D1-D13 maps to a requirement. | **Chosen.** |
| Keep per-call-site writes, add settings UI only | Preferences would still be advisory (D6/D7 stay), and each new source re-implements self-exclusion, caps and links (D9-D11). | Rejected — the current defect class is *architecture*, not feature count. |
| Realtime push (SSE/WebSocket) for the badge | Correct long-term, but a second delivery transport before the data model carries `workspaceId`/`actorId` ships the same bugs faster; collab work (B09/`realtime-collab.md`) owns the WS story. | Deferred to M3 as an *additive* transport behind the same dispatcher. |
| Email as the primary channel | Mailer exists, but SMTP is optional (`resolveMailConfig` can report "not configured") and invites already own it; making email primary would fail-open on missing SMTP. | Rejected — email is an opt-in *secondary* channel (M2), inbox stays primary. |

**Decision:** server-side dispatch module + preference rows + workspace-scoped
inbox + polling badge + one toast catalog — delivered in three migrations (§12).

## 4. Requirements (numbered, testable)

### Dispatch

- **R82.1** — All notification writes go through **one** entry point,
  `notify()` in a new `src/server/notifications/dispatch.ts`. After M1, a repo
  scan finds **zero** `prisma.notification.create/createMany` outside that
  module; the two current sites (`comments.ts:61-68`, `:85-92`) are migrated.
- **R82.2** — Every row carries `workspaceId`, `type`, `actorId`, `dedupeKey`
  and `payload { workspaceId, pageId, blockId?, commentId?, actorName, title }`.
  Deep links resolve from the row's own workspace, never from the current route
  (closes D2/D9).
- **R82.3** — Recipient sets are **visibility-filtered**: a user only receives
  a row for a page they can open (same semantics as the mention menu's
  `pageScopeFor`, `guest-access.ts:84`, plus `PagePermission`,
  `schema.prisma:481-493`). A non-viewer never learns a restricted page id.
- **R82.4** — The actor never notifies themselves; exclusion happens once in
  `notify()` (generalizing `comments.ts:81`), not per call site.
- **R82.5** — `notify()` applies the recipient's resolved preference itself.
  Event classes are declared per type: `respect` (comment reply, comment
  mention, editor mention, page updated) vs `always` (page shared with you,
  invite, membership/role change, security). A call site cannot bypass the gate.
- **R82.6** — Fan-out is capped at **200 recipients per event** and written in
  `createMany` chunks of ≤ 500; truncation records an `Activity` row naming the
  event so the loss is visible (closes D10's unbounded growth).
- **R82.7** — **Idempotency**: `notify({ dedupeKey })` with a deterministic key
  (e.g. `comment.reply:<commentId>:<recipientId>`); a duplicate call within
  24 h is a no-op, enforced by `@@unique([userId, dedupeKey])` (Postgres allows
  repeated `NULL`, so source types without a key are unaffected).
- **R82.8** — Dispatch **never fails the triggering action**: `notify()` is
  try/caught and its failure logged (Activity `notification.failed`), following
  `dispatchWebhooks` (`webhooks.ts:213`). `addCommentAction` still returns
  `{ ok: true }` if a notification insert throws.

### Event coverage (sources)

- **R82.9** — *Comment reply* → parent author (`respect`). Migrated from
  `comments.ts:61-68` with no behavior change other than R82.2-R82.7.
- **R82.10** — *Comment mention* → matching members (`respect`), preserving the
  pure-helper matching (`src/lib/comments.ts:29-53`) and adding R82.3.
- **R82.11** — *Editor person chip*: saving a page whose doc **gained** a `user`
  mention node (`userMention`, `mentions.ts:52`) notifies the mentioned user
  once, with `blockId` when the node sits in a block with an id. Detection is a
  diff of `collectMentionIds(doc, "user")` against the previous version —
  never on every keystroke, never for chips that merely survive an edit
  (closes D5 / matrix 🟡 "notifications on mention minimal").
- **R82.12** — *Follow bell*: followers of a page receive `page.updated` rows
  when someone else materially changes it (title or content edit), deduped to
  **≤ 1 row per page per follower per 24 h** by `dedupeKey`
  (`page.updated:<pageId>:<recipientId>:<date>`). Unfollowing stops dispatch
  from that moment (closes D1). `PageFollow` stays a bell — it is *not* the
  presence-follow of `realtime-collab.md` R9.24.
- **R82.13** — *Page shared with you*: creating a `ShareLink` for a specific
  grantee (and `setPagePermissionAction`, `page-permissions.ts:51`) writes a
  `page.shared` row; anonymous link creation (no grantee) writes none (closes
  D4). The existing Activity log at `share.ts:108` stays as-is.
- **R82.14** — *Other domains* (ticket assignment/comments, automations `notify`
  action, invites) call the same `notify()`; automation semantics remain owned
  by `docs/specs/automations.md` R27.9 (`:185-190`) — one table, one gate, no
  second channel. Domains that have not implemented their source yet simply
  have no rows; this requirement forbids them from *bypassing* the module when
  they arrive.

### Preferences

- **R82.15** — `NotificationPreference` rows resolve in the order
  **page → workspace → user default (`all`)**, in one pure function
  `resolveNotifyLevel(userId, workspaceId, pageId)` (unit-tested matrix).
- **R82.16** — Levels are exactly `"all" | "mentions" | "none"` — the union
  already shipped as `NotifyLevel` (`topbar/actions-menu.tsx:63`). Adding a
  level requires updating the union, the resolver and the submenu together.
- **R82.17** — *Notify me → Comments* becomes server-backed:
  `setPageNotifyLevelAction(pageId, level)` writes the page-level row after the
  existing access check. The `localStorage` key (`page-title.tsx:102`) is a
  **migration source only**: on first load, if no server row exists, the client
  hydrates from `localStorage` once and then relies on the server value.
  Components are untouched in B82 (read-only) — the hydration lands with the
  implementation (T82.4).
- **R82.18** — Preference reads/writes are scoped to the acting user
  (`where: { userId, pageId }`) and to a page the user can access; no IDOR,
  no cross-user reads (mirrors `notifications.ts:16-23`).
- **R82.19** — A workspace-level *Notifications* section in settings sets the
  default for the workspace (and the email-digest toggle of R82.27); defaults
  are `all` for reply/mention, `none` for `page.updated`.
- **R82.20** — `none` never suppresses `always`-class rows (R82.5): invites,
  security events and workspace membership changes always land.

### Inbox, badge, live delivery

- **R82.21** — The inbox shows the user's rows with a workspace filter
  **defaulting to the current workspace**; a row's link targets its own
  workspace (R82.2), and an "All workspaces" scope makes every row reachable.
  The list shows **actor name + page title** from the payload, not a static
  sentence (closes D3/D9).
- **R82.22** — Badge semantics **do not change**: `unreadCount` stays global
  per user (`queries.ts:434-436`, `layout.tsx:55`) so B41's e2e and the sidebar
  stay green; only the *inbox list* gains workspace scoping (R82.21).
- **R82.23** — `markNotificationRead` / `markAllNotificationsRead` keep their
  `updateMany({ where: { userId, … } })` shape; following a row's link marks it
  read, and the per-row *Mark read* button remains (a11y + B41's
  `e2e/inbox.spec.ts:181`).
- **R82.24** — Listing is cursor-paginated (20 per page) — the fixed
  `take = 50` (`queries.ts:430`) disappears; older rows are reachable.
- **R82.25** — The badge refreshes **without navigation**: the workspace shell
  re-polls every **30 s**, only while `document.visibilityState === "visible"`,
  and never while hidden. No new transport in M1 (polling only); an SSE/poll
  swap may later sit behind the same `getUnreadNotificationCount` contract.
- **R82.26** — Newly observed rows surface as **one toast per poll batch**
  (never one per row), through the catalog (R82.30), suppressed while the inbox
  route is the active view and never for rows the user authored (R82.4).

### Channels, retention, ops

- **R82.27** — Email is an **opt-in secondary channel**: per-workspace digest
  (`off | instant | daily`), sent via `sendMail`/`emailTemplate`
  (`mailer.ts:105,172`), one digest per user per window regardless of row
  count, never sent when SMTP is unconfigured (`resolveMailConfig`,
  `mailer.ts:27`) — the run records an Activity instead of failing.
- **R82.28** — A cron endpoint `POST /api/cron/notifications` follows the
  templates route exactly: `CRON_SECRET` + `x-cron-secret`, fail-closed 503
  when unset, 401 on mismatch, `rateLimit(request, "cron", 12, 60_000)`
  (`cron/templates/route.ts:39-64`, `api-guard.ts:8`). It runs digest
  fan-out (R82.27) and pruning (R82.29).
- **R82.29** — Retention: rows with `read = true` older than **180 days** and
  any row older than **365 days** are deleted; per user at most the **500
  newest** are kept. Unread rows are never dropped by the age rule alone while
  under the cap.

### Toast standard

- **R82.30** — Exactly **one** `<Toaster>` (mounted at `src/app/layout.tsx:46`
  via `src/components/ui/toaster.tsx:6-24`). No component mounts another; no
  call site overrides `position`, `theme` or `style`. `toast.warning` and
  `toast.message` are allowed; **`toast.info` is banned** (coherence gate,
  `scripts/check-coherence.mjs:49-53`), as are `window.alert`/`window.prompt`.
- **R82.31** — **Strings are localized.** Every literal toast message goes
  through `t()` with keys added across all 5 locales via the i18n key inserter;
  dynamic server error strings go through `describeActionError`. Target: the
  51 literal call sites reach 0 for migrated files, and the coherence i18n
  baseline (`i18nFiles: 71`, `check-coherence.mjs:26`) never shrinks.
- **R82.32** — **Errors route through the shared paths**: action/transport
  failures surface via `useAction`/`guarded()` (`actions-client.ts:129-138`) or
  `ActionErrorGuard` (`action-error-guard.tsx:23`). Hand-rolled
  `toast.error(serverString)` for transport failures is retired; field-level
  validation messages from the server remain allowed (they *are* the UX).
- **R82.33** — A **catalog** module (`src/lib/toast-catalog.ts`) owns the
  recurring messages (link copied, page duplicated, moved to trash, following,
  comment notification level, token revoked, …) as typed presets so the same
  operation reads identically on every surface: verb-first, no trailing period,
  one optional action label ("Undo", "Open"). New messages are added there
  first; call sites import presets instead of inline strings.
- **R82.34** — **Durations**: success/message 4 s, error 8 s, promise/progress
  ≤ 10 s. Setting `duration` anywhere outside the catalog (or the Toaster
  default) is a lint failure.
- **R82.35** — **Semantics**: success toasts confirm *user-initiated* actions
  only; background events (incoming notifications, sync) use R82.26's batched
  toast; destructive actions are never confirmed by a toast alone (inline state
  or dialog first); a toast is never the only place information exists.
- **R82.36** — **Enforcement is scripted**: a `scripts/check-toasts.mjs`
  (wired as `npm run check:toasts`, referenced from the coherence gate notes)
  asserts: single `<Toaster>`, zero `toast.info`, zero `window.alert/prompt`,
  zero unapproved `duration` overrides, and reports the literal-string count so
  R82.31's target can only move down.

## 5. Data model

```prisma
model Notification {
  id          String    @id @default(cuid())
  userId      String
  workspaceId String?            // nullable so M1 backfill can't lose rows
  actorId     String?            // null = system (cron, automations)
  type        String             // "comment.reply" | "page.mention" | "page.updated" | "page.shared" | …
  payload     Json?              // { workspaceId, pageId, blockId?, commentId?, actorName, title }
  dedupeKey   String?            // idempotency (R82.7)
  read        Boolean   @default(false)
  createdAt   DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, dedupeKey])
  @@index([userId, read])
  @@index([userId, workspaceId, createdAt])
}

model NotificationPreference {
  id          String   @id @default(cuid())
  userId      String
  workspaceId String?            // workspace-level default (pageId null)
  pageId      String?            // page-level override (workspaceId null)
  level       String             // "all" | "mentions" | "none"
  email       String  @default("off")   // "off" | "instant" | "daily" (R82.27)
  updatedAt   DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, workspaceId, pageId])
  @@index([userId, workspaceId])
}
```

- `PageFollow` (`schema.prisma:468-479`) is unchanged — it is a *subscription
  input* to R82.12, not a notification store.
- `Notification.type` stays a **string**: the automations spec (R27.9) and the
  ticket domain add types independently; a Prisma enum would turn every new
  source into a schema migration. The closed set lives in
  `src/server/notifications/types.ts` with a typed union + inbox labels.
- `level`/`email` stay strings for the same reason (a `NotifyLevel` enum in TS
  is the contract, R82.16).

## 6. Dispatch contract

```ts
// src/server/notifications/dispatch.ts
export type NotificationClass = "respect" | "always";
export type NotifyInput = {
  type: NotificationType;
  recipients: string[];          // already resolved + visibility-filtered (R82.3)
  actorId?: string;              // excluded once (R82.4)
  workspaceId?: string;
  payload: NotificationPayload;  // R82.2
  dedupeKey: (userId: string) => string;  // R82.7
  klass?: NotificationClass;     // default "respect" (R82.5)
};
export async function notify(input: NotifyInput): Promise<void>;  // never throws (R82.8)
```

- **Order of operations:** dedupe recipients → drop actor → visibility filter
  (caller passes already-filtered ids; `notify` re-checks workspace membership
  as a belt) → resolve each recipient's level → filter by class → cap 200 →
  chunked `createMany` with `dedupeKey` → optional email enqueue (M2).
- **Where the preference read lives:** one query for the batch
  (`Preference where userId in (...) AND (workspaceId = ? OR pageId in (?))`),
  resolution in the pure `resolveNotifyLevel` — no N+1.
- **Email and pruning** are *not* called from request paths; they run only in
  the cron endpoint (R82.28).

## 7. Preferences & Notify me (UX)

- Submenu state label = server value; optimistic set, rollback on error toast
  (catalog preset, R82.33).
- Resolution shown to the user: switching a page to *Mentions only* while the
  workspace default is *All* writes a page row; *Reset to workspace default*
  deletes it (the action accepts `null` level = delete row).
- Hydration/migration (R82.17): read `localStorage` once → if a server row
  exists, server wins; otherwise write the localStorage value up and clear the
  key. Never reads localStorage after the first paint of a page with a server
  row.
- Settings section (R82.19) edits the workspace row and lists its three
  channels per event class; it must show the `always` exceptions inline so
  "Off" is never surprising (R82.20).

## 8. Inbox & badge (UX)

- Row: unread dot → actor name + verb + page title → relative time → row menu
  (Mark read / Open). Deep link `/w/{rowWorkspaceSlug}/{pageId}` plus
  `#block-{blockId}` when present.
- Filter chips: *Current workspace* (default) | *All workspaces*; empty state
  keeps `youAreAllCaughtUp` (`i18n.ts:208`).
- Labels come from the typed registry (`types.ts`) through `t()` — no inline
  English (`inbox/page.tsx:11-15` retired, D3).
- Badge: unchanged global count (R82.22); polling only while visible (R82.25);
  batched arrival toast (R82.26).

## 9. Toast standard (normative summary)

| Rule | Value | Enforced by |
| --- | --- | --- |
| Instances | exactly one `<Toaster>` (`app/layout.tsx:46`) | R82.30, `check-toasts.mjs` |
| Variants | `success`, `error`, `warning`, `message` — **no `toast.info`** | R82.30 + coherence `:49-53` |
| Strings | `t()` or `describeActionError`; literal count → 0 per migrated file | R82.31, coherence i18n baseline |
| Errors | `guarded()` / `ActionErrorGuard`, never raw transport strings | R82.32 |
| Wording | catalog presets, verb-first, no period, optional action | R82.33 |
| Duration | 4 s success · 8 s error · ≤ 10 s promise | R82.34, `check-toasts.mjs` |
| Role | confirmations only; background events batched; never sole channel | R82.35, R82.26 |
| i18n keys | added through the i18n key inserter to all 5 locales | R82.31 (no ratchet raise) |

## 10. Edge cases

| Edge | Behavior |
| --- | --- |
| Mention of someone without page access | Dropped by R82.3; no row, no link, no disclosure. |
| Recipient leaves the workspace after the row is written | Row remains (historical), but the deep link 404s through the normal access check; inbox shows it greyed with "no longer accessible" — never leaks content. |
| Page moved to another workspace | `workspaceId` on the row is a *snapshot*; the link resolver re-checks the page's current workspace and redirects (or reports moved) instead of 404. |
| Actor notifies themselves (reply to own comment, mention of self) | Excluded once in `notify()` (R82.4). |
| Same comment submitted twice (double click, retry) | `dedupeKey` makes the second insert a no-op (R82.7). |
| Comment mentions 500 members | 200 rows + Activity noting truncation (R82.6). |
| Notification insert fails | Action still succeeds; Activity `notification.failed` (R82.8). |
| `Off` + an invite arrives | Invite is `always` → row still lands (R82.20). |
| Tab hidden for 10 h | Zero polls; on return, one batched toast for everything new (R82.25/R82.26). |
| Inbox open while a mention arrives | Poll sees it, updates the list; arrival toast suppressed for the active inbox view (R82.26). |
| SMTP unconfigured + `instant` digest | Skipped with an Activity note; the in-app row is unaffected (R82.27). |
| User has > 50 notifications | Cursor pagination reaches all 500 retained (R82.24/R82.29). |
| Type added by automations/tickets | Registry + label required; inbox falls back to a generic localized line, never raw enum text (D3). |
| Followed page edited by the follower themselves | Not an update event for them (actor exclusion, R82.4); others get ≤ 1/day (R82.12). |

## 11. Test plan

**Unit (vitest, red-first)**

1. *Preference resolution* — page/workspace/default × `all|mentions|none` ×
   event class (`respect`/`always`) → boolean matrix (`resolveNotifyLevel`).
2. *Recipient pipeline* — actor exclusion, visibility filter (member with and
   without `PagePermission`), 200-cap truncation, chunking boundaries.
3. *Dedupe* — same `dedupeKey` twice ⇒ one row; different days ⇒ two
   (`page.updated` daily rule, R82.12).
4. *Payload/link* — workspace resolved from the row, not the route (fixture
   from workspace A rendered under slug B links into A) — closes D2.
5. *Toast catalog* — `check-toasts.mjs` itself: fixtures asserting it fails on
   a second `<Toaster>`, `toast.info`, an inline `duration`, a literal string.
6. *Inbox labels* — every `NotificationType` has a label key present in all 5
   locales.

**Integration (route tests, `route.test.ts` pattern from the cron templates)**

7. `/api/cron/notifications` — 503 without `CRON_SECRET`, 401 on wrong header,
   rate-limit 429, digest skips when SMTP unset, pruning boundaries (180 d/365 d
   /500-row cap).
8. `addCommentAction` end-to-end: reply + mention rows written, preference
   `none` suppresses them, and the comment still succeeds when `notify()` is
   stubbed to throw (R82.8).

**e2e (owner split)**

9. **B41's `e2e/inbox.spec.ts` stays green as-is** (mention creates a row,
   single mark read, follow toggle — `:99,181,251`). B82 does not edit it.
10. Implementation adds `e2e/notifications.spec.ts`: notify-me level set
    on page X is honored by a comment on X after reload (D6/D7), badge
    increments on another context's comment within one poll, inbox row links
    into its own workspace.

**Manual/gate**

11. `npm run check:coherence` → COHERENT (i18n baseline held, no
    `toast.info`/`alert`/`prompt`), `npm run check:toasts` → 0 violations,
    `npm run lint` + `npm run typecheck` green.

## 12. Migration path

- **M1 — model + dispatch + gate** (no UI change): schema (`workspaceId`,
  `actorId`, `dedupeKey`, `NotificationPreference`), `notify()` module, migrate
  the two comment write sites, R82.3/R82.4/R82.6-R82.8, unit 1-3, 8. Existing
  rows keep `workspaceId = null` (rendered under *All workspaces*).
- **M2 — preferences + inbox**: server-backed Notify me (R82.17), settings
  section (R82.19), inbox scoping/pagination/labels (R82.21, R82.24), badge
  polling + batched toast (R82.25-R82.26), email digests + cron (R82.27-R82.29),
  toast catalog + `check-toasts.mjs` (R82.30-R82.36).
- **M3 — remaining sources**: editor person chips (R82.11), follow dispatch
  (R82.12), share/grant (R82.13), then optional SSE behind the same contract.

Each milestone ships with its red tests citing its `R82.x` before
implementation (tier rule).

## 13. Delivery plan (milestones → tasks ↔ requirements)

**M1 — Dispatch backbone (~1-2 days)**

- T82.1 [R82.1,R82.2,R82.4,R82.5,R82.7,R82.8] `src/server/notifications/dispatch.ts`
  + `types.ts`. Red: unit 1, 3.
- T82.2 [R82.3,R82.6] visibility filter + fan-out cap. Red: unit 2.
- T82.3 [R82.9,R82.10] migrate `comments.ts:61-92` to `notify()`. Red: unit 8.

**M2 — Preferences, inbox, delivery, toasts (~3-4 days)**

- T82.4 [R82.15,R82.16,R82.17,R82.18] `NotificationPreference` +
  `setPageNotifyLevelAction` + hydration note for `page-title.tsx`. Red: unit 1.
- T82.5 [R82.19,R82.20] settings section + `always` display. Red: unit 1.
- T82.6 [R82.21,R82.22,R82.23,R82.24] inbox scoping, labels, cursor paging.
  Red: unit 4, 6; B41 e2e must stay green.
- T82.7 [R82.25,R82.26] visible-tab polling + batched toast. Red: e2e 10.
- T82.8 [R82.27,R82.28,R82.29] cron endpoint + digests + pruning. Red: integration 7.
- T82.9 [R82.30-R82.36] toast catalog + `check-toasts.mjs` + literal-string
  burn-down. Red: unit 5.

**M3 — Sources (~2 days)**

- T82.10 [R82.11] editor person-chip diff notify.
- T82.11 [R82.12] follow dispatch with daily dedupe. Red: unit 3.
- T82.12 [R82.13] `page.shared` on grant.

## 14. Relationship to other specs (coherence)

- **`docs/specs/automations.md` (R27.9, `:185-190`)** — the automation `notify`
  action creates rows in *this* table with the same inbox rendering; this spec
  owns the module, the preference gate and the payload shape, automations owns
  *when* rules fire. Neither duplicates dispatch.
- **`docs/specs/collaboration-deep.md` (B79, landed and already citing this
  spec)** — it audits the *comment surface* (threads, anchors, reactions,
  activity) and hands the two dispatch gaps over: "@mention dispatch to inbox"
  and "follow notification dispatch" are **normative here as R82.10-R82.13**
  (its §9 and R79.4/R79.5 cite `notifications.md` for delivery, dedupe,
  visibility and payload shape). Ownership split confirmed in both directions:
  B79 keeps the comment-side sources it added (edit-time dispatch R79.4c,
  anchor-aware arrival R79.3e) and sequences behind this spec's M1 `notify()`
  seam (its §13: "sequence behind B82's `notify()` seam").
- **`docs/specs/realtime-collab.md`** — its audit (`:53`) records the same
  write-only bell, and its non-goals (`:224`) explicitly leave `PageFollow`
  notification semantics to this spec (R82.12); R9.24 presence-follow stays
  separate.
- **`docs/specs/engineering-hardening.md` (`:76`)** — counts the two
  `notification.create*` calls inside `addCommentAction`; T82.3 will make that
  row read `notify(...)` instead (their row is theirs to update).
- **Matrix rows (B82, Notes-only, glyphs untouched)**:
  `docs/FEATURE_MATRIX.md` *Notification inbox* (`:372`), *Notification
  preferences* (`:373`), *Notifications / toasts* (`:603`), *Actions menu: Notify
  me* (`:623`).
- **Docs that already point here**: `docs/ROADMAP.md:127-128` (inbox UI [~]),
  `docs/MISSING_FEATURES.md:19` (gap 7 — generated from the matrix, do not
  hand-edit), B11 🟡 localStorage, F-04 fixed.

## 15. Risks & open questions (honest)

**Risks**

1. **Polling cost (highest).** A 30 s visible-tab poll hits a server component
   render per open tab. Mitigation: poll only the lightweight count route
   (`getUnreadNotificationCount`, `queries.ts:434`), not the whole layout;
   visibility gating; back off to 60 s after 10 idle minutes.
2. **Preference resolution drift.** The pure resolver must be the *only* place
   levels are interpreted, or `none` will be honored in one domain and ignored
   in another (the current defect). Enforced by R82.1 + unit 1 covering every
   class × level pair.
3. **Backfill ambiguity.** Existing rows lack `workspaceId`/`actorId`; they stay
   `null` and render under *All workspaces* rather than being guessed. No data
   rewrite in M1.
4. **Overlap with B79.** Both specs touch mentions/follow. Mitigation: §14
   declares the seam — B79 audits the surface, this spec owns dispatch
   semantics; Notes edits on the matrix are Notes-only so both can land.
5. **B41 e2e coupling.** Inbox semantics changes could break
   `e2e/inbox.spec.ts:181`. Mitigation: R82.22/R82.23 freeze badge semantics
   and the per-row button; this change touches neither file.

**Open questions**

- O82.1: Should `page.updated` follow dispatch default to **on** for explicit
  `PageFollow` rows (bell implies intent) while staying off for everyone else?
  Spec assumes yes (R82.19 sets workspace default `none` for `page.updated`,
  but an explicit bell row overrides it) — confirm with product.
- O82.2: Workspace filter default — *current workspace* (assumed, R82.21) vs
  *all workspaces* for users who belong to many. Cheap to flip after M2.
- O82.3: Digest window for `daily` (08:00 recipient-local vs 24 h rolling)
  and whether per-page digests are ever needed. Assumed: one daily digest per
  user, recipient timezone from `User.locale`/profile.
- O82.4: Should an editor person chip notify immediately (live save) or only
  after the page is saved (content is only durable then)? Assumed: on save
  (R82.11), which also avoids notifying for a chip that was typed and deleted.
- O82.5: Retention numbers (180/365/500) are policy guesses — cheap to change
  before M2 ships, expensive to justify after users notice disappearing rows.
