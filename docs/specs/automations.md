# Spec — Automations & recurring tickets (trigger/condition/action rules)

> **Status: spec complete, implementation pending.** This document is the
> deliverable; no production code was changed.
> Every claim about the current code cites file + line. Requirement IDs
> (`R27.x`) are the traceability anchors: §10 lists milestones 1:1 against them,
> and tests must cite the IDs they cover.

---

## 1. Problem statement

Noema has every ingredient of a rule engine and none of the engine: tickets
already emit an append-only activity stream, labels/assignees/statuses already
change through one server-action layer, a hardened cron endpoint already
exists, and a recurrence helper already computes "next daily/weekly/monthly
run". What is missing is the thing that connects them — a workspace-scoped
**trigger → condition → action** rule object, storage for it, and an execution
path for both *events* and *schedules*.

Concretely today:

- there is **no way** to say "when a ticket becomes `blocked`, slap the
  `escalated` label on it and ping the reporter";
- there is **no recurring ticket** — a weekly triage ticket must be recreated
  by hand, even though database templates already materialise on a schedule;
- operators who want either feature must script against the tickets API
  (`docs/FEATURE_MATRIX.md:733`) from outside the product.

Goal: **Notion-class automations for the ticket domain** — declarative rules
authored by workspace admins, evaluated server-side the moment an activity row
is written, plus schedule-triggered rules that give *recurring tickets* on the
same `daily | weekly | monthly` vocabulary databases already use — delivered on
top of the existing activity/cron/recurrence machinery, not a new framework.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Trigger source (activity log) | `prisma/schema.prisma:744-756` | `TicketActivity { ticketId, actorId, kind String, detail Json?, createdAt }`, `@@index([ticketId, createdAt])`. `actorId` is **required** (`:747`) — no system actor exists. |
| Activity writer | `src/server/actions/tickets.ts:45-54` | `logActivity(ticketId, actorId, kind, detail?)` → `prisma.ticketActivity.create`. Single helper, called from every ticket mutation. |
| Activity kinds emitted | `tickets.ts:225, 313, 364, 369, 398, 430, 443, 483, 524` | `created`, `updated` (+`changes` payload built at `:256-308`), `label_removed`, `label_added`, `relation_added`, `commented`, `archived`/`restored`, `bulk_updated`, `status_changed`. |
| Status change, two encodings | `tickets.ts:264-269` (drawer/API `updateTicketAction`, logged as `updated` w/ `changes.status` at `:313`) vs `tickets.ts:523-524` (board drag `moveTicketAction:490`, logged as `status_changed`) | **Lossy & inconsistent**: `detail` carries `to` only; `from` lives in the pre-read `auth.ticket.status` (`tickets.ts:35`) and is not persisted anywhere. |
| Assignee change | `tickets.ts:301-304` (records `changes.assigneeId`), bulk at `:474,483` | Recorded inside the generic `updated` / `bulk_updated` detail, not as its own kind. |
| Mutation choke point | `src/app/api/tickets/route.ts:20, 69` | The REST API **delegates to the server actions** (`createTicketAction`, …) — UI and API share one code path, so a hook in `tickets.ts` covers both. |
| Rule storage | `prisma/schema.prisma` (all `model` declarations scanned) | **Absent**: no `Automation`, `Schedule`, `Trigger` or `Recurring` model of any kind. |
| Ticket schema | `prisma/schema.prisma:659-703` | `status` (`:667`), `priority`, `dueDate`, `assigneeId` (`:677`), `labels` (`:693`), `activity` (`:697`) — all trigger/condition inputs exist; **no `recurrence`/`nextRunAt`** on tickets. |
| Cron endpoint | `src/app/api/cron/templates/route.ts:14-31` | `POST /api/cron/templates`: **fail-closed** — 503 when `CRON_SECRET` unset (`:17-26`), 401 on `x-cron-secret` mismatch (`:27-28`), `rateLimit(request, "cron", 12, 60_000)` (`:30-31`). `.env.example:49-50` documents it. |
| Cron security check | `scripts/check-share-cron.mjs:42, 55, 57, 65` | Asserts 401/503 when unauthenticated and 401 on a wrong secret. Historical defect `F-03` (failed-open guard) — the posture is deliberate and regression-tested. |
| Cron schedule | repo root (`vercel.json`, `.github/workflows`, `Dockerfile` all absent); `docker-compose.yml:1-22` runs **Postgres only** | No scheduler is configured in-repo; the route header (`route.ts:10-12`) tells operators to point an external scheduler at it. |
| Recurring machinery (databases) | `prisma/schema.prisma:309-324` (`Template.recurrence` `:316`, `Template.nextRunAt` `:317`, `@@index([nextRunAt])` `:323`); `src/lib/recurrence.ts:1-13` (`TemplateRecurrence = "daily" \| "weekly" \| "monthly"`, `nextRunFor`); `src/server/actions/database.ts:567, 583` (`setTemplateRecurrenceAction` sets `nextRunAt: recurrence ? nextRunFor(recurrence) : null`) | **Working** schedule → materialise → advance loop for database templates; UI at `src/components/database/database-view.tsx:32, 120`. Nothing equivalent for tickets. |
| Cron materialisation ordering | `route.ts:67-78` (create row) then `:94-97` (advance `nextRunAt`) | Creates **then** advances, in two separate writes — a crash in between duplicates the next run. Any automation scheduler must not copy this ordering (R27.14). |
| Notification channel | `prisma/schema.prisma:362-373` (`Notification { userId, type, payload Json?, read }`, `@@index([userId, read])`); writes at `src/server/actions/comments.ts:61-68` (`"comment.reply"`) and `:85-92` (`createMany` `"page.mention"`, self excluded at `:81`); inbox at `src/app/w/[slug]/inbox/page.tsx:90` | The **notify action is free** — type + payload convention already exists. |
| Permission model | `src/lib/permissions.ts:10` (`getWorkspaceAccess`), `:44-58` (`WorkspaceAction` union), `:60-67` (`ACTION_GRANTS`; `manageSettings` → OWNER/ADMIN at `:63`), `:81` (`canPerformWorkspaceAction`) | Extensible grant list; precedent for admin-only mutations already enforced in tickets (`tickets.ts:129-135`, label deletion). |
| Test/gate surface | `package.json` `test`, `check:tickets`, `check:coherence` (`scripts/check-coherence.mjs:93` → `COHERENT`); `scripts/check-share-cron.mjs` | Unit + node-check + coherence is the house pattern for this class of feature; no e2e spec for tickets exists yet (`e2e/` has no automations file). |
| Matrix rows | `docs/FEATURE_MATRIX.md:712` (§20 heading), `:740` Automations 🧭, `:746` Recurring tickets 🧭 | Both rows planned; dependents `:73` (button block), `:259` (database buttons), `:262`/`:341` (recurring templates), `:508`/`:509` (automation engine / database automations), `:512` (Zapier), `:705` (scheduler control) all wait on this spec. |

