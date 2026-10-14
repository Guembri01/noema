# Spec — Realtime collaborative editing (CRDT + presence)

> **Status: spec complete, implementation pending.** Batch **B09** of the parity
> loop. This document is the deliverable; no production code was changed.
> Every claim about the current code cites file + line. Requirement IDs
> (`R9.x`) are the traceability anchors: the implementation plan in §14 lists
> tasks 1:1 against them, and tests must cite the IDs they cover.

---

## 1. Problem statement

Noema ships an **opt-in, unauthenticated, memory-only** Yjs relay
(`scripts/collab-server.mjs`) and a client wiring in
`src/components/editor/page-editor.tsx` that connects when
`NEXT_PUBLIC_COLLAB_URL` is set at build time. Two users who both have collab
enabled can technically type into the same document, but the result is not a
shippable multiplayer feature:

- the WebSocket server performs **no authentication or authorization** — any
  client that can reach the port can join any room name and read/write it;
- documents live **only in server memory** — a restart of `npm run collab`
  silently loses everything typed since the last debounced JSON save;
- identity in presence is hardcoded to `{"name":"You","color":"#2383e2"}` —
  every remote caret is indistinguishable;
- the persistence path (per-client debounced `updatePageAction`) was designed
  for a single editor and misbehaves with N editors (duplicate version
  snapshots, racing seeds).

The goal is **Notion-class multiplayer**: simultaneous multi-caret editing with
labeled live cursors and an avatar stack, correct merges via CRDT, persistence
that survives restarts, and offline edits that merge on reconnect — delivered
incrementally on top of the existing Yjs foundation, not a rewrite.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| WS relay server | `scripts/collab-server.mjs:1-122` | y-websocket wire protocol (`MESSAGE_SYNC=0`, `MESSAGE_AWARENESS=1`). One `Y.Doc` + `Awareness` per room, rooms keyed by the **raw URL path** (`:63-66`), state in an in-memory `Map` (`:20-21`), broadcast to all conns (`:32-36`), awareness cleaned up on disconnect (`:112-115`). Started via `npm run collab` (`package.json:39`), default port 1234. |
| Server auth | `scripts/collab-server.mjs:63-66` | **None.** No session check, no membership check, no rate limit. Room name = page id straight from the URL. |
| Client wiring | `src/components/editor/page-editor.tsx:242-252` | `WebsocketProvider(collabUrl, pageId, ydoc)` created when `NEXT_PUBLIC_COLLAB_URL` is set; awareness user hardcoded `"You"`/`#2383e2` (`:247-250`, again in caret config `:319-322`). |
| Editor integration | `page-editor.tsx:282, 316-324` | `StarterKit` history disabled in collab mode (`history: false`), `Collaboration` (ydoc) + `CollaborationCaret` extensions added when collab is on. TipTap v3's binding is `@tiptap/y-tiptap` (peer of `@tiptap/extension-collaboration`, present in `node_modules`; note: **no `y-prosemirror` package** — TipTap 3 replaced it). |
| Presence UI | `page-editor.tsx:253-263, 546-551` | Awareness states counted into a `Live · N` badge (top-right of the editor). That is the **entire** presence surface. The only other `Avatar` component in the app is in `src/components/comment-panel.tsx:341` (initials + deterministic seed). |
| Seeding | `page-editor.tsx:455-469` | If the room's `default` XML fragment is empty after provider sync, the client writes its server-loaded `initialContent` into the ydoc. |
| Save path | `page-editor.tsx:172-209, 436` | `onUpdate` → `persist` → 600 ms debounce → `runSave` → `updatePageAction(pageId, { content: JSON.stringify(editor.getJSON()) })`. |
| Server write | `src/server/actions/pages.ts:200-280` | `updatePageAction` authorizes via `authorizePage` + `canEditContent` (`:213-217`), snapshots a `PageVersion` **on every call** that changed content/title (`:234-251`), writes `content` + recomputes `searchText` via `pageSearchText` (`:263-274`, helper at `src/lib/search.ts:12`). **It does not check `Page.locked`.** |
| FTS mirror | `prisma/schema.prisma:208-210`, `src/server/queries.ts:255-307` | `Page.searchText` plain-text mirror, GIN-indexed by `npm run setup:search`, queried by `to_tsvector`/`ts_rank`. |
| Version history | `prisma/schema.prisma:245-258`, `src/server/actions/page-versions.ts:16-60` | `PageVersion` JSON snapshots; restore writes `content`+`title` directly — **does not touch `searchText` and knows nothing about ydocs**. |
| Page lock | `prisma/schema.prisma:206`, `src/app/w/[slug]/[pageId]/page.tsx:76-81`, `src/components/page-title.tsx:103,346-350` | `Page.locked` flag with a UI toggle; enforcement is **render-time only** (the page route computes `editable` excluding locked pages). Server actions accept content updates on locked pages. |
| Guest scoping | `src/lib/guest-access.ts:1-70`, `page.tsx:76-81`, `src/lib/permissions.ts:28-30` | Guests are read-scoped through `guestVisiblePageIds` and can never edit (`canEditContent` = not GUEST). The WS layer is unaware of any of it. |
| "Follow" | `src/components/page-title.tsx:102-180`, `src/server/actions/pages.ts:374-391`, `prisma/schema.prisma:468+` | The existing follow feature is a **page-subscription bell** (`PageFollow` row + toggle). No notification dispatch from followers was found in `src/`. It is **not** Notion's presence-follow (watching someone's cursor/scroll). |
| Smoke test | `scripts/check-collab.mjs:1-33` | Two in-process clients join one room, assert map update relay + awareness relay. No auth, no persistence assertions. |
| Docs | `docs/ROADMAP.md:52`, `docs/FEATURE_MATRIX.md:352-356,667` | Roadmap marks opt-in realtime "done"; matrix still plans multiplayer/presence/cursors/gateway. |

There is **no `src/lib/realtime*` module** — the batch brief's assumption of one
is incorrect; all realtime client code lives inline in `page-editor.tsx`.

### 2.2 What the product class (Notion) does

1. **Simultaneous multi-caret editing** — every keystroke from every member
   merges live; no "who saved last" semantics.
2. **Live cursors with identity** — remote carets carry the person's name and a
   stable per-person colour; selections render as translucent highlights.
3. **Presence avatar stack** in the page topbar with viewer list.
4. **Follow mode** — a participant can follow another person's viewport; their
   scroll and (optionally) cursor are mirrored, editing is suspended while
   following.
5. **Offline tolerance** — edits made offline merge on reconnect with no
   conflict dialogs.

### 2.3 Defects in the current opt-in path (must be fixed by this feature)

- **D1 — open relay.** No authn/authz on the WS channel (§2.1); a leaked page
  id (it is in the URL, share links, webhooks `page.updated` payloads) is
  enough to read and mutate a document.
- **D2 — volatile state.** In-memory rooms; restart loses CRDT state. Durable
  copy is whatever the last client debounce wrote to `Page.content`.
- **D3 — duplicate version spam.** Every connected client runs the same
  debounced save, so N clients create up to N `PageVersion` rows per edit
  burst (`pages.ts:234-251` snapshots on each call).
- **D4 — indistinguishable presence.** Hardcoded `"You"` identity (§2.1).
- **D5 — build-time switch.** `NEXT_PUBLIC_COLLAB_URL` is inlined at build
  (`.env.example:11-12`); enabling collab on a running deployment requires a
  rebuild.
- **D6 — lock is advisory.** Locked pages still accept `updatePageAction`
  content writes; under collab, remote peers would keep mutating a "locked"
  page (D6 turns a pre-existing server-side gap into a visible one).