**Assumption check:** "existing recurring template machinery" is
real but **database-only** (`Template`, §above) — nothing on `Ticket`. And the
"label/status change hooks in ticket actions" exist only as *activity
writes*, not as hooks: no code reacts to an activity row after it is written.

### 2.2 What the product class (Notion) does

1. **Rules in the database/page menu** — "When *Status* is *Done* → *set
   property* / *assign* / *send notification* / *add to another database*",
   authored by anyone with full access to that container.
2. **Triggers on property changes** — status, labels/Tags, assignee/Person,
   and due dates; plus **recurring templates** ("repeat every Monday") that
   spawn rows on a schedule.
3. **Run history** — each rule shows when it last ran, on what, and why a run
   was skipped.
4. **Safety rails** — recursion limits, disabled-by-default on import, and
   notifications that never loop back into the rule that produced them.

### 2.3 Gaps this feature must close (D1-D6)

- **D1 — no rule object.** Nothing to author, store, enable or audit; the
  matrix's whole §20/§16 automation cluster (`:73, :259, :508, :509, :712-746`)
  is blocked on it.
- **D2 — events are write-only.** `TicketActivity` is read by the drawer's
  timeline and nothing else; the mutation layer has no post-write dispatch
  point.
- **D3 — lossy, duplicated event shapes.** Status changes arrive as two
  different `kind`s (`updated` w/ `changes.status` vs `status_changed`) and
  neither persists the previous value (§2.1) — a rule like "when status
  *becomes* X" cannot be evaluated from `detail` alone.
- **D4 — no schedule leg for tickets.** `Ticket` has no `nextRunAt`; the only
  cron route materialises database templates.
- **D5 — no scheduler in the deployment.** Even the existing cron route is
  driven by an operator's external scheduler; recurring tickets must inherit
  that operational story honestly, not pretend a scheduler exists.
- **D6 — no loop/recursion policy.** Once actions write activity rows, a naive
  dispatcher turns "add label → fires rule → add label" into an infinite loop.

## 3. Decision: one engine, two legs

| Option | Fit | Verdict |
| --- | --- | --- |
| **Single `Automation` table with `trigger = schedule` leg** — recurring tickets are a schedule-triggered rule whose action is `create_ticket`; `nextRunAt`/`nextRunFor` reused from `src/lib/recurrence.ts`. | One authoring surface, one permission model, one cron guard, one run log; recurring tickets get conditions and auditability for free. | **Chosen.** |
| `Ticket.recurrence` column + clone-the-row logic (copy of `Template`) | Mirrors `Template` literally, but duplicates `nextRunFor` wiring, has no conditions, no notify, no audit trail, and needs a *second* cron path for a *first* class feature. | Rejected — second scheduler for no gain. |
| Build on an external queue/workflow product (Zapier-style, matrix `:512`) | Solves execution but adds infra the repo does not have (`docker-compose.yml` runs Postgres only) and is a connector story, not a parity story. | Rejected for M1-M3; `:512` stays 🧭. |

**Decision:** a workspace-scoped `Automation` row = `trigger + conditions +
actions`, evaluated **event-driven** (dispatcher called after `logActivity`
in `src/server/actions/tickets.ts`) and **on schedule** (a sibling cron route
sharing the proven `CRON_SECRET` fail-closed guard). Conditions are a small,
whitelisted, bounded DSL evaluated by a pure function in `src/lib/` (the
house sandbox rule). Actions are four: **set labels, assign, notify, create
ticket**.

## 4. Requirements (numbered, testable)

### Triggers & event normalization

- **R27.1** — The engine consumes exactly five canonical events:
  `ticket.status_changed`, `ticket.label_added`, `ticket.label_removed`,
  `ticket.assigned`, `schedule`. No rule may bind to a raw `kind` string.
  - *Acceptance:* unit test maps every raw kind emitted by `tickets.ts`
    (`created, updated, label_added, label_removed, relation_added, commented,
    archived, restored, bulk_updated, status_changed`) to a canonical event or
    to `null` (ignored) — no raw kind reaches rule evaluation.
- **R27.2** — Every mutation path in `src/server/actions/tickets.ts`
  (`createTicketAction`, `updateTicketAction`, `toggleTicketLabelAction`,
  `bulkUpdateTicketsAction`, `moveTicketAction`, plus archive) calls
  `dispatchTicketEvents(...)` **after** its `logActivity` write and after the
  row update, inside the same request. Because `src/app/api/tickets/route.ts:20,
  69` delegates to these actions, the REST API inherits the dispatch.
  - *Acceptance:* integration test drives each of those actions and asserts
    exactly one dispatcher invocation per user-visible change; the tickets API
    round-trip fires the same event (cite `route.ts:69`).
- **R27.3** — Canonical events carry `{ workspaceId, ticketId, actorId,
  field, from, to }`. Each call site supplies the pre-change snapshot
  (`auth.ticket.status` from `tickets.ts:35`, `changes.*` from `:256-308`) so
  both status encodings — `updated` w/ `changes.status` (`:313`) and
  `status_changed` (`:524`) — produce the *same* event with a populated `from`.
  Bulk updates (`:483`) supply per-ticket `from` values captured in the loop.
  - *Acceptance:* red unit test: a status change through `updateTicketAction`
    and the same change through `moveTicketAction` yield byte-identical
    canonical events (except ids/timestamps).
- **R27.4** — Activity rows written **by** an automation are stamped
  `detail.automationId` (+ `automationName`) so the timeline can attribute
  them, while `actorId` remains the rule's author (required by
  `prisma/schema.prisma:747` — no system user exists).
  - *Acceptance:* after a rule fires, the ticket's activity list shows an
    automation-attributed row; the author id is unchanged from
    `Automation.createdById`.