- **D7 — seed race / stale seed.** Two clients racing to seed an empty room
  both write `initialContent` (CRDT merges = duplicated blocks); after a server
  restart the seed may replay stale DB content over a not-yet-persisted state.
- **D8 — restore bypasses the room.** `restorePageVersionAction`
  (`page-versions.ts:48-54`) writes `content` directly; connected editors keep
  their ydoc state and will clobber the restore at next persistence, and
  `searchText` is not recomputed even in the non-collab path.

## 3. Decision: CRDT approach

| Option | Fit | Verdict |
| --- | --- | --- |
| **Yjs + current TipTap binding** (`@tiptap/extension-collaboration` + `@tiptap/y-tiptap`, `y-websocket` protocol, `y-protocols` awareness) | Already installed (`package.json:57-58,97-99`) and wired (`page-editor.tsx:316-324`); the relay server already speaks the wire protocol; awareness exists; smallest reviewable diff; largest ecosystem for ProseMirror-family editors. | **Chosen.** |
| Automerge (`automerge-repo`) | Strong CRDT, but would replace the editor binding, the server, and every integration point built on y-websocket. TipTap support is third-party. No gain over Yjs for a ProseMirror doc. | Rejected — full rewrite of working code. |
| Lexical | Different editor core; Noema's entire block-extension set (TableKit, Mathematics, BlockColors, custom blocks…) is TipTap/ProseMirror. | Rejected — editor rewrite. |
| Plain OT | Needs a single authoritative transform server with total order; offline merge and arbitrary concurrent structural edits (block moves, table edits) are far harder to get right than with CRDTs; no awareness story. | Rejected — higher complexity, worse offline semantics. |

**Decision: Yjs, extending the existing foundation** (per the B09 brief:
"extend that foundation, not replace it"). The work is (a) security, (b)
persistence, (c) identity/presence UI, (d) persistence-path ownership — not a
CRDT swap.

## 4. Requirements (numbered, testable)

### Security & transport

- **R9.1** — The collab WS server **rejects any connection** whose HTTP
  upgrade request does not carry a valid `noema_session` cookie; close code
  `4401`. No room name is even parsed before auth succeeds.
- **R9.2** — On connect, the server resolves the room as `page:<pageId>` and
  asks the app's authorization layer whether the user may **read** this page.
  Denial → close `4403`. This check must honor: workspace membership
  (`getWorkspaceAccess` semantics, `src/lib/permissions.ts:10-26`) and guest
  page-scoping (`guestVisiblePageIds` semantics, `src/lib/guest-access.ts:46+`).
- **R9.3** — A user without edit rights on the page joins **read-only**:
  they receive sync + awareness, their `MESSAGE_SYNC` update payloads are
  dropped server-side (awareness payloads from them are still relayed, so
  viewers show as presence).
- **R9.4** — While `Page.locked = true`, the server drops all update payloads
  for that room (D6: **the lock wins over remote edits**, enforced where the
  data is written, not in the client). Unlocking resumes relay without a
  reconnect.
- **R9.5** — Room ids are never trusted as opaque strings: the server derives
  the room name itself from an internal `page:<cuid>` format; a room name that
  does not resolve to an existing, non-trashed page is refused.
- **R9.6** — Rate limits per connection: max 100 messages/s and max 512 KiB/s
  rolling average; exceeding either closes with `4429`. Awareness updates are
  throttled to 20/s per client (client-side throttle before send).
- **R9.7** — Cross-tenant safety: a workspace A member supplying a workspace B
  page id receives `4403` and the page id is not confirmed or denied beyond
  "forbidden" (no existence oracle for non-members).

### Persistence

- **R9.8** — The collab server persists every room's CRDT state to Postgres:
  a new `PageYDoc` row (one per page) holding the full Yjs state vector
  snapshot, updated **debounced ≥2 s after the last update** and **flushed at
  least every 30 s** while updates keep arriving.