### Condition DSL (scoped)

- **R27.5** — Conditions are a JSON tree `{ all: [...] } | { any: [...] } |
  { predicate, args }` with predicates whitelisted to: `status_in`,
  `status_changed_to`, `has_all_labels`, `has_any_label`, `has_no_labels`,
  `assignee_is`, `assignee_is_not`, `priority_in`, `type_in`, `project_in`,
  `is_archived`. Depth ≤ 2, ≤ 8 leaves. No regular expressions, no field
  access outside the ticket, no user-supplied code — a rule with an unknown
  predicate or oversize tree **fails closed**: skipped, logged as
  `AutomationRun.status = "skipped"`.
  - *Acceptance:* unit matrix over predicate × {true,false,missing-field};
    a depth-3 tree and an unknown predicate both produce `skipped`, never a
    throw that reaches the user action.
- **R27.6** — Evaluation is a pure function
  `evaluateConditions(rules, event, ticketSnapshot)` in `src/lib/automations.ts`
  (no I/O, no clock, no prisma) — the lib *is* the sandbox.
  - *Acceptance:* vitest covers the DSL with no DB; property-style test:
    evaluating twice with the same inputs returns the same result.

### Actions

- **R27.7** — `set_labels` (`mode: add | remove | replace`, `labelIds[]`) —
  writes the same `TicketLabel` rows and `label_added`/`label_removed`
  activity as `toggleTicketLabelAction` (`tickets.ts:358-369`), including the
  automation stamp (R27.4). Labels must belong to the rule's workspace
  (`tickets.ts:354` semantics).
  - *Acceptance:* firing a rule adds exactly the configured labels; a
    foreign-workspace label id is rejected and logged as a failed run.
- **R27.8** — `assign` — sets `Ticket.assigneeId` to a configured workspace
  member or clears it; non-members are rejected before any write.
  - *Acceptance:* assign to a member succeeds and emits a `ticket.assigned`
    canonical event **marked as automation-originated** (see R27.13 chain
    rule); assign to an outsider fails the run, not the user action.
- **R27.9** — `notify` — creates `Notification` rows (`type:
  "automation.notify"`, `payload: { automationId, ticketId }`) for an explicit
  target set: individual members, `assignee`, `reporter`, or workspace
  admins. Self-notification of the triggering actor follows
  `comments.ts:81` (actor excluded).
  - *Acceptance:* N targets → N rows, inbox (`src/app/w/[slug]/inbox/page.tsx`)
    renders them; triggering user in the target set receives none.
- **R27.10** — `create_ticket` — creates a ticket in a configured project of
  the rule's workspace with templated `title` (supports `{{ticket.key}}`,
  `{{ticket.title}}` interpolation), `status`, `priority`, `labels`,
  optional `assigneeId`, and — when configured — a `TicketRelation` back to
  the source ticket (`tickets.ts:375-401` semantics). The new ticket's
  `reporterId`/`createdById` is the rule author, never the triggering user.
  - *Acceptance:* schedule-triggered create yields a real `Ticket` with the
    interpolated title and the back-relation; creating inside a deleted/
    trashed project fails the run without touching the source ticket.
- **R27.11** — Actions run **in order**, ≤ 5 per rule; the first failure
  stops the run, persists `AutomationRun.status = "failed"` with the error
  string, and **never** propagates to the user's action (the ticket edit that
  triggered it has already succeeded).
  - *Acceptance:* red test: an action that throws leaves the triggering
    mutation's response `ok: true` while the run row records `failed`.

### Schedule leg & cron integration

- **R27.12** — Schedule triggers store `recurrence: "daily" | "weekly" |
  "monthly"` and `nextRunAt`, computed with `nextRunFor` from
  `src/lib/recurrence.ts:4-13` — the same cadence vocabulary as database
  templates (`database.ts:583`), so both feature areas behave identically.
  - *Acceptance:* unit tests for `nextRunFor`-driven scheduling: a rule set at
    T with `weekly` has `nextRunAt ≈ T+7d`, and after a run it advances again.
- **R27.13** — Scheduled automations are executed by **`POST
  /api/cron/automations`**, a sibling of `/api/cron/templates`, built on a
  shared `requireCronSecret(request)` helper extracted from
  `route.ts:15-31`: **503** when `CRON_SECRET` is unset, **401** on a wrong
  `x-cron-secret`, then the same `rateLimit(request, "cron", 12, 60_000)`.
  `/api/cron/templates` keeps its current behaviour byte-for-byte (matrix row
  `:734` must stay true).
  - *Acceptance:* `scripts/check-share-cron.mjs` gains a third section
    asserting 503/401/401-again for `/api/cron/automations`; the templates
    section's existing assertions still pass untouched.
- **R27.14** — Each due run advances `nextRunAt` **in the same transaction**
  that performs the run's side effects (at-most-once materialisation) —
  explicitly *not* the create-then-update ordering of `route.ts:67-78` +
  `:94-97`.
  - *Acceptance:* kill-the-process test at the transaction boundary: a
    re-run of the cron endpoint creates **zero** duplicate tickets, whereas a
    reproduction against the documented `Template` ordering shows the
    duplicate (cited as the motivating gap, not fixed here).
- **R27.15** — A **recurring ticket** is exactly a rule with
  `trigger = schedule` and one `create_ticket` action; the settings UI
  exposes it under "Recurring tickets" but stores an ordinary `Automation`
  row (no second table, no `Ticket.recurrence` column).
  - *Acceptance:* creating a recurring ticket from the UI produces a row with
    `trigger = "schedule"` that the cron endpoint materialises on cadence;
    disabling it stops materialisation on the next tick.

### Storage, execution & safety

- **R27.16** — New tables: `Automation { id, workspaceId, name, enabled,
  trigger, triggerConfig Json?, conditions Json?, actions Json, nextRunAt
  DateTime?, lastRunAt DateTime?, createdById, createdAt, updatedAt }` with
  `@@index([workspaceId, enabled])` and `@@index([nextRunAt])`, and
  `AutomationRun { id, automationId, ticketId?, event Json?, status
  ("ok" | "skipped" | "failed"), error String?, createdAt }` with
  `@@index([automationId, createdAt])`. `actions`/`conditions` are validated
  on write (R27.5 bounds), not on read.
  - *Acceptance:* `prisma db push` is a clean forward migration (Tier HEAVY
    change); a rule persisted with a depth-3 condition is rejected at authoring
    time by the same validator the evaluator uses.
- **R27.17** — **Loop guard:** activity produced by an automation never
  re-triggers automation evaluation (depth ≥ 1 is skipped), and any single
  `(automation, ticket)` pair fires at most once per 60 s.
  - *Acceptance:* red test: rule A adds label L, rule B fires on L and adds
    label M, rule C fires on M — the chain stops after B's own action; no
    unbounded growth (assert run count ≤ 2).
- **R27.18** — Event-driven execution is **bounded**: ≤ 10 candidate rules per
    event (ordered by `createdAt` for determinism), ≤ 250 ms budget, evaluated
    synchronously in the request. Because the repo has no queue
    (`docker-compose.yml` = Postgres only), slow/failed runs are recorded and
    surfaced rather than retried in-process.
  - *Acceptance:* a rule whose evaluation is artificially slowed past budget
    is abandoned with `AutomationRun.status = "failed"` while the triggering
    action still returns success; ordering test proves deterministic rule
    selection.

### Permissions & administration

- **R27.19** — Authoring (create/update/delete/enable/disable) requires a new
  `WorkspaceAction` `"manageAutomations"` granted to `OWNER` and `ADMIN` in
  `ACTION_GRANTS` (`permissions.ts:60-67`, mirroring `manageSettings` at
  `:63`) and checked via `canPerformWorkspaceAction` (`:81`). Members may
  read the list from M2 onward; execution is server-side and never trusts a
  client-supplied rule id.
  - *Acceptance:* MEMBER session → authoring action returns the admin-only
    error (pattern: `tickets.ts:135`); OWNER/ADMIN succeeds; a rule id from
    workspace A can never mutate a ticket of workspace B (cross-tenant test).
- **R27.20** — Disabled rules (`enabled = false`) are excluded before
  evaluation (index-backed filter), and toggling is an auditable action
  recorded on the workspace activity stream (`src/lib/activity.ts:34`
  precedent).
  - *Acceptance:* disabling a rule stops its firing on the very next event;
    re-enabling resumes without re-running missed events.