- **R9.9** — On room load, the server hydrates the ydoc from `PageYDoc.state`;
  only when no snapshot exists does it seed from `Page.content` (server-side
  seeding — fixes D7: seeding is serialized in one place, exactly once).
- **R9.10** — Snapshot compaction/GC: raw updates are appended to `PageYUpdate`
  rows for auditability; when a page accumulates > 200 updates or > 1 MiB of
  log since the last snapshot, the server compacts (snapshot + truncate log) in
  a single transaction. Snapshots are additionally compacted on room close.
- **R9.11** — **Exactly one writer persists to the legacy columns.** The
  collab server (not clients) owns `Page.content` + `Page.searchText` for
  collab-enabled pages: after each snapshot it derives ProseMirror JSON from
  the ydoc and updates both columns in one `prisma` call. Clients in collab
  mode stop calling `updatePageAction` for content entirely (fixes D3).
- **R9.12** — `searchText` correctness: the derived JSON is passed through the
  same `pageSearchText(title, content)` helper (`src/lib/search.ts:12`) used by
  the action path, so FTS behavior is byte-identical to a manual save.
- **R9.13** — Version history keeps working as the human-facing timeline: the
  app writes a `PageVersion` snapshot **at most once per 5 minutes per page of
  actual activity** (change-detected), from the same derived JSON, recording
  the acting user as the most-recent editor. No per-client spam.
- **R9.14** — `restorePageVersionAction` becomes collab-aware: restoring a
  version on a page with a `PageYDoc` applies the restored content **into the
  live ydoc** (server-originated update broadcast to the room) instead of a
  raw `content` write, and recomputes `searchText` (fixes D8 for both modes).
- **R9.15** — Restart survival: killing and restarting `npm run collab` while
  two clients are connected results in both clients re-syncing from the
  persisted snapshot with **zero content loss** (assert with a marker string
  typed before the restart).

### Identity & presence