### Non-goals (this spec)

- No external connectors/webhooks (matrix `:512` stays 🧭); no arbitrary
  code, expressions or regex in conditions; no page/block/database-row
  automations (`:508`, `:509`, `:73`, `:259` — this spec covers the **ticket**
  domain and the shared engine only); no sub-minute or custom-cron cadence in
  M1-M2 (daily/weekly/monthly only); no cross-workspace rules; no replay of
  historical events when a rule is created.

## 5. Data model

```prisma
model Automation {
  id            String    @id @default(cuid())
  workspaceId   String
  name          String
  enabled       Boolean   @default(true)
  trigger       String    // status_changed | label_added | label_removed | assigned | schedule
  triggerConfig Json?     // { field?, value? | labelIds[] | recurrence }
  conditions    Json?     // scoped DSL (R27.5); null = always run
  actions       Json      // ordered[], ≤ 5 (R27.11)
  nextRunAt     DateTime? // schedule trigger only
  lastRunAt     DateTime?
  createdById   String
  createdAt     DateTime  @default(default)
  updatedAt     DateTime  @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  runs      AutomationRun[]

  @@index([workspaceId, enabled])
  @@index([nextRunAt])
}

model AutomationRun {
  id           String   @id @default(cuid())
  automationId String
  ticketId     String?
  event        Json?
  status       String   // ok | skipped | failed
  error        String?
  createdAt    DateTime @default(now())

  automation Automation @relation(fields: [automationId], references: [id], onDelete: Cascade)

  @@index([automationId, createdAt])
}
```

`Ticket` (`prisma/schema.prisma:659-703`) is **unchanged** — recurring tickets
store their schedule on `Automation.nextRunAt`, not on the ticket (§3). No
change to `TicketActivity` either: `detail Json?` (`:749`) already carries the
automation stamp.

## 6. Execution: event-driven + cron

```
UI / REST (route.ts:69)
   └─ server action (tickets.ts) ── update rows ── logActivity (:45-54)
                                                   └─ dispatchTicketEvents  [R27.2]
                                                        ├─ normalize → canonical event [R27.1, R27.3]
                                                        ├─ SELECT Automation WHERE workspaceId AND enabled AND trigger = event
                                                        ├─ evaluateConditions (pure, src/lib/automations.ts) [R27.5-6]
                                                        ├─ run actions ≤5, ≤250 ms, depth-guarded [R27.11, R27.17-18]
                                                        └─ insert AutomationRun (ok | skipped | failed)

external scheduler (operator-configured; none in-repo — §2.1 D5)
   └─ POST /api/cron/automations  ── requireCronSecret (503/401 + rate limit) [R27.13]
                                    ├─ SELECT Automation WHERE trigger = 'schedule' AND nextRunAt <= now
                                    ├─ transaction: run actions + advance nextRunAt [R27.14]
                                    └─ { due, created, failed }
```

Design consequences worth stating plainly:

1. **Dispatch sits after `logActivity`, not inside the transaction** — a rule
   must see the *new* state; the activity row is the audit anchor, the
   canonical event is the contract.
2. **`from` must be supplied by the caller** (D3): `detail` alone is lossy,
   and re-reading the ticket post-update cannot recover the previous value.
3. **Synchronous + bounded, no queue** (R27.18) is a deliberate M1-M2
   compromise; a durable queue is an M3+/ops question (O27.3).
4. **Cron is fail-closed by construction** — the guard is extracted from the
   one endpoint that already has a regression test
   (`scripts/check-share-cron.mjs:55-65`), so automations inherit the posture
   instead of re-deriving it.

## 7. Authoring UI spec (M2 surface)

- **Settings → Automations** (workspace settings, admin-gated): list with
  trigger summary, enabled toggle, last run, *Run history* drawer (last 20
  `AutomationRun` rows with status/error).
- **Create/edit form**: name → trigger picker (status/label/assignee change,
  schedule) → optional condition builder (only whitelisted predicates render)
  → action list (4 types, reorderable, max 5) → save (validator = evaluator's
  parser, R27.16).
- **Recurring ticket shortcut**: *New → Recurring ticket* in the tracker
  pre-fills trigger `schedule` + single `create_ticket` action (R27.15);
  it is not a separate feature object.
- Attribution: automation-written activity renders "via *rule name*" in the
  ticket timeline (R27.4), and notifications deep-link to the ticket
  (`Notification.payload`, `prisma/schema.prisma:366`).
- All copy through `src/lib/i18n.ts` (ratchet: no new untranslated strings —
  `check:coherence` baseline `i18nFiles: 71` may only grow).

## 8. Edge & safety spec

| Edge | Behaviour |
| --- | --- |
| Rule fires on its own output (label → label) | Depth guard stops it (R27.17); run logged `skipped`. |
| Bulk update across 50 tickets (`tickets.ts:449-486`) | One dispatch per ticket, each with its own `from`; the 10-rule/250 ms budget applies **per ticket**, so a pathological bulk is capped by the bulk action's own size limit — documented, not silently dropped. |
| Archived/soft-deleted ticket | Archived tickets still evaluate (archival is itself a signal); rules targeting trashed **projects** fail the run (R27.10). |
| `CRON_SECRET` unset in deployment | `/api/cron/automations` returns 503 and never materialises — recurring tickets simply do not run; ops note in `.env.example` alongside `:49-50`. |
| No scheduler configured at all | Same as today's database templates: feature is idle until an operator points a scheduler at it (D5, honest limitation, documented in §11). |
| Rule references a deleted label/member | Run fails with a recorded error; the rule is **not** auto-disabled (visible in run history instead). |
| Clock/timezone | `nextRunFor` (`recurrence.ts:8-12`) mutates local time; automations compute `nextRunAt` in the server's timezone exactly like templates do. DST drift is documented, not silently "fixed" (O27.2). |
| Two rules touch the same ticket | Deterministic `createdAt` order (R27.18); second rule sees the first rule's writes only through its own trigger (marked automation-originated, R27.17). |
| Notification storm | `notify` is capped at 50 rows per run; overflow logs `failed` rather than paging a whole workspace. |

## 9. Test plan

**Unit (vitest, red-first)**

1. *Canonical-event normalization* — table test over all raw `kind`s incl.
   both status encodings and `bulk_updated` detail shapes (R27.1, R27.3).
2. *Condition DSL* — predicate matrix × {true, false, missing field} +
   depth/leaf bounds and unknown-predicate fail-closed (R27.5, R27.6).
3. *Action planner* — ordered ≤5, first-failure short-circuit, template
   interpolation `{{ticket.key}}` (R27.10, R27.11).
4. *Loop guard* — A→B→C chain terminates; 60 s per-pair cooldown (R27.17).
5. *Scheduling* — `nextRunAt` derivation/advance via `nextRunFor`
   (R27.12), plus transaction-boundary at-most-once logic (R27.14).
6. *Permission gate* — `manageAutomations` grant matrix OWNER/ADMIN/MEMBER
   against `ACTION_GRANTS` (R27.19).

**Integration (node script, house pattern `scripts/check-*.mjs`)**

7. New `scripts/check-automations.mjs`: seed a rule → mutate a ticket through
   `updateTicketAction` → assert label/notify/create side effects + run row
   (R27.2, R27.7-R27.9).
8. `scripts/check-share-cron.mjs` extended with `/api/cron/automations`
   503/401/wrong-secret sections (R27.13) — existing sections untouched.
9. Non-regression: `npm run check:tickets` still green (activity log rows are
   additive).

**e2e (Playwright, new `e2e/automations.spec.ts`, dedicated projects)**

10. Admin creates a status-change rule in Settings, member is refused the same
    form, board drag fires the rule and the timeline shows the
    automation-attributed row (R27.19, R27.4).
11. Recurring ticket: create weekly rule → cron endpoint called with a test
    secret → new ticket appears in the tracker (R27.15, R27.14).

**Feasibility verdict**: unit + `check-automations.mjs` cover the risky logic
cheaply and match how this codebase already proves ticket features; e2e 10-11
are UI-surface only (two specs, dedicated fixtures).

## 10. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Engine + event leg (status/label/assignee) (~3-4 days, schema = Tier HEAVY)**