- **R9.16** — Awareness carries real identity: `user: { id, name, color,
  avatarUrl }` sourced from the authenticated session at connect time; the
  server injects it and **ignores** any client-supplied user field (a client
  cannot spoof another user's name/color/id).
- **R9.17** — Colour is deterministic per (workspace, user): hash-based from
  the user id into a fixed 10-colour palette (reuse the editor's `TEXT_COLORS`
  hues, `page-editor.tsx:118-129`) so the same person keeps one colour across
  pages.
- **R9.18** — Remote carets render with a name label and the user's colour;
  remote selections render as translucent highlights (`CollaborationCaret`
  already in the tree — identity wiring only, no new editor extension).
- **R9.19** — Topbar avatar stack: on the page route, when the provider is
  connected, render up to 5 avatars (initials-avatar pattern from
  `comment-panel.tsx:341`) + `+N`, each with `title="<name>"`; it must be
  keyboard-reachable and announce "N people viewing" via `aria-label` (a11y
  gate: `check:a11y` must stay green).
- **R9.20** — Disconnect hygiene: when a client's provider closes, its remote
  cursors/avatars disappear within 5 s (awareness removal is already relayed
  on conn close, `collab-server.mjs:112-115`; add client-side stale-peer GC for
  dropped awareness states).

### Availability & UX edges

- **R9.21** — Collab becomes a **runtime** setting: the client obtains the
  collab endpoint from a server-rendered config (e.g. `COLLAB_URL` exposed via
  the page payload / `/api/config`), removing the build-time constraint (D5).
  `NEXT_PUBLIC_COLLAB_URL` keeps working as an override for one release.
- **R9.22** — Offline: the ydoc buffers locally; on reconnect, buffered updates
  merge automatically (Yjs guarantees). The UI shows "Offline — changes will
  sync" using the existing save-state slot (`page-editor.tsx:552-565`). If the
  server reports the page was locked/deleted while offline, buffered edits are
  **discarded with a visible toast** (never silently merged into a locked
  page — ties to R9.4).
- **R9.23** — Non-collab pages (feature disabled, or a page where the collab
  server is unreachable for > 10 s) fall back to the current debounced-save
  editor with history enabled. Fallback must be automatic and logged.
- **R9.24** — Follow-mode (presence follow, distinct from the `PageFollow`
  bell): user A can "Follow" user B in the avatar stack; A's viewport is
  scroll-driven by B's anchor updates (awareness field), A's editor becomes
  read-only with a "Following <name> — click to stop" pill. This is **M3** and
  may ship as a separate slice; the bell feature is untouched.

### Non-goals (this spec)

- Suggestions/review mode, per-block authorship colors, comment anchoring
  changes, mobile offline apps, cross-workspace rooms, audio/video presence,
  changing the `PageFollow` notification semantics.

## 5. Data model

```prisma
model PageYDoc {
  pageId      String   @id            // 1:1 with Page (cascade on delete)
  state       Bytes                    // Y.encodeStateAsUpdate(doc) snapshot
  stateSize   Int      @default(0)     // bytes, for GC decisions
  updatedById String?                  // last user whose edit triggered snapshot
  updatedAt   DateTime @updatedAt
  page        Page     @relation(fields: [pageId], references: [id], onDelete: Cascade)
}

model PageYUpdate {
  id        BigInt   @id @default(autoincrement())
  pageId    String
  update    Bytes                     // incremental Yjs update
  originId  String?                   // user id
  createdAt DateTime @default(now())
  page      Page     @relation(fields: [pageId], references: [id], onDelete: Cascade)
  @@index([pageId, id])
}
```

- `Page.content` + `Page.searchText` remain the durable, human-readable,
  FTS-indexed copy (unchanged schema) — the ydoc is the realtime source of
  truth; the JSON columns are a **projection** maintained per R9.11.
- `PageVersion` untouched — still the user-facing history.
- Room naming: `page:<pageId>`; awareness state is ephemeral, never persisted.

## 6. Transport & contracts

- **Topology**: keep the **separate process** (`scripts/collab-server.mjs`,
  `npm run collab`), upgraded in place. It already speaks the y-websocket
  protocol clients expect; folding it into Next.js would require a custom
  server (fights `next start`) and buys nothing.
- **Authorization contract**: the collab server must not duplicate permission
  logic. It calls the app's internal endpoint
  `POST /api/internal/collab-auth` `{ pageId }` **with the user's cookie
  forwarded**; the endpoint (Node runtime, `AUTH_SECRET`-signed service token
  for itself) returns `{ read: boolean, write: boolean, locked: boolean }` by
  reusing `getWorkspaceAccess`, `guestVisiblePageIds` and `Page.locked` — one
  source of truth. Result is cached per (conn, page) for 30 s; lock flips are
  propagated by the app pushing a `lock` control message to the room (new
  small control frame beside `MESSAGE_SYNC`/`MESSAGE_AWARENESS`).
- **Why not cookie verification inside the collab server?** Verifying the
  HS256 JWT is easy, but *membership + guest scoping* lives in the Prisma
  codebase; duplicating it in a `.mjs` script is how permission drift happens.
  (Open question O9.3 weighs inlining via `tsx` instead.)
- **Client contract**: `WebsocketProvider(url, "page:"+pageId, ydoc, {
  params: { v: "2" } })`; server ignores unknown params for back-compat.
- **REST surface**: none new beyond `/api/internal/collab-auth` (not public,
  401 without service token or valid user session).

## 7. Presence UI spec

- **Caret**: 2 px caret in user colour + name label chip (colour-tinted
  background, white text), positioned by `CollaborationCaret`; label hides
  after 3 s idle, caret stays.
- **Selection**: remote selections as `color-mix(in srgb, <user color> 18%,
  transparent)` highlight.
- **Avatar stack**: right of the topbar page actions; 24 px circles,
  deterministic initials avatar + per-user colour ring; overlap −8 px; hover
  title = name; click opens viewer list popover (name + "Viewing"/"Editing").
- **Live badge**: `Live · N` moves into the stack's popover; the badge itself
  stays as the connectivity indicator (green connected / amber reconnecting /
  grey off).
- **i18n**: all new strings via `t()`; must not raise the i18n ratchet (new
  keys go through the anchor-line script discipline of B07/B08).

## 8. Conflict & edge spec

| Edge | Behavior |
| --- | --- |
| Two users type in the same paragraph | Yjs interleaves at character level; both see merged text (R9.15 test covers restart mid-merge). |
| User A deletes a block while B types in it | Yjs delete wins over concurrent insert position mapping; B's text survives re-anchored at the nearest surviving position (documented limitation — matches product-class behavior). |
| Offline A edits, B locks the page | On reconnect, server rejects A's buffered updates (R9.4); A's client discards the buffer with a toast (R9.22) — the local ydoc is then re-seeded from server state (client resets doc and re-syncs). |
| Version restore while room is live | Applied through the ydoc (R9.14); all connected clients see the restored content animate in; the restoring user's undo (Y.UndoManager, scoped per client) undoes only their own post-restore edits — restoring user gets an explicit toast "Version restored for everyone". |
| Page trashed mid-session | App pushes a control message; clients redirect/detach; room is deleted from the `Map` and its update log compacted. |
| collab server down | R9.23 fallback: editor works locally with history; a banner shows "Live sync unavailable". |
| Stale seed (D7) | Eliminated structurally — seeding happens once, server-side (R9.9). |
| Title rename during session | Title stays outside the ydoc (it is a column); rename path (`updatePageAction` title-only patch) is unchanged and does not create versions. |
| Search right after typing | ≤ snapshot debounce (2 s) + FTS index update; acceptable staleness, same class as today's 600 ms debounce. |

## 9. Test plan

**Unit (vitest, red-first)**

1. *Yjs merge determinism* — random interleaved update application on two/three
   docs ⇒ identical `encodeStateAsUpdate` + identical derived JSON
   (`new src/server/collab/derive.test.ts`-style pure helpers).
2. *JSON/searchText derivation* — ydoc → ProseMirror JSON → `pageSearchText`
   equals the value produced from the same doc via the legacy action path.
3. *Room authz predicate* — pure `decideRoomAccess({ role, guestVisibleIds,
   pageState })` matrix: member/admin/owner/guest-with-permission/
   guest-without/outsider × locked/unlocked × read/write.
4. *Identity injection* — server-side awareness sanitizer drops client-supplied
   `user` fields, keeps cursor/selection.
5. *GC decision* — compaction triggers at >200 updates or >1 MiB.

**Integration (node scripts, extend `scripts/check-collab.mjs`)**

6. Authenticated two-client sync (existing test, now with a session cookie);
   unauthenticated connect asserts close `4401`; foreign-workspace page id
   asserts `4403` (R9.1, R9.2, R9.7).
7. Restart survival (R9.15): type → kill server → restart → assert state.
8. Lock: flip `Page.locked` → assert dropped updates + control frame (R9.4).

**e2e (Playwright, new `e2e/realtime.spec.ts`, serial, dedicated pages)**

9. Two browser contexts, two seeded users, same page: A types, B sees text
   within 2 s; B's caret shows A's name; avatar stack shows 2. Feasibility
   note: requires the built app to have the runtime collab config (R9.21) and
   the collab server running — the spec-file `globalSetup` can spawn it; this
   is the one heavyweight test, keep it to one scenario + the lock scenario.
10. Non-regression: existing editor e2e untouched (collab off in CI build).

**Feasibility verdict**: unit + integration are cheap and cover the risky
logic; the e2e is feasible but flaky-prone — if it proves unstable, the gate
evidence falls back to (6)-(8) plus a single-context e2e asserting the avatar
stack renders for a second presence entry injected via the test hook.

## 10. Migration path (legacy → CRDT persistence)

1. **M1** (presence-only): no persistence change; clients still save JSON
   (D3 remains but N=1 in practice). Security (R9.1-R9.7) lands first — the
   open relay is the worst defect.
2. **M2** (text merge ownership): `PageYDoc`/`PageYUpdate` tables +
   server-side persistence + single-writer projection (R9.8-R9.13, R9.21);
   client save path disabled in collab mode. Existing pages need no import:
   first room load seeds from `Page.content` once (R9.9).
3. **M3** (offline + follow): reconnection UX, discard-on-lock, follow-mode
   (R9.22, R9.24), restore-through-ydoc (R9.14) if not already in M2.

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule from `scripts/LOOP_PLAYBOOK.md` applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Secure the relay + presence identity (~2-3 days)**

- T9.1 [R9.1,R9.2,R9.5,R9.7]: internal authz endpoint + cookie handshake +
  room resolution in `collab-server.mjs`. Red: integration 6.
- T9.2 [R9.3,R9.6]: read-only relay + rate limits. Red: unit 3 + integration 6.
- T9.3 [R9.16,R9.17,R9.18,R9.20]: identity injection + caret/selection
  identity. Red: unit 4; e2e caret assertion.
- T9.4 [R9.19]: topbar avatar stack (a11y-checked). Red: e2e stack render.

**M2 — Durable CRDT + persistence ownership (~3-4 days)**

- T9.5 [R9.8,R9.9,R9.10]: schema + hydrate/seed/snapshot/GC in the server.
  Red: unit 1,5 + integration 7.
- T9.6 [R9.11,R9.12,R9.13]: single-writer projection + throttled versions.
  Red: unit 2.
- T9.7 [R9.4,R9.21]: lock enforcement + control frames + runtime config.
  Red: integration 8.
- T9.8 [R9.23]: fallback path + banner. Red: e2e with server killed.

**M3 — Offline + restore + follow (~3-5 days)**

- T9.9 [R9.14]: restore-through-ydoc (+ fixes `searchText` gap). Red: unit +
  integration.
- T9.10 [R9.22]: offline buffer UX + discard-on-lock. Red: integration.
- T9.11 [R9.24]: follow-mode pill. Red: e2e.

## 12. Risks & open questions (honest)

**Risks**

1. **Permission duplication (highest).** The collab server is a second trust
   boundary; any drift from `guestVisiblePageIds` semantics is a data leak.
   Mitigation: single internal authz endpoint, plus integration tests 6-8
   replaying guest/outsider matrices.
2. **Persistence correctness.** Snapshot debounce + compaction bugs mean lost
   user text — worse than any UI bug. Mitigation: append-only `PageYUpdate`
   between snapshots as a safety net; restart-survival test is a merge gate.
3. **e2e flakiness on `workers:1` serial suites.** Two real browsers + a
   spawned WS server raises median suite time and adds a new failure mode.
   Mitigation: one scenario, generous polling, fallback evidence path (§9).

**Open questions**

- O9.1: Should presence be page-scoped or also workspace-scoped ("who's
  online")? Page-scoped now; awareness channel makes workspace-scoped cheap
  later.
- O9.2: Do database-row pages (they are `Page` rows too, schema
  `prisma/schema.prisma:184-191`) get collab, or only `type = PAGE`? Spec
  assumes PAGE only in M1-M2.
- O9.3: Run the collab server under `tsx` to import shared TS authz directly
  vs. the HTTP internal endpoint (§6). Endpoint recommended (keeps prod deps
  clean, works with the current `.mjs` + `node` start); revisit if the
  deployment story prefers one process.
- O9.4: `PageVersion` attribution under collab — "most recent editor" is a
  heuristic; block-level attribution (matrix row 449) would need Yjs
  `changeOrigin` plumbed into snapshots. Deferred.
- O9.5: Multi-instance collab server (horizontal scale) needs sticky rooms or
  a shared broker — out of scope; single process is the documented topology.