- T27.1 [R27.16]: `Automation` + `AutomationRun` models, `prisma db push`
  (a build-serialized HEAVY change), validator shared by authoring + evaluator.
  Red: unit 2 rejects oversize trees.
- T27.2 [R27.1, R27.3]: canonical-event normalizer in `src/lib/automations.ts`.
  Red: unit 1.
- T27.3 [R27.2, R27.4]: `dispatchTicketEvents` wired after every `logActivity`
  in `tickets.ts` (+ `from` capture at each call site). Red: integration 7.
- T27.4 [R27.5, R27.6]: condition evaluator (pure). Red: unit 2.
- T27.5 [R27.7, R27.9]: `set_labels` + `notify` actions, `AutomationRun`
  writes, loop guard. Red: units 4 + integration 7.
- T27.6 [R27.19, R27.20]: `manageAutomations` grant + enable/disable.
  Red: unit 6.

**M2 — Actions, schedule leg & UI (~4-5 days)**

- T27.7 [R27.8, R27.10]: `assign` + `create_ticket` actions with templating
  and back-relation. Red: unit 3.
- T27.8 [R27.12, R27.14]: schedule storage + transactional run/advance.
  Red: units 5 + R27.14 boundary test.
- T27.9 [R27.13]: `requireCronSecret` extraction, `/api/cron/automations`,
  `check-share-cron.mjs` extension. Red: integration 8.
- T27.10 [R27.15, §7]: Settings UI (list/create/toggle/history) + recurring
  ticket shortcut, i18n strings. Red: e2e 10-11.

**M3 — Hardening & reach (~2-3 days, may slip)**

- T27.11 [R27.18]: budget instrumentation + deterministic selection surfaced
  in run history; worst-case bulk test.
- T27.12 [O27.1]: due-date/`priority`-change triggers if the DSL demand is
  real (today's predicates already cover the matrix rows `:740`/`:746`).
- T27.13 [§4 non-goals]: groundwork note only — generalising the engine to
  database/page rows (`:508`, `:509`) and connectors (`:512`) stays out of
  scope until this spec's ticket domain is green.

## 11. Risks & open questions (honest)

**Risks**

1. **Synchronous execution in the user's request** (R27.18). A slow rule
   slows every ticket edit; no queue exists to fall back on. Mitigation:
   hard budget + `failed` run rows + ≤10 candidate rules; if real workloads
   exceed it, the fix is a durable queue (O27.3), not a bigger budget.
2. **Loop/recursion bugs are silent until they aren't** (D6). Mitigation:
   depth guard + per-pair cooldown tested red-first (unit 4), automation
   stamps on every derived activity row (R27.4) so a runaway is diagnosable
   from the timeline alone.
3. **Cron inheritance means cron's operational gap becomes ours** (D5). The
   endpoint is fail-closed and tested, but nothing in-repo calls it —
   recurring tickets will "not work" on a deployment with no external
   scheduler, exactly like database templates do today. Mitigation: state it
   in `.env.example` and the settings UI ("waiting for first scheduler
   ping"), rather than pretending a scheduler exists.
4. **Lossy history for `from`** (D3). Rules that need the previous value
   depend on call sites supplying it correctly; a missed call site silently
   produces events with `from: null`. Mitigation: normalization unit test
   treats `from: null` as a hard failure for change-triggers.

**Open questions**

- O27.1: Should `ticket.assigned` be split from `updated.changes.assigneeId`
  at the *writer* (a dedicated `kind`) instead of normalized in the engine?
  Normalization (chosen) avoids touching the already-shipped activity log; a
  dedicated kind would be cleaner but changes the timeline's vocabulary
  (`docs/FEATURE_MATRIX.md:729`).
- O27.2: Timezone policy for schedules — `nextRunFor` is local-time naive
  (`recurrence.ts:8-12`). UTC-per-workspace would be more correct for a
  self-hosted multi-region install but would diverge from database templates.
  Keep parity now; revisit with a workspace timezone setting.
- O27.3: Durable queue (Postgres-backed jobs) vs. keeping the synchronous
  budget — decide after M2 telemetry from `AutomationRun`.
- O27.4: Should members (not just admins) author rules for projects they
  own, à la Notion's "full access"? `manageAutomations` is workspace-wide
  today; project-scoped grants would need a finer permission axis than
  `WorkspaceAction` provides.
